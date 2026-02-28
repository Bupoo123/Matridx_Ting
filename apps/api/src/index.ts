import bcrypt from "bcryptjs";
import cors from "@fastify/cors";
import fastifyJwt from "@fastify/jwt";
import sensible from "@fastify/sensible";
import websocketPlugin from "@fastify/websocket";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import WebSocket, { type RawData } from "ws";
import { z } from "zod";
import { aiSettingsUpdateSchema, taskPrioritySchema, taskStatusSchema } from "@matridx/shared";
import { config } from "./config.js";
import { pool } from "./db.js";
import { createAudioUploadUrl } from "./s3.js";
import { dailySummaryQueue, transcribeQueue } from "./queue.js";
import { ensureDailySummarySchemaExists } from "./daily-summary-schema.js";
import {
  ensureMeetingNotesTableExists,
  getMeetingNoteById,
  getRecordingSource,
  listMeetingNotesByDate,
  persistMeetingNoteForRecording
} from "./meeting-notes.js";
import {
  appendRealtimeInterimText,
  createRealtimeSession,
  ensureRealtimeSessionTableExists,
  finishRealtimeSessionAndPersist,
  getRealtimeSessionForUser,
  markRealtimeFailed,
  markRealtimeFallback,
  setRealtimeFinalText
} from "./realtime-sessions.js";
import {
  getAiSettingsForUser as getAiSettings,
  getRawAiSettingsForUser as getRawAiSettings,
  updateAiSettingsForUser as updateAiSettings
} from "./ai-settings.js";
import { testAnalysisProvider, testSttProvider } from "./openai-test.js";
import type { JwtPayload, TaskRow } from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    userCtx: JwtPayload;
  }
}

const app = Fastify({ logger: true });

await app.register(sensible);
await app.register(cors, {
  origin: true,
  credentials: true
});
await app.register(websocketPlugin);
await app.register(fastifyJwt, {
  secret: config.JWT_SECRET
});

const taskPayloadSchema = z.object({
  title: z.string().min(1),
  notes: z.string().nullable().optional(),
  priority: taskPrioritySchema.default("medium"),
  status: taskStatusSchema.default("todo"),
  due_date: z.string().nullable().optional(),
  estimate_min: z.number().int().positive().nullable().optional(),
  source_summary_id: z.string().uuid().nullable().optional()
});

const timezonePayloadSchema = z.object({
  tz: z.string().min(1)
});

async function authGuard(req: FastifyRequest, reply: FastifyReply) {
  await req.jwtVerify<JwtPayload>();
  req.userCtx = req.user as JwtPayload;
  if (!req.userCtx?.sub) {
    return reply.unauthorized("Invalid token");
  }
}

app.post("/auth/login", async (req, reply) => {
  const body = z
    .object({
      username: z.string(),
      password: z.string()
    })
    .parse(req.body);

  if (body.username !== config.ADMIN_USERNAME) {
    return reply.unauthorized("Invalid credentials");
  }

  const ok = await bcrypt.compare(body.password, config.ADMIN_PASSWORD_HASH);
  if (!ok) {
    return reply.unauthorized("Invalid credentials");
  }

  const userResult = await pool.query<{ id: string; username: string }>(
    `INSERT INTO users (username)
     VALUES ($1)
     ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
     RETURNING id, username`,
    [config.ADMIN_USERNAME]
  );
  const user = userResult.rows[0];
  if (!user) {
    throw new Error("Unable to resolve admin user");
  }

  const token = await reply.jwtSign(
    { sub: user.id, username: user.username },
    { expiresIn: "8h" }
  );
  return { access_token: token };
});

app.get("/healthz", async () => ({ ok: true }));

app.addHook("preHandler", async (req, reply) => {
  if (req.url.startsWith("/auth/login") || req.url.startsWith("/healthz")) {
    return;
  }
  if (req.url.startsWith("/realtime/sessions/") && req.url.includes("/stream")) {
    return;
  }
  return authGuard(req, reply);
});

