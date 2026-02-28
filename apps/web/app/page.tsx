"use client";

import { useEffect, useRef, useState } from "react";
import {
  getWsBase,
  apiFetch,
  type AiSettingsUpdate,
  type AiSettingsView,
  type ApiMeetingNote,
  type ApiTask
} from "../lib/api";
import { decryptAudioData, deriveAesKey, encryptAudioData } from "../lib/crypto";
import {
  attachServerRecordingId,
  getRecording,
  listRecordings,
  listMeetingNotesCacheByDate,
  listTranscriptCacheByDate,
  removeRecording,
  saveMeetingNotesCache,
  saveRecording,
  saveTranscriptCache,
  type RecordingBlob
} from "../lib/db";

type Transcript = {
  id: string;
  recording_id: string;
  text: string;
  created_at: string;
};

type DailySummaryResponse = {
  id: string;
  report_md: string;
  tasks_json: Array<{
    title: string;
    priority: "low" | "medium" | "high";
    due_date?: string | null;
    estimate_min?: number | null;
    context?: string | null;
  }>;
} | null;

type RecordingMode = "upload" | "realtime";

type UploadAndTranscribeOptions = {
  realtimeSessionId?: string;
  realtimeError?: string;
};
const LONG_AUDIO_THRESHOLD_MS = 5 * 60 * 1000;

