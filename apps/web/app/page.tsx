"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  apiFetch,
  type AiSettingsUpdate,
  type AiSettingsView,
  type ApiTask
} from "../lib/api";
import { decryptAudioData, deriveAesKey, encryptAudioData } from "../lib/crypto";
import {
  attachServerRecordingId,
  getRecording,
  listRecordings,
  removeRecording,
  saveRecording,
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
  const [summary, setSummary] = useState<DailySummaryResponse>(null);
  const [tasks, setTasks] = useState<ApiTask[]>([]);
  const [aiSettings, setAiSettings] = useState<AiSettingsView | null>(null);
  const [sttProvider, setSttProvider] = useState<"openai" | "openrouter" | "seed-asr" | "qwen3-asr">(
    "openai"
  );
  const [sttModel, setSttModel] = useState("gpt-4o-mini-transcribe");
  const [sttApiKey, setSttApiKey] = useState("");
  const [analysisProvider, setAnalysisProvider] = useState<"openai" | "openrouter">("openai");
  const [analysisModel, setAnalysisModel] = useState("gpt-4.1-mini");
  const [analysisApiKey, setAnalysisApiKey] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startedAtRef = useRef<number>(0);

  const canRecord = useMemo(() => typeof window !== "undefined" && !!cryptoKey, [cryptoKey]);

  const loadLocalRecordings = async () => {
    const rows = await listRecordings();
    setRecordings(rows);
  };

  const loadDailyData = async () => {
    if (!token) return;
    try {
      const [transcriptRows, summaryRow, taskRows] = await Promise.all([
        apiFetch<Transcript[]>(`/transcripts?date=${selectedDate}`, {}, token),
        apiFetch<DailySummaryResponse>(`/daily-summaries?date=${selectedDate}`, {}, token),
        apiFetch<ApiTask[]>(`/tasks?date=${selectedDate}`, {}, token)
      ]);
      setTranscripts(transcriptRows);
      setSummary(summaryRow);
      setTasks(taskRows);
    } catch (error) {
      setStatus(`加载每日数据失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  const loadAiSettings = async () => {
    if (!token) return;
    try {
      const settings = await apiFetch<AiSettingsView>("/settings/ai", {}, token);
      setAiSettings(settings);
      setSttProvider(settings.stt_provider);
      setSttModel(settings.stt_model);
      setAnalysisProvider(settings.analysis_provider);
      setAnalysisModel(settings.analysis_model);
      setSttApiKey("");
      setAnalysisApiKey("");
    } catch (error) {
      setStatus(`加载模型设置失败：${error instanceof Error ? error.message : "未知错误"}`);
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
    }
  }, [token]);

  const handleInitPasscode = async () => {
    if (passcode.length < 6) {
      setStatus("口令至少 6 位");
      return;
    }
    const key = await deriveAesKey(passcode);
    setCryptoKey(key);
    setStatus("本地加密密钥已准备");
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
      const payload: AiSettingsUpdate = {
        stt_provider: sttProvider,
        stt_model: sttModel,
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
      const payload: AiSettingsUpdate = {
        stt_provider: sttProvider,
        stt_model: sttModel
      };
      if (sttApiKey.trim()) {
        payload.stt_api_key = sttApiKey.trim();
      }
      await apiFetch("/settings/ai/test-stt", { method: "POST", body: JSON.stringify(payload) }, token);
      setStatus("STT 测试成功");
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
    try {
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
          const arrayBuffer = await blob.arrayBuffer();
          const encrypted = await encryptAudioData(arrayBuffer, cryptoKey);
          const localRow: RecordingBlob = {
            id: crypto.randomUUID(),
            title: `录音 ${new Date().toLocaleString()}`,
            createdAt: new Date().toISOString(),
            durationMs,
            mimeType,
            encryptedAudio: encrypted.encrypted,
            iv: encrypted.iv
          };
          await saveRecording(localRow);
          await loadLocalRecordings();
          setStatus("录音已保存到本地加密库");
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
    if (!cryptoKey) return;
    const row = await getRecording(id);
    if (!row) return;
    const plain = await decryptAudioData(row.encryptedAudio, row.iv, cryptoKey);
    const blob = new Blob([plain], { type: row.mimeType });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
  };

  const uploadAndTranscribe = async (id: string) => {
    try {
      if (!token || !cryptoKey) return;
      const local = await getRecording(id);
      if (!local) return;
      const recordingId = await ensureServerRecordingId(local);
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
      setStatus(`上传或转写失败：${error instanceof Error ? error.message : "未知错误"}`);
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
            <input value={sttModel} onChange={(e) => setSttModel(e.target.value)} placeholder="STT 模型名" />
            <input
              value={sttApiKey}
              onChange={(e) => setSttApiKey(e.target.value)}
              placeholder={
                aiSettings?.stt_api_key_configured ? "已配置（留空表示不修改）" : "输入 STT API Key"
              }
              type="password"
            />
            <button className="secondary" onClick={() => void testStt()}>
              测试 STT
            </button>
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
          <button disabled={isRecording} onClick={() => void startRecording()}>
            开始录音
          </button>
          <button className="secondary" disabled={!isRecording} onClick={stopRecording}>
            停止录音
          </button>
          <span className="muted">{status}</span>
        </div>
        {recordings.map((row) => (
          <div className="task" key={row.id}>
            <div>
              <strong>{row.title}</strong>
            </div>
            <div className="muted">
              时长 {Math.round(row.durationMs / 1000)} 秒 | 本地ID {row.id.slice(0, 8)}
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="secondary" onClick={() => void playRecording(row.id)}>
                回放
              </button>
              <button onClick={() => void uploadAndTranscribe(row.id)}>上传并转写</button>
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