app.get("/settings/ai", async (req) => {
  return getAiSettings(req.userCtx.sub);
});

app.put("/users/me/timezone", async (req) => {
  const body = timezonePayloadSchema.parse(req.body);
  const updated = await pool.query<{ id: string; username: string; tz: string }>(
    "UPDATE users SET tz = $2 WHERE id = $1 RETURNING id, username, tz",
    [req.userCtx.sub, body.tz]
  );
  return updated.rows[0];
});

app.put("/settings/ai", async (req) => {
  const body = aiSettingsUpdateSchema.parse(req.body);
  const current = await getRawAiSettings(req.userCtx.sub);
  const nextProvider = body.stt_provider ?? current.stt_provider;
  const nextFileModel = body.stt_file_model ?? (body.stt_model && !body.stt_model.includes("realtime") ? body.stt_model : undefined) ?? current.stt_file_model;
  const nextRealtimeModel =
    body.stt_realtime_model ??
    (body.stt_model && body.stt_model.includes("realtime") ? body.stt_model : undefined) ??
    current.stt_realtime_model;
  if ((nextFileModel ?? "").includes("realtime")) {
    throw app.httpErrors.badRequest("STT 文件模型不能是 realtime。请将 realtime 模型填写到 STT 实时模型。");
  }
  if (!(nextRealtimeModel ?? "").includes("realtime")) {
    throw app.httpErrors.badRequest("STT 实时模型必须包含 realtime（例如 qwen3-asr-flash-realtime）。");
  }
  if (nextProvider !== "qwen3-asr" && body.stt_realtime_model) {
    throw app.httpErrors.badRequest("实时 STT 目前仅支持 qwen3-asr provider。");
  }
  return updateAiSettings(req.userCtx.sub, body);
});

app.post("/settings/ai/test-stt", async (req, reply) => {
  const body = aiSettingsUpdateSchema.partial().parse(req.body ?? {});
  const mode = z.enum(["file", "realtime"]).default("file").parse((req.body as Record<string, unknown> | null)?.mode);
  const current = await getRawAiSettings(req.userCtx.sub);
  const provider = body.stt_provider ?? current.stt_provider;
  const model =
    mode === "realtime"
      ? body.stt_realtime_model ?? current.stt_realtime_model
      : body.stt_file_model ??
        (body.stt_model && !body.stt_model.includes("realtime") ? body.stt_model : undefined) ??
        current.stt_file_model;
  if (mode === "file" && (model ?? "").includes("realtime")) {
    return reply.badRequest("STT 文件模型不能是 realtime。请改用非 realtime 文件模型。");
  }
  if (mode === "realtime" && !(model ?? "").includes("realtime")) {
    return reply.badRequest("STT 实时模型必须包含 realtime。请改用 realtime 模型后重试。");
  }
  const apiKey =
    body.clear_stt_api_key === true
      ? null
      : body.stt_api_key !== undefined
        ? body.stt_api_key
        : current.stt_api_key;
  const requiresSttKey = provider === "openai" || provider === "openrouter" || provider === "seed-asr";
  if (requiresSttKey && !apiKey) {
    return reply.badRequest("STT API Key 未配置");
  }
  if (mode === "realtime" && provider !== "qwen3-asr") {
    return reply.badRequest("实时 STT 测试仅支持 qwen3-asr provider");
  }
  try {
    await testSttProvider(provider, apiKey ?? "", model);
    return { ok: true };
  } catch (error) {
    return reply.badRequest(`STT 测试失败: ${String(error)}`);
  }
});