function appendLine(previous: string, line: string): string {
  const text = line.trim();
  if (!text) return previous;
  if (!previous) return text;
  if (previous.endsWith(text)) return previous;
  return `${previous}\n${text}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function modelContainsRealtime(value: string | null | undefined): boolean {
  return (value ?? "").toLowerCase().includes("realtime");
}

export default function HomePage() {
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [passcode, setPasscode] = useState("");
  const [cryptoKey, setCryptoKey] = useState<CryptoKey | null>(null);
  const [recordings, setRecordings] = useState<RecordingBlob[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState("就绪");
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [meetingNotes, setMeetingNotes] = useState<ApiMeetingNote[]>([]);
  const [summary, setSummary] = useState<DailySummaryResponse>(null);
  const [tasks, setTasks] = useState<ApiTask[]>([]);
  const [dailyDataFromCache, setDailyDataFromCache] = useState(false);
  const [recordMode, setRecordMode] = useState<RecordingMode>("upload");
  const [realtimeSessionId, setRealtimeSessionId] = useState<string | null>(null);
  const [realtimeInterimText, setRealtimeInterimText] = useState("");
  const [realtimeFinalText, setRealtimeFinalText] = useState("");
  const [aiSettings, setAiSettings] = useState<AiSettingsView | null>(null);
  const [sttProvider, setSttProvider] = useState<"openai" | "openrouter" | "seed-asr" | "qwen3-asr">(
    "openai"
  );
  const [sttFileModel, setSttFileModel] = useState("gpt-4o-mini-transcribe");
  const [sttRealtimeModel, setSttRealtimeModel] = useState("qwen3-asr-flash-realtime");
  const [sttApiKey, setSttApiKey] = useState("");
  const [analysisProvider, setAnalysisProvider] = useState<"openai" | "openrouter">("openai");
  const [analysisModel, setAnalysisModel] = useState("gpt-4.1-mini");
  const [analysisApiKey, setAnalysisApiKey] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startedAtRef = useRef<number>(0);
  const realtimeSocketRef = useRef<WebSocket | null>(null);
  const realtimeSessionIdRef = useRef<string | null>(null);
  const realtimeFallbackRef = useRef(false);
  const realtimeStoppingRef = useRef(false);

  const loadLocalRecordings = async () => {
    const rows = await listRecordings();
    setRecordings(rows);
  };

  const loadDailyData = async () => {
    if (!token) return;
    try {
      const [transcriptRows, summaryRow, taskRows, meetingNoteRows] = await Promise.all([
        apiFetch<Transcript[]>(`/transcripts?date=${selectedDate}`, {}, token),
        apiFetch<DailySummaryResponse>(`/daily-summaries?date=${selectedDate}`, {}, token),
        apiFetch<ApiTask[]>(`/tasks?date=${selectedDate}`, {}, token),
        apiFetch<ApiMeetingNote[]>(`/meeting-notes?date=${selectedDate}`, {}, token)
      ]);
      setTranscripts(transcriptRows);
      setSummary(summaryRow);
      setTasks(taskRows);
      setMeetingNotes(meetingNoteRows);
      setDailyDataFromCache(false);
      await saveTranscriptCache(
        transcriptRows.map((item) => ({
          ...item,
          cache_date: selectedDate
        }))
      );
      await saveMeetingNotesCache(meetingNoteRows);
    } catch (error) {
      const [transcriptCacheRows, meetingNoteCacheRows] = await Promise.all([
        listTranscriptCacheByDate(selectedDate),
        listMeetingNotesCacheByDate(selectedDate)
      ]);
      setTranscripts(
        transcriptCacheRows.map((item) => ({
          id: item.id,
          recording_id: item.recording_id,
          text: item.text,
          created_at: item.created_at
        }))
      );
      setMeetingNotes(meetingNoteCacheRows as ApiMeetingNote[]);
      setSummary(null);
      setTasks([]);
      setDailyDataFromCache(true);
      setStatus(`加载云端数据失败，已回退本地缓存：${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  const loadAiSettings = async () => {
    if (!token) return;
    try {
      const settings = await apiFetch<AiSettingsView>("/settings/ai", {}, token);
      const resolvedSttFileModel =
        settings.stt_file_model || (settings as unknown as { stt_model?: string }).stt_model || "gpt-4o-mini-transcribe";
      const resolvedSttRealtimeModel = settings.stt_realtime_model || "qwen3-asr-flash-realtime";
      setAiSettings({
        ...settings,
        stt_file_model: resolvedSttFileModel,
        stt_realtime_model: resolvedSttRealtimeModel
      });
      setSttProvider(settings.stt_provider);
      setSttFileModel(resolvedSttFileModel);
      setSttRealtimeModel(resolvedSttRealtimeModel);
      setAnalysisProvider(settings.analysis_provider);
      setAnalysisModel(settings.analysis_model);
      setSttApiKey("");
      setAnalysisApiKey("");
    } catch (error) {
      setStatus(`加载模型设置失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  const syncUserTimezone = async () => {
    if (!token) return;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz) return;
    try {
      await apiFetch(
        "/users/me/timezone",
        { method: "PUT", body: JSON.stringify({ tz }) },
        token
      );
    } catch {
    }
  };

  useEffect(() => {
    void loadLocalRecordings();
  }, []);

  useEffect(() => {
    if (token) {
      void loadDailyData();
    }
  }, [token, selectedDate]);

  useEffect(() => {
    if (token) {
      void loadAiSettings();
      void syncUserTimezone();
    }
  }, [token]);

  useEffect(() => {
    return () => {
      try {
        recorderRef.current?.stop();
      } catch {
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      recorderRef.current = null;
      realtimeSocketRef.current?.close();
      realtimeSocketRef.current = null;
    };
  }, []);

  const handleInitPasscode = async () => {
    if (passcode.length < 6) {
      setStatus("口令至少 6 位");
      return;
    }
    const key = await deriveAesKey(passcode);
    setCryptoKey(key);
    setStatus("本地加密密钥已准备");
  };

  const persistLocalRecording = async (
    blob: Blob,
    mimeType: string,
    durationMs: number,
    titlePrefix = "录音"
  ): Promise<RecordingBlob> => {
    if (!cryptoKey) {
      throw new Error("本地加密密钥未初始化");
    }
    const arrayBuffer = await blob.arrayBuffer();
    const encrypted = await encryptAudioData(arrayBuffer, cryptoKey);
    const localRow: RecordingBlob = {
      id: crypto.randomUUID(),
      title: `${titlePrefix} ${new Date().toLocaleString()}`,
      createdAt: new Date().toISOString(),
      durationMs,
      mimeType,
      encryptedAudio: encrypted.encrypted,
      iv: encrypted.iv
    };
    await saveRecording(localRow);
    await loadLocalRecordings();
    return localRow;
  };

  const markRealtimeFallback = async (
    sessionId: string,
    errorMessage: string,
    fallbackRecordingId?: string
  ) => {
    if (!token) return;
    try {
      await apiFetch(
        `/realtime/sessions/${sessionId}/fallback`,
        {
          method: "POST",
          body: JSON.stringify({
            error: errorMessage,
            fallback_recording_id: fallbackRecordingId ?? null
          })
        },
        token
      );
    } catch {
    }
  };

  const triggerRealtimeFallback = async (errorMessage: string) => {
    const sessionId = realtimeSessionIdRef.current;
    if (!sessionId || realtimeFallbackRef.current) {
      return;
    }
    realtimeFallbackRef.current = true;
    setStatus(`实时链路异常，自动回退上传转写：${errorMessage}`);
    await markRealtimeFallback(sessionId, errorMessage);
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
  };

  const login = async () => {
    try {
      const response = await apiFetch<{ access_token: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      setToken(response.access_token);
      setStatus("已登录");
    } catch (error) {
      setStatus(`登录失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  const saveAiSettings = async () => {
    if (!token) return;
    try {
      if (modelContainsRealtime(sttFileModel)) {
        setStatus("STT 文件模型不能是 realtime，请填写非 realtime 模型（如 qwen3-asr-flash）。");
        return;
      }
      if (!modelContainsRealtime(sttRealtimeModel)) {
        setStatus("STT 实时模型必须包含 realtime，请填写例如 qwen3-asr-flash-realtime。");
        return;
      }
      const payload: AiSettingsUpdate = {
        stt_provider: sttProvider,
        stt_file_model: sttFileModel,
        stt_realtime_model: sttRealtimeModel,
        analysis_provider: analysisProvider,
        analysis_model: analysisModel
      };
      if (sttApiKey.trim()) {
        payload.stt_api_key = sttApiKey.trim();
      }
      if (analysisApiKey.trim()) {
        payload.analysis_api_key = analysisApiKey.trim();
      }
      const updated = await apiFetch<AiSettingsView>(
        "/settings/ai",
        { method: "PUT", body: JSON.stringify(payload) },
        token
      );
      setAiSettings(updated);
      setSttApiKey("");
      setAnalysisApiKey("");
      setStatus("模型设置已保存");
    } catch (error) {
      setStatus(`保存模型设置失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  const saveSttSettings = async () => {
    if (!token) return;
    try {
      if (modelContainsRealtime(sttFileModel)) {
        setStatus("STT 文件模型不能是 realtime，请填写非 realtime 模型（如 qwen3-asr-flash）。");
        return;
      }
      if (!modelContainsRealtime(sttRealtimeModel)) {
        setStatus("STT 实时模型必须包含 realtime，请填写例如 qwen3-asr-flash-realtime。");
        return;
      }
      const payload: AiSettingsUpdate = {
        stt_provider: sttProvider,
        stt_file_model: sttFileModel,
        stt_realtime_model: sttRealtimeModel
      };
      if (sttApiKey.trim()) {
        payload.stt_api_key = sttApiKey.trim();
      }
      const updated = await apiFetch<AiSettingsView>(
        "/settings/ai",
        { method: "PUT", body: JSON.stringify(payload) },
        token
      );
      setAiSettings(updated);
      setSttApiKey("");
      setStatus("STT 设置已保存");
    } catch (error) {
      setStatus(`保存 STT 设置失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  const saveAnalysisSettings = async () => {
    if (!token) return;
    try {
      const payload: AiSettingsUpdate = {
        analysis_provider: analysisProvider,
        analysis_model: analysisModel
      };
      if (analysisApiKey.trim()) {
        payload.analysis_api_key = analysisApiKey.trim();
      }
      const updated = await apiFetch<AiSettingsView>(
        "/settings/ai",
        { method: "PUT", body: JSON.stringify(payload) },
        token
      );
      setAiSettings(updated);
      setAnalysisApiKey("");
      setStatus("分析模型设置已保存");
    } catch (error) {
      setStatus(`保存分析模型设置失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  const clearSttKey = async () => {
    if (!token) return;
    const updated = await apiFetch<AiSettingsView>(
      "/settings/ai",
      { method: "PUT", body: JSON.stringify({ clear_stt_api_key: true }) },
      token
    );
    setAiSettings(updated);
    setSttApiKey("");
    setStatus("已清空 STT Key");
  };

  const clearAnalysisKey = async () => {
    if (!token) return;
    const updated = await apiFetch<AiSettingsView>(
      "/settings/ai",
      { method: "PUT", body: JSON.stringify({ clear_analysis_api_key: true }) },
      token
    );
    setAiSettings(updated);
    setAnalysisApiKey("");
    setStatus("已清空分析 Key");
  };

  const testStt = async () => {
    if (!token) return;
    try {
      if (modelContainsRealtime(sttFileModel)) {
        setStatus("STT 文件模型不能是 realtime，请填写非 realtime 模型后再测试。");
        return;
      }
      const payload: AiSettingsUpdate = {
        stt_provider: sttProvider,
        stt_file_model: sttFileModel
      };
      if (sttApiKey.trim()) {
        payload.stt_api_key = sttApiKey.trim();
      }
      await apiFetch("/settings/ai/test-stt", { method: "POST", body: JSON.stringify(payload) }, token);
      setStatus("STT 文件模型测试成功");
    } catch (error) {
      setStatus(`STT 测试失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  const testRealtimeStt = async () => {
    if (!token) return;
    try {
      if (!modelContainsRealtime(sttRealtimeModel)) {
        setStatus("STT 实时模型必须包含 realtime，请填写例如 qwen3-asr-flash-realtime 后再测试。");
        return;
      }
      const payload: AiSettingsUpdate & { mode: "realtime" } = {
        stt_provider: sttProvider,
        stt_realtime_model: sttRealtimeModel,
        mode: "realtime"
      };
      if (sttApiKey.trim()) {
        payload.stt_api_key = sttApiKey.trim();
      }
      await apiFetch("/settings/ai/test-stt", { method: "POST", body: JSON.stringify(payload) }, token);
      setStatus("STT 实时模型测试成功");
    } catch (error) {
      setStatus(`STT 测试失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  const testAnalysis = async () => {
    if (!token) return;
    try {
      const payload: AiSettingsUpdate = {
        analysis_provider: analysisProvider,
        analysis_model: analysisModel
      };
      if (analysisApiKey.trim()) {
        payload.analysis_api_key = analysisApiKey.trim();
      }
      await apiFetch(
        "/settings/ai/test-analysis",
        { method: "POST", body: JSON.stringify(payload) },
        token
      );
      setStatus("分析模型测试成功");
    } catch (error) {
      setStatus(`分析模型测试失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  const startRecording = async () => {
    if (recordMode === "realtime") {
      try {
        if (sttProvider !== "qwen3-asr") {
          setStatus("实时转写仅支持 qwen3-asr provider。请先在模型设置中切换 provider。");
          return;
        }
        if (!modelContainsRealtime(sttRealtimeModel)) {
          setStatus("实时转写要求 STT 实时模型包含 realtime。请先保存 realtime 模型后重试。");
          return;
        }
        if (!token) {
          setStatus("请先登录 API");
          return;
        }
        if (recorderRef.current && recorderRef.current.state !== "inactive") {
          setStatus("已有录音会话正在进行，请先停止");
          return;
        }
        const session = await apiFetch<{ session_id: string; status: string }>(
          "/realtime/sessions",
          {
            method: "POST",
            body: JSON.stringify({})
          },
          token
        );
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm";
        const wsBase = getWsBase();
        const ws = new WebSocket(
          `${wsBase}/realtime/sessions/${session.session_id}/stream?token=${encodeURIComponent(token)}`
        );

        streamRef.current = stream;
        chunksRef.current = [];
        startedAtRef.current = Date.now();
        realtimeSocketRef.current = ws;
        realtimeSessionIdRef.current = session.session_id;
        realtimeFallbackRef.current = false;
        realtimeStoppingRef.current = false;
        setRealtimeSessionId(session.session_id);
        setRealtimeInterimText("");
        setRealtimeFinalText("");

        const recorder = new MediaRecorder(stream, { mimeType });
        recorder.ondataavailable = (event) => {
          if (event.data.size <= 0) {
            return;
          }
          chunksRef.current.push(event.data);
          void (async () => {
            if (ws.readyState !== WebSocket.OPEN) {
              return;
            }
            const buffer = await event.data.arrayBuffer();
            ws.send(
              JSON.stringify({
                type: "audio_chunk",
                audio_base64: arrayBufferToBase64(buffer)
              })
            );
          })();
        };
        recorder.onerror = () => {
          void triggerRealtimeFallback("浏览器录音器异常");
        };
        recorder.onstop = async () => {
          setIsRecording(false);
          streamRef.current?.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
          recorderRef.current = null;
          const sessionId = realtimeSessionIdRef.current;
          const durationMs = Math.max(1000, Date.now() - startedAtRef.current);
          const localBlob = new Blob(chunksRef.current, { type: mimeType });
          chunksRef.current = [];
          if (!sessionId) {
            setStatus("实时会话丢失，请重试");
            return;
          }

          if (realtimeFallbackRef.current) {
            try {
              if (sttIsRealtimeOnly) {
                if (cryptoKey) {
                  await persistLocalRecording(localBlob, mimeType, durationMs, "实时回退录音");
                }
                setStatus("实时链路失败，已保留本地录音。请先将 STT 文件模型改为非 realtime（如 qwen3-asr-flash），再手动上传转写。");
              } else if (cryptoKey) {
                const localRow = await persistLocalRecording(
                  localBlob,
                  mimeType,
                  durationMs,
                  "实时回退录音"
                );
                await uploadAndTranscribe(localRow.id, {
                  realtimeSessionId: sessionId,
                  realtimeError: "realtime stream failed"
                });
              } else {
                await uploadBlobAndTranscribe(localBlob, mimeType, durationMs, {
                  realtimeSessionId: sessionId,
                  realtimeError: "realtime stream failed"
                });
              }
            } catch (error) {
              setStatus(`实时回退失败：${error instanceof Error ? error.message : "未知错误"}`);
            } finally {
              realtimeSocketRef.current?.close();
              realtimeSocketRef.current = null;
              realtimeSessionIdRef.current = null;
              setRealtimeSessionId(null);
            }
            return;
          }

          try {
            await new Promise((resolve) => setTimeout(resolve, 1200));
            const finish = await apiFetch<{
              status: string;
              recording_id: string;
              final_text: string;
            }>(`/realtime/sessions/${sessionId}/finish`, { method: "POST", body: JSON.stringify({}) }, token);
            setRealtimeFinalText(finish.final_text || "");
            setStatus("实时转写已结束并落库");
            await loadDailyData();
          } catch (error) {
            setStatus(`实时结束失败，自动回退上传：${error instanceof Error ? error.message : "未知错误"}`);
            realtimeFallbackRef.current = true;
            try {
              if (sttIsRealtimeOnly) {
                if (cryptoKey) {
                  await persistLocalRecording(localBlob, mimeType, durationMs, "实时回退录音");
                }
                setStatus("实时结束失败，已保留本地录音。请先将 STT 文件模型改为非 realtime（如 qwen3-asr-flash），再手动上传转写。");
              } else if (cryptoKey) {
                const localRow = await persistLocalRecording(
                  localBlob,
                  mimeType,
                  durationMs,
                  "实时回退录音"
                );
                await uploadAndTranscribe(localRow.id, {
                  realtimeSessionId: sessionId,
                  realtimeError: "realtime finish failed"
                });
              } else {
                await uploadBlobAndTranscribe(localBlob, mimeType, durationMs, {
                  realtimeSessionId: sessionId,
                  realtimeError: "realtime finish failed"
                });
              }
            } catch (fallbackError) {
              setStatus(
                `实时回退失败：${fallbackError instanceof Error ? fallbackError.message : "未知错误"}`
              );
            }
          } finally {
            realtimeSocketRef.current?.close();
            realtimeSocketRef.current = null;
            realtimeSessionIdRef.current = null;
            setRealtimeSessionId(null);
          }
        };

        ws.onopen = () => {
          setStatus("实时转写连接成功，开始录音");
          try {
            ws.send(
              JSON.stringify({
                type: "raw_event",
                event: {
                  type: "transcription_session.update",
                  session: {
                    input_audio_format: "auto",
                    input_audio_transcription: {
                      model: sttRealtimeModel,
                      language: "zh"
                    }
                  }
                }
              })
            );
          } catch {
          }
        };
        ws.onmessage = (event) => {
          const text = typeof event.data === "string" ? event.data : "";
          if (!text) return;
          try {
            const payload = JSON.parse(text) as { type?: string; text?: string; message?: string };
            if (payload.type === "interim" && payload.text) {
              setRealtimeInterimText((prev) => appendLine(prev, payload.text ?? ""));
              return;
            }
            if (payload.type === "final" && payload.text) {
              setRealtimeFinalText(payload.text);
              return;
            }
            if (payload.type === "error") {
              const message = payload.message ?? "未知错误";
              if (!realtimeStoppingRef.current) {
                void triggerRealtimeFallback(message);
              }
            }
          } catch {
          }
        };
        ws.onerror = () => {
          if (!realtimeStoppingRef.current) {
            void triggerRealtimeFallback("WebSocket 连接错误");
          }
        };
        ws.onclose = () => {
          if (!realtimeStoppingRef.current && !realtimeFallbackRef.current) {
            void triggerRealtimeFallback("WebSocket 连接断开");
          }
        };

        recorderRef.current = recorder;
        recorder.start(500);
        setIsRecording(true);
        return;
      } catch (error) {
        setIsRecording(false);
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        realtimeSocketRef.current?.close();
        realtimeSocketRef.current = null;
        realtimeSessionIdRef.current = null;
        setRealtimeSessionId(null);
        setStatus(`无法开始实时转写：${error instanceof Error ? error.message : "未知错误"}`);
        return;
      }
    }

    try {
      if (!token) {
        setStatus("请先登录 API");
        return;
      }
      if (!cryptoKey) {
        setStatus("请先设置本地口令");
        return;
      }
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        setStatus("已有录音会话正在进行，请先停止");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      startedAtRef.current = Date.now();
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setIsRecording(false);
        setStatus("录音失败，请重试");
      };
      recorder.onstop = async () => {
        try {
          const durationMs = Date.now() - startedAtRef.current;
          const blob = new Blob(chunksRef.current, { type: mimeType });
          chunksRef.current = [];
          const localRow = await persistLocalRecording(blob, mimeType, durationMs);
          setStatus("录音已保存，自动上传转写中...");
          await uploadAndTranscribe(localRow.id);
        } catch (error) {
          setStatus(`保存录音失败：${error instanceof Error ? error.message : "未知错误"}`);
        } finally {
          setIsRecording(false);
          streamRef.current?.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
          recorderRef.current = null;
        }
      };
      recorderRef.current = recorder;
      recorder.start(1000);
      setIsRecording(true);
      setStatus("录音中...");
    } catch (error) {
      setIsRecording(false);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setStatus(`无法开始录音：${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      setStatus("当前没有进行中的录音");
      setIsRecording(false);
      return;
    }
    if (recordMode === "realtime" && realtimeSessionIdRef.current) {
      realtimeStoppingRef.current = true;
      if (realtimeSocketRef.current?.readyState === WebSocket.OPEN) {
        try {
          realtimeSocketRef.current.send(JSON.stringify({ type: "stop" }));
        } catch {
        }
      }
      recorder.stop();
      setStatus("正在结束实时转写...");
      return;
    }
    recorder.stop();
    setStatus("正在停止录音...");
  };

  const ensureServerRecordingId = async (local: RecordingBlob) => {
    if (local.recordingId) return local.recordingId;
    const created = await apiFetch<{ id: string }>(
      "/recordings",
      {
        method: "POST",
        body: JSON.stringify({
          title: local.title,
          started_at: local.createdAt,
          duration_ms: local.durationMs
        })
      },
      token
    );
    await attachServerRecordingId(local.id, created.id);
    await loadLocalRecordings();
    return created.id;
  };

  const playRecording = async (id: string) => {
    if (!cryptoKey) {
      setStatus("请先初始化本地密钥后再回放");
      return;
    }
    const row = await getRecording(id);
    if (!row) return;
    const plain = await decryptAudioData(row.encryptedAudio, row.iv, cryptoKey);
    const blob = new Blob([plain], { type: row.mimeType });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
  };

  const uploadBlobAndTranscribe = async (
    blob: Blob,
    mimeType: string,
    durationMs: number,
    options?: UploadAndTranscribeOptions
  ) => {
    if (!token) {
      setStatus("请先登录 API");
      return;
    }
    const created = await apiFetch<{ id: string }>(
      "/recordings",
      {
        method: "POST",
        body: JSON.stringify({
          title: `回退录音 ${new Date().toLocaleString()}`,
          started_at: new Date().toISOString(),
          duration_ms: Math.max(1000, durationMs)
        })
      },
      token
    );
    const recordingId = created.id;
    if (options?.realtimeSessionId) {
      await markRealtimeFallback(
        options.realtimeSessionId,
        options.realtimeError ?? "auto fallback to upload",
        recordingId
      );
    }
    const uploadPayload = await apiFetch<{ upload_url: string }>(
      `/recordings/${recordingId}/upload-url`,
      {
        method: "POST",
        body: JSON.stringify({ mime_type: mimeType })
      },
      token
    );
    await fetch(uploadPayload.upload_url, {
      method: "PUT",
      headers: {
        "Content-Type": mimeType
      },
      body: blob
    });
    await apiFetch(
      `/recordings/${recordingId}/transcribe`,
      {
        method: "POST"
      },
      token
    );
    setStatus("已提交转写，正在轮询状态");
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const state = await apiFetch<{ status: string; failed_reason: string | null }>(
        `/recordings/${recordingId}/status`,
        {},
        token
      );
      if (state.status === "transcribed") {
        setStatus("转写完成");
        if (options?.realtimeSessionId) {
          setRealtimeFinalText("已自动回退为上传转写，请查看今日转写内容。");
        }
        await loadDailyData();
        return;
      }
      if (state.status === "failed") {
        setStatus(`转写失败：${state.failed_reason ?? "未知错误"}`);
        return;
      }
    }
    setStatus("转写轮询超时，请稍后刷新");
  };

  const uploadAndTranscribe = async (id: string, options?: UploadAndTranscribeOptions) => {
    try {
      if (!token) {
        setStatus("请先登录 API");
        return;
      }
      if (!cryptoKey) {
        setStatus("请先初始化本地密钥后再上传本地录音");
        return;
      }
      if (sttIsRealtimeOnly) {
        if (options?.realtimeSessionId) {
          setStatus(
            "实时链路失败，但回退上传需要“STT 文件模型”为非 realtime（如 qwen3-asr-flash）。已保留本地录音，请改模型后手动上传。"
          );
          return;
        }
        setStatus("当前 STT 文件模型是 realtime，仅支持“实时转写”模式。请先切换为非 realtime 文件模型再上传转写。");
        return;
      }
      const local = await getRecording(id);
      if (!local) return;
      if (local.durationMs > LONG_AUDIO_THRESHOLD_MS) {
        setStatus("检测到录音超过 5 分钟，将自动使用长音频转写模型（filetrans）");
      }
      const recordingId = await ensureServerRecordingId(local);
      if (options?.realtimeSessionId) {
        await markRealtimeFallback(
          options.realtimeSessionId,
          options.realtimeError ?? "auto fallback to upload",
          recordingId
        );
      }
      const uploadPayload = await apiFetch<{ upload_url: string }>(
        `/recordings/${recordingId}/upload-url`,
        {
          method: "POST",
          body: JSON.stringify({ mime_type: local.mimeType })
        },
        token
      );
      const plain = await decryptAudioData(local.encryptedAudio, local.iv, cryptoKey);
      const blob = new Blob([plain], { type: local.mimeType });
      await fetch(uploadPayload.upload_url, {
        method: "PUT",
        headers: {
          "Content-Type": local.mimeType
        },
        body: blob
      });
      await apiFetch(
        `/recordings/${recordingId}/transcribe`,
        {
          method: "POST"
        },
        token
      );
      setStatus("已提交转写，正在轮询状态");
      for (let i = 0; i < 50; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const state = await apiFetch<{ status: string; failed_reason: string | null }>(
          `/recordings/${recordingId}/status`,
          {},
          token
        );
        if (state.status === "transcribed") {
          setStatus("转写完成");
          if (options?.realtimeSessionId) {
            setRealtimeFinalText("已自动回退为上传转写，请查看今日转写内容。");
          }
          await loadDailyData();
          return;
        }
        if (state.status === "failed") {
          setStatus(`转写失败：${state.failed_reason ?? "未知错误"}`);
          return;
        }
      }
      setStatus("转写轮询超时，请稍后刷新");
    } catch (error) {
      if (options?.realtimeSessionId) {
        await markRealtimeFallback(
          options.realtimeSessionId,
          error instanceof Error ? error.message : "fallback upload failed"
        );
      }
      setStatus(`上传或转写失败：${error instanceof Error ? error.message : "未知错误"}。可点击“上传并转写”重试，并检查 STT Key/模型配置。`);
    }
  };

  const generateSummary = async () => {
    await apiFetch(
      "/daily-summaries",
      {
        method: "POST",
        body: JSON.stringify({ date: selectedDate })
      },
      token
    );
    setStatus("已提交日报生成任务");
    for (let i = 0; i < 25; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const item = await apiFetch<DailySummaryResponse>(`/daily-summaries?date=${selectedDate}`, {}, token);
      if (item) {
        setSummary(item);
        setStatus("日报已生成");
        const taskRows = await apiFetch<ApiTask[]>(`/tasks?date=${selectedDate}`, {}, token);
        setTasks(taskRows);
        return;
      }
    }
    setStatus("日报生成超时，请稍后刷新");
  };

  const updateTask = async (taskId: string, patch: Partial<ApiTask>) => {
    const updated = await apiFetch<ApiTask>(
      `/tasks/${taskId}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch)
      },
      token
    );
    setTasks((prev) => prev.map((item) => (item.id === taskId ? updated : item)));
  };

  const regenerateMeetingNote = async (recordingId: string) => {
    if (!token) return;
    try {
      await apiFetch(
        `/meeting-notes/${recordingId}/regenerate`,
        { method: "POST", body: JSON.stringify({}) },
        token
      );
      setStatus("会议笔记已重建");
      await loadDailyData();
    } catch (error) {
      setStatus(`重建会议笔记失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  const sttIsRealtimeOnly = sttProvider === "qwen3-asr" && modelContainsRealtime(sttFileModel);
  const resolvedSettings = {
    stt_provider: aiSettings?.stt_provider ?? sttProvider,
    stt_file_model: aiSettings?.stt_file_model ?? sttFileModel,
    stt_realtime_model: aiSettings?.stt_realtime_model ?? sttRealtimeModel
  };
  const realtimeModeConfigReason =
    sttProvider !== "qwen3-asr"
      ? "实时模式需要 STT provider 为 qwen3-asr"
      : !modelContainsRealtime(sttRealtimeModel)
        ? "实时模式需要 STT 实时模型包含 realtime"
        : null;
  const uploadDisabledReason = !token
    ? "请先登录 API"
    : sttIsRealtimeOnly
      ? "上传转写需要非 realtime 的 STT 文件模型（如 qwen3-asr-flash）"
      : null;
  const startDisabledReason = isRecording
    ? "录音进行中"
    : recordMode === "realtime"
      ? !token
        ? "请先登录 API"
        : realtimeModeConfigReason
      : !token
        ? "录完上传模式需要先登录 API"
        : !cryptoKey
          ? "录完上传模式需要先初始化本地密钥"
          : null;

  return (
    <main>
      <h1>Matridx Ting</h1>
      <p className="muted">安卓 PWA 前台录音，默认本地加密；云端仅临时处理音频并保存文本。</p>

      <section className="card">
        <h2>1. 登录与本地口令</h2>
        <div className="row">
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="用户名" />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="密码"
            type="password"
          />
          <button onClick={() => void login()}>登录 API</button>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <input
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            placeholder="本地加密口令（>=6位）"
            type="password"
          />
          <button className="secondary" onClick={() => void handleInitPasscode()}>
            初始化本地密钥
          </button>
          <span className="muted">本地密钥：{cryptoKey ? "已初始化" : "未初始化"}</span>
        </div>
      </section>

      <section className="card">
        <h2>2. 模型设置（STT / 分析）</h2>
        <div className="task">
          <h3>语音转写（STT）</h3>
          <div className="row">
            <select
              value={sttProvider}
              onChange={(e) =>
                setSttProvider(e.target.value as "openai" | "openrouter" | "seed-asr" | "qwen3-asr")
              }
            >
              <option value="openai">openai</option>
              <option value="openrouter">openrouter</option>
              <option value="seed-asr">seed-asr (豆包/火山)</option>
              <option value="qwen3-asr">qwen3-asr (自建)</option>
            </select>
            <input
              value={sttFileModel}
              onChange={(e) => setSttFileModel(e.target.value)}
              placeholder="STT 文件模型名"
            />
            <input
              value={sttRealtimeModel}
              onChange={(e) => setSttRealtimeModel(e.target.value)}
              placeholder="STT 实时模型名"
            />
            <input
              value={sttApiKey}
              onChange={(e) => setSttApiKey(e.target.value)}
              placeholder={
                aiSettings?.stt_api_key_configured ? "已配置（留空表示不修改）" : "输入 STT API Key"
              }
              type="password"
            />
            <button className="secondary" onClick={() => void testStt()}>
              测试 STT(文件)
            </button>
            <button className="secondary" onClick={() => void testRealtimeStt()}>
              测试 STT(实时)
            </button>
            <button onClick={() => void saveSttSettings()}>保存 STT</button>
            <button className="danger" onClick={() => void clearSttKey()}>
              清空 STT Key
            </button>
          </div>
          <p className="muted">STT Key 状态：{aiSettings?.stt_api_key_configured ? "已配置" : "未配置"}</p>
        </div>
        <div className="task">
          <h3>文本分析（LLM）</h3>
          <div className="row">
            <select
              value={analysisProvider}
              onChange={(e) => setAnalysisProvider(e.target.value as "openai" | "openrouter")}
            >
              <option value="openai">openai</option>
              <option value="openrouter">openrouter</option>
            </select>
            <input
              value={analysisModel}
              onChange={(e) => setAnalysisModel(e.target.value)}
              placeholder="分析模型名"
            />
            <input
              value={analysisApiKey}
              onChange={(e) => setAnalysisApiKey(e.target.value)}
              placeholder={
                aiSettings?.analysis_api_key_configured
                  ? "已配置（留空表示不修改）"
                  : "输入分析 API Key"
              }
              type="password"
            />
            <button className="secondary" onClick={() => void testAnalysis()}>
              测试分析
            </button>
            <button onClick={() => void saveAnalysisSettings()}>保存分析</button>
            <button className="danger" onClick={() => void clearAnalysisKey()}>
              清空分析 Key
            </button>
          </div>
          <p className="muted">
            分析 Key 状态：{aiSettings?.analysis_api_key_configured ? "已配置" : "未配置"}
          </p>
        </div>
        <button onClick={() => void saveAiSettings()}>保存模型设置</button>
      </section>

      <section className="card">
        <h2>3. 录音与本地回放</h2>
        <div className="row">
          <select
            value={recordMode}
            onChange={(e) => setRecordMode(e.target.value as RecordingMode)}
            disabled={isRecording}
          >
            <option value="upload">录完上传转写</option>
            <option value="realtime">实时转写（Qwen Realtime）</option>
          </select>
          <button
            disabled={Boolean(startDisabledReason)}
            onClick={() => void startRecording()}
          >
            {recordMode === "realtime" ? "开始实时转写" : "开始录音"}
          </button>
          <button className="secondary" disabled={!isRecording} onClick={stopRecording}>
            {recordMode === "realtime" ? "停止实时转写" : "停止录音"}
          </button>
          <span className="muted">{status}</span>
        </div>
        {sttIsRealtimeOnly ? (
          <p className="muted">当前 STT 文件模型为 realtime：仅“实时转写”可用，“上传并转写”已禁用。</p>
        ) : null}
        {startDisabledReason ? <p className="muted">{startDisabledReason}</p> : null}
        {recordMode === "realtime" ? (
          <div className="task">
            <div className="muted">
              会话ID：{realtimeSessionId ? realtimeSessionId.slice(0, 8) : "未开始"}
              {resolvedSettings.stt_provider === "qwen3-asr" &&
              modelContainsRealtime(resolvedSettings.stt_realtime_model)
                ? " | 当前模型支持 realtime"
                : " | 请确保 STT 已保存为 qwen3-asr realtime 模型"}
            </div>
            <h3 style={{ marginTop: 8 }}>临时字幕（interim）</h3>
            <textarea readOnly value={realtimeInterimText} rows={4} style={{ width: "100%" }} />
            <h3 style={{ marginTop: 8 }}>最终文本（final）</h3>
            <textarea readOnly value={realtimeFinalText} rows={4} style={{ width: "100%" }} />
          </div>
        ) : null}
        {recordings.map((row) => (
          <div className="task" key={row.id}>
            <div>
              <strong>{row.title}</strong>
            </div>
            <div className="muted">
              时长 {Math.round(row.durationMs / 1000)} 秒 | 本地ID {row.id.slice(0, 8)}
            </div>
            {row.durationMs > LONG_AUDIO_THRESHOLD_MS ? (
              <div className="muted">该录音超过 5 分钟，上传后会自动走长音频 filetrans 转写。</div>
            ) : null}
            <div className="row" style={{ marginTop: 8 }}>
              <button className="secondary" onClick={() => void playRecording(row.id)}>
                回放
              </button>
              <button disabled={Boolean(uploadDisabledReason)} onClick={() => void uploadAndTranscribe(row.id)}>
                上传并转写
              </button>
              {uploadDisabledReason ? <span className="muted">{uploadDisabledReason}</span> : null}
              <button
                className="danger"
                onClick={() =>
                  void (async () => {
                    try {
                      await removeRecording(row.id);
                      await loadLocalRecordings();
                      setStatus("本地录音已删除");
                    } catch (error) {
                      setStatus(`删除录音失败：${error instanceof Error ? error.message : "未知错误"}`);
                    }
                  })()
                }
              >
                删除本地录音
              </button>
            </div>
          </div>
        ))}
      </section>

      <section className="card">
        <h2>4. 每日转写、日报与计划</h2>
        <div className="row">
          <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} />
          <button className="secondary" onClick={() => void loadDailyData()}>
            刷新
          </button>
          <button onClick={() => void generateSummary()}>生成日报</button>
        </div>
        {dailyDataFromCache ? <p className="muted">当前显示离线缓存数据</p> : null}
        <h3 style={{ marginTop: 12 }}>会议笔记</h3>
        {meetingNotes.length === 0 ? (
          <p className="muted">暂无会议笔记</p>
        ) : (
          meetingNotes.map((note) => (
            <div className="task" key={note.id}>
              <div className="row">
                <strong>{note.title}</strong>
                <span className="muted">
                  {note.date} {note.time} | 贡献者: {note.contributor}
                </span>
              </div>
              <div>{note.summary}</div>
              <div className="muted">
                来源: {note.source} | 云端文件: {note.storage_path ?? "未落盘"}
              </div>
              {note.last_error ? <div className="muted">文件错误: {note.last_error}</div> : null}
              <div style={{ marginTop: 8 }}>
                <button className="secondary" onClick={() => void navigator.clipboard.writeText(note.transcript_text)}>
                  复制全文
                </button>
                {note.last_error ? (
                  <button className="secondary" onClick={() => void regenerateMeetingNote(note.recording_id)}>
                    重建会议笔记文件
                  </button>
                ) : null}
              </div>
            </div>
          ))
        )}
        <h3 style={{ marginTop: 12 }}>转写内容</h3>
        {transcripts.length === 0 ? (
          <p className="muted">暂无转写</p>
        ) : (
          transcripts.map((item) => (
            <div className="task" key={item.id}>
              <div className="muted">录音ID: {item.recording_id}</div>
              <div>{item.text}</div>
            </div>
          ))
        )}
        <h3 style={{ marginTop: 12 }}>日报 Markdown</h3>
        <textarea readOnly value={summary?.report_md ?? ""} rows={12} style={{ width: "100%" }} />
        <h3 style={{ marginTop: 12 }}>任务列表</h3>
        {tasks.length === 0 ? (
          <p className="muted">暂无任务</p>
        ) : (
          tasks.map((task) => (
            <div className="task" key={task.id}>
              <div className="row">
                <strong>{task.title}</strong>
                <select
                  value={task.status}
                  onChange={(e) =>
                    void updateTask(task.id, { status: e.target.value as ApiTask["status"] })
                  }
                >
                  <option value="todo">todo</option>
                  <option value="doing">doing</option>
                  <option value="done">done</option>
                </select>
                <select
                  value={task.priority}
                  onChange={(e) =>
                    void updateTask(task.id, { priority: e.target.value as ApiTask["priority"] })
                  }
                >
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </div>
              <div className="muted">
                截止: {task.due_date ?? "未设置"} | 预估:{" "}
                {task.estimate_min ? `${task.estimate_min} 分钟` : "未设置"}
              </div>
              {task.notes ? <div>{task.notes}</div> : null}
            </div>
          ))
        )}
      </section>
    </main>
  );
}