app.post("/settings/ai/test-analysis", async (req, reply) => {
  const body = aiSettingsUpdateSchema.partial().parse(req.body ?? {});
  const current = await getRawAiSettings(req.userCtx.sub);
  const provider = body.analysis_provider ?? current.analysis_provider;
  const model = body.analysis_model ?? current.analysis_model;
  const apiKey =
    body.clear_analysis_api_key === true
      ? null
      : body.analysis_api_key !== undefined
        ? body.analysis_api_key
        : current.analysis_api_key;
  if (!apiKey) {
    return reply.badRequest("分析 API Key 未配置");
  }
  try {
    await testAnalysisProvider(provider, apiKey, model);
    return { ok: true };
  } catch (error) {
    return reply.badRequest(`分析模型测试失败: ${String(error)}`);
  }
});

const realtimeSessionCreateSchema = z.object({});
const realtimeWsQuerySchema = z.object({ token: z.string().min(10) });
const realtimeFallbackSchema = z.object({
  error: z.string().optional(),
  fallback_recording_id: z.string().uuid().nullable().optional()
});

function buildRealtimeWsUrl(model: string) {
  const query = new URLSearchParams({ model });
  return `${config.QWEN_REALTIME_WS_URL}?${query.toString()}`;
}

function extractTextFromRealtimeEvent(payload: unknown): { text: string; isFinal: boolean } | null {
  if (!payload || typeof payload !== "object") return null;
  const event = payload as Record<string, unknown>;
  const type = String(event.type ?? "");
  if (typeof event.text === "string" && event.text.trim()) {
    return { text: event.text.trim(), isFinal: type.includes("final") || type.includes("done") };
  }
  if (typeof event.transcript === "string" && event.transcript.trim()) {
    return { text: event.transcript.trim(), isFinal: type.includes("final") || type.includes("done") };
  }
  if (type === "response.audio_transcript.delta") {
    const delta = event.delta;
    if (typeof delta === "string" && delta.trim()) {
      return { text: delta.trim(), isFinal: false };
    }
  }
  if (type === "response.audio_transcript.done") {
    const transcript = event.transcript;
    if (typeof transcript === "string" && transcript.trim()) {
      return { text: transcript.trim(), isFinal: true };
    }
  }
  const nested = [
    event.result as Record<string, unknown> | undefined,
    event.output as Record<string, unknown> | undefined,
    event.data as Record<string, unknown> | undefined
  ];
  for (const item of nested) {
    if (!item) continue;
    const text = item.text;
    if (typeof text === "string" && text.trim()) {
      return { text: text.trim(), isFinal: type.includes("final") || type.includes("done") };
    }
  }
  return null;
}

app.post("/realtime/sessions", async (req, reply) => {
  realtimeSessionCreateSchema.parse(req.body ?? {});
  await ensureRealtimeSessionTableExists();
  const sttSettings = await getRawAiSettings(req.userCtx.sub);
  if (sttSettings.stt_provider !== "qwen3-asr") {
    return reply.badRequest("实时转写要求 STT provider 为 qwen3-asr");
  }
  if (!(sttSettings.stt_realtime_model ?? "").includes("realtime")) {
    return reply.badRequest("实时转写要求 STT model 为 realtime 模型");
  }
  const apiKey = sttSettings.stt_api_key ?? config.QWEN_ASR_API_KEY;
  if (!apiKey) {
    return reply.badRequest("Qwen 实时转写 API Key 未配置");
  }
  const running = await pool.query<{ id: string }>(
    "SELECT id FROM realtime_sessions WHERE user_id = $1 AND status = 'running' LIMIT 1",
    [req.userCtx.sub]
  );
  if (running.rowCount) {
    return { session_id: running.rows[0]?.id, status: "running" };
  }
  const session = await createRealtimeSession(
    req.userCtx.sub,
    sttSettings.stt_provider,
    sttSettings.stt_realtime_model
  );
  return { session_id: session.id, status: session.status };
});

app.get("/realtime/sessions/:id/status", async (req, reply) => {
  const params = z.object({ id: z.string().uuid() }).parse(req.params);
  const session = await getRealtimeSessionForUser(params.id, req.userCtx.sub);
  if (!session) {
    return reply.notFound("Realtime session not found");
  }
  return session;
});

app.post("/realtime/sessions/:id/finish", async (req, reply) => {
  const params = z.object({ id: z.string().uuid() }).parse(req.params);
  try {
    const result = await finishRealtimeSessionAndPersist(params.id, req.userCtx.sub);
    try {
      await persistMeetingNoteForRecording(result.recordingId, req.userCtx.sub, "realtime");
    } catch (noteError) {
      req.log.error(noteError, "failed to persist meeting note for realtime session");
    }
    return {
      session_id: params.id,
      status: "finished",
      recording_id: result.recordingId,
      final_text: result.transcriptText
    };
  } catch (error) {
    await markRealtimeFailed(params.id, String(error));
    return reply.badRequest(`完成实时转写失败: ${String(error)}`);
  }
});

app.post("/realtime/sessions/:id/fallback", async (req, reply) => {
  const params = z.object({ id: z.string().uuid() }).parse(req.params);
  const body = realtimeFallbackSchema.parse(req.body ?? {});
  const session = await getRealtimeSessionForUser(params.id, req.userCtx.sub);
  if (!session) {
    return reply.notFound("Realtime session not found");
  }
  await markRealtimeFallback(params.id, body.error ?? "auto fallback", body.fallback_recording_id ?? null);
  return { ok: true };
});

app.get(
  "/realtime/sessions/:id/stream",
  { websocket: true },
  (socket: WebSocket, req: FastifyRequest) => {
    void (async () => {
      const params = z.object({ id: z.string().uuid() }).parse(req.params);
      const query = realtimeWsQuerySchema.parse(req.query ?? {});
      let user: JwtPayload;
      try {
        user = await app.jwt.verify<JwtPayload>(query.token);
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "invalid token" }));
        socket.close();
        return;
      }
      const session = await getRealtimeSessionForUser(params.id, user.sub);
      if (!session || session.status !== "running") {
        socket.send(JSON.stringify({ type: "error", message: "session not running" }));
        socket.close();
        return;
      }
      if (session.stt_provider !== "qwen3-asr") {
        socket.send(JSON.stringify({ type: "error", message: "session stt provider is not qwen3-asr" }));
        socket.close();
        return;
      }
      const sttSettings = await getRawAiSettings(user.sub);
      const apiKey = sttSettings.stt_api_key ?? config.QWEN_ASR_API_KEY;
      if (!apiKey) {
        socket.send(JSON.stringify({ type: "error", message: "missing stt api key" }));
        socket.close();
        return;
      }
      const upstream = new WebSocket(buildRealtimeWsUrl(session.stt_model), {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(config.DASHSCOPE_WORKSPACE ? { "X-DashScope-WorkSpace": config.DASHSCOPE_WORKSPACE } : {})
        }
      });
      let closed = false;
      const closeAll = async (reason?: string) => {
        if (closed) return;
        closed = true;
        try {
          upstream.close();
        } catch {
        }
        try {
          socket.close();
        } catch {
        }
        if (reason) {
          await markRealtimeFailed(params.id, reason);
        }
      };

      upstream.on("open", () => {
        socket.send(JSON.stringify({ type: "connected" }));
      });

      upstream.on("message", async (data: RawData) => {
        const raw = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
        }
        if (parsed) {
          const extracted = extractTextFromRealtimeEvent(parsed);
          if (extracted) {
            if (extracted.isFinal) {
              await setRealtimeFinalText(params.id, extracted.text);
              socket.send(JSON.stringify({ type: "final", text: extracted.text }));
            } else {
              await appendRealtimeInterimText(params.id, extracted.text);
              socket.send(JSON.stringify({ type: "interim", text: extracted.text }));
            }
            return;
          }
        }
        socket.send(JSON.stringify({ type: "raw", payload: raw }));
      });

      upstream.on("error", async (error: Error) => {
        socket.send(JSON.stringify({ type: "error", message: String(error) }));
        await closeAll(String(error));
      });

      upstream.on("close", async () => {
        await closeAll();
      });

      socket.on("message", (raw: RawData) => {
        const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(text) as Record<string, unknown>;
        } catch {
          return;
        }
        if (payload.type === "audio_chunk" && typeof payload.audio_base64 === "string") {
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(
              JSON.stringify({
                type: "input_audio_buffer.append",
                audio: payload.audio_base64
              })
            );
          }
          return;
        }
        if (payload.type === "stop") {
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            upstream.send(JSON.stringify({ type: "response.create" }));
          }
          return;
        }
        if (payload.type === "raw_event" && payload.event) {
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(JSON.stringify(payload.event));
          }
        }
      });

      socket.on("close", () => {
        void closeAll();
      });
    })().catch((error) => {
      socket.send(JSON.stringify({ type: "error", message: String(error) }));
      socket.close();
    });
  }
);

app.post("/recordings", async (req) => {
  const body = z
    .object({
      title: z.string().min(1),
      started_at: z.string(),
      duration_ms: z.number().int().positive()
    })
    .parse(req.body);

  const result = await pool.query(
    `INSERT INTO recordings (user_id, title, started_at, duration_ms, status)
     VALUES ($1, $2, $3::timestamptz, $4, 'recorded')
     RETURNING id`,
    [req.userCtx.sub, body.title, body.started_at, body.duration_ms]
  );

  return { id: result.rows[0]?.id };
});

app.post("/recordings/:id/upload-url", async (req, reply) => {
  const params = z.object({ id: z.string().uuid() }).parse(req.params);
  const body = z.object({ mime_type: z.string().min(1) }).parse(req.body);
  const exists = await pool.query<{ id: string }>(
    "SELECT id FROM recordings WHERE id = $1 AND user_id = $2",
    [params.id, req.userCtx.sub]
  );
  if (!exists.rowCount) {
    return reply.notFound("Recording not found");
  }
  const { objectKey, uploadUrl } = await createAudioUploadUrl(params.id, body.mime_type);
  await pool.query(
    "UPDATE recordings SET audio_object_key = $1, status = 'uploading' WHERE id = $2",
    [objectKey, params.id]
  );
  return { object_key: objectKey, upload_url: uploadUrl };
});

app.post("/recordings/:id/transcribe", async (req, reply) => {
  const params = z.object({ id: z.string().uuid() }).parse(req.params);
  const sttSettings = await getRawAiSettings(req.userCtx.sub);
  if (sttSettings.stt_provider === "qwen3-asr" && (sttSettings.stt_file_model ?? "").includes("realtime")) {
    return reply.badRequest(
      "当前 STT 文件模型是 realtime，仅支持“实时转写”模式，请改用非 realtime 文件模型后再上传转写。"
    );
  }
  const row = await pool.query<{ audio_object_key: string | null; status: string }>(
    "SELECT audio_object_key, status FROM recordings WHERE id = $1 AND user_id = $2",
    [params.id, req.userCtx.sub]
  );
  if (!row.rowCount) {
    return reply.notFound("Recording not found");
  }
  if (!row.rows[0]?.audio_object_key) {
    return reply.badRequest("Audio not uploaded");
  }
  const existingTranscript = await pool.query<{ id: string }>(
    "SELECT id FROM transcripts WHERE recording_id = $1",
    [params.id]
  );
  if (existingTranscript.rowCount) {
    await pool.query("UPDATE recordings SET status = 'transcribed', failed_reason = NULL WHERE id = $1", [
      params.id
    ]);
    try {
      await persistMeetingNoteForRecording(params.id, req.userCtx.sub, "upload");
    } catch (noteError) {
      req.log.error(noteError, "failed to persist meeting note for existing transcript");
    }
    return { queued: false, already_transcribed: true };
  }
  if (row.rows[0]?.status === "transcribing" || row.rows[0]?.status === "queued") {
    return { queued: true, already_queued: true };
  }

  await pool.query("UPDATE recordings SET status = 'queued' WHERE id = $1", [params.id]);
  await transcribeQueue.add(
    "transcribe-recording",
    { recordingId: params.id, userId: req.userCtx.sub },
    { attempts: 3, backoff: { type: "exponential", delay: 3000 }, jobId: `transcribe-${params.id}` }
  );
  return { queued: true };
});

app.get("/recordings", async (req) => {
  const query = z.object({ date: z.string() }).parse(req.query);
  const rows = await pool.query(
    `SELECT id, title, started_at, duration_ms, status, created_at
     FROM recordings
     WHERE user_id = $1 AND DATE(started_at AT TIME ZONE 'UTC') = $2::date
     ORDER BY started_at ASC`,
    [req.userCtx.sub, query.date]
  );
  return rows.rows;
});

app.get("/transcripts", async (req) => {
  const query = z.object({ date: z.string() }).parse(req.query);
  const rows = await pool.query(
    `SELECT t.id, t.recording_id, t.text, t.language, t.created_at
     FROM transcripts t
     INNER JOIN recordings r ON r.id = t.recording_id
     WHERE r.user_id = $1 AND DATE(r.started_at AT TIME ZONE 'UTC') = $2::date
     ORDER BY r.started_at ASC`,
    [req.userCtx.sub, query.date]
  );
  return rows.rows;
});

app.get("/meeting-notes", async (req) => {
  const query = z.object({ date: z.string() }).parse(req.query);
  return listMeetingNotesByDate(req.userCtx.sub, query.date);
});

app.get("/meeting-notes/:id", async (req, reply) => {
  const params = z.object({ id: z.string().uuid() }).parse(req.params);
  const row = await getMeetingNoteById(req.userCtx.sub, params.id);
  if (!row) {
    return reply.notFound("Meeting note not found");
  }
  return row;
});

app.post("/meeting-notes/:recordingId/regenerate", async (req, reply) => {
  const params = z.object({ recordingId: z.string().uuid() }).parse(req.params);
  const recording = await pool.query<{ id: string }>("SELECT id FROM recordings WHERE id = $1 AND user_id = $2", [
    params.recordingId,
    req.userCtx.sub
  ]);
  if (!recording.rowCount) {
    return reply.notFound("Recording not found");
  }
  const source = await getRecordingSource(req.userCtx.sub, params.recordingId);
  await persistMeetingNoteForRecording(params.recordingId, req.userCtx.sub, source);
  const note = await pool.query<{ id: string }>(
    "SELECT id FROM meeting_notes WHERE user_id = $1 AND recording_id = $2 LIMIT 1",
    [req.userCtx.sub, params.recordingId]
  );
  return { ok: true, note_id: note.rows[0]?.id ?? null };
});

app.get("/recordings/:id/status", async (req, reply) => {
  const params = z.object({ id: z.string().uuid() }).parse(req.params);
  const row = await pool.query<{ status: string; failed_reason: string | null }>(
    "SELECT status, failed_reason FROM recordings WHERE id = $1 AND user_id = $2",
    [params.id, req.userCtx.sub]
  );
  if (!row.rowCount) {
    return reply.notFound("Recording not found");
  }
  return row.rows[0];
});

app.post("/daily-summaries", async (req) => {
  const body = z
    .object({
      date: z.string(),
      trigger: z.enum(["manual", "auto_20", "auto_2330"]).default("manual")
    })
    .parse(req.body);
  await dailySummaryQueue.add(
    "generate-daily-summary",
    { userId: req.userCtx.sub, date: body.date, trigger: body.trigger },
    {
      attempts: 2,
      backoff: { type: "exponential", delay: 3000 }
    }
  );
  return { queued: true };
});

app.get("/daily-summaries", async (req) => {
  const query = z.object({ date: z.string() }).parse(req.query);
  const row = await pool.query(
    `SELECT id, date, report_md, tasks_json, created_at, storage_path, checksum, last_error, trigger
     FROM daily_summaries
     WHERE user_id = $1 AND date = $2::date
     ORDER BY created_at DESC
     LIMIT 1`,
    [req.userCtx.sub, query.date]
  );
  return row.rows[0] ?? null;
});

app.post("/daily-summaries/:date/regenerate", async (req) => {
  const params = z.object({ date: z.string() }).parse(req.params);
  await dailySummaryQueue.add(
    "generate-daily-summary",
    { userId: req.userCtx.sub, date: params.date, trigger: "manual" as const },
    {
      attempts: 2,
      backoff: { type: "exponential", delay: 3000 }
    }
  );
  return { queued: true };
});

app.get("/tasks", async (req) => {
  const query = z.object({ date: z.string().optional() }).parse(req.query);
  let result;
  if (query.date) {
    result = await pool.query<TaskRow>(
      "SELECT * FROM tasks WHERE user_id = $1 AND DATE(created_at AT TIME ZONE 'UTC') = $2::date ORDER BY created_at DESC",
      [req.userCtx.sub, query.date]
    );
  } else {
    result = await pool.query<TaskRow>(
      "SELECT * FROM tasks WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200",
      [req.userCtx.sub]
    );
  }
  return result.rows;
});

app.post("/tasks", async (req) => {
  const body = taskPayloadSchema.parse(req.body);
  const row = await pool.query<TaskRow>(
    `INSERT INTO tasks (user_id, title, notes, priority, status, due_date, estimate_min, source_summary_id)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8)
     RETURNING *`,
    [
      req.userCtx.sub,
      body.title,
      body.notes ?? null,
      body.priority,
      body.status,
      body.due_date ?? null,
      body.estimate_min ?? null,
      body.source_summary_id ?? null
    ]
  );
  return row.rows[0];
});

app.patch("/tasks/:id", async (req, reply) => {
  const params = z.object({ id: z.string().uuid() }).parse(req.params);
  const body = taskPayloadSchema.partial().parse(req.body);
  if (!Object.keys(body).length) {
    return reply.badRequest("No fields to update");
  }
  const patch = {
    title: body.title ?? null,
    notes: body.notes ?? null,
    priority: body.priority ?? null,
    status: body.status ?? null,
    due_date: body.due_date ?? null,
    estimate_min: body.estimate_min ?? null
  };
  const row = await pool.query<TaskRow>(
    `UPDATE tasks
     SET title = COALESCE($3, title),
         notes = COALESCE($4, notes),
         priority = COALESCE($5, priority),
         status = COALESCE($6, status),
         due_date = COALESCE($7::date, due_date),
         estimate_min = COALESCE($8, estimate_min)
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [
      params.id,
      req.userCtx.sub,
      patch.title,
      patch.notes,
      patch.priority,
      patch.status,
      patch.due_date,
      patch.estimate_min
    ]
  );
  if (!row.rowCount) {
    return reply.notFound("Task not found");
  }
  return row.rows[0];
});

app.delete("/tasks/:id", async (req, reply) => {
  const params = z.object({ id: z.string().uuid() }).parse(req.params);
  const result = await pool.query("DELETE FROM tasks WHERE id = $1 AND user_id = $2", [
    params.id,
    req.userCtx.sub
  ]);
  if (!result.rowCount) {
    return reply.notFound("Task not found");
  }
  return { ok: true };
});

const start = async () => {
  try {
    await ensureMeetingNotesTableExists();
    await ensureDailySummarySchemaExists();
    await app.listen({ port: config.PORT, host: config.HOST });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

await start();
