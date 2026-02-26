import bcrypt from "bcryptjs";
import cors from "@fastify/cors";
import fastifyJwt from "@fastify/jwt";
import sensible from "@fastify/sensible";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { aiSettingsUpdateSchema, taskPrioritySchema, taskStatusSchema } from "@matridx/shared";
import { config } from "./config.js";
import { pool } from "./db.js";
import { createAudioUploadUrl } from "./s3.js";
import { dailySummaryQueue, transcribeQueue } from "./queue.js";
import {
  getAiSettingsForUser,
  getRawAiSettingsForUser,
  updateAiSettingsForUser
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
  return authGuard(req, reply);
});

app.get("/settings/ai", async (req) => {
  return getAiSettingsForUser(req.userCtx.sub);
});

app.put("/settings/ai", async (req) => {
  const body = aiSettingsUpdateSchema.parse(req.body);
  return updateAiSettingsForUser(req.userCtx.sub, body);
});

app.post("/settings/ai/test-stt", async (req, reply) => {
  const body = aiSettingsUpdateSchema.partial().parse(req.body ?? {});
  const current = await getRawAiSettingsForUser(req.userCtx.sub);
  const provider = body.stt_provider ?? current.stt_provider;
  const model = body.stt_model ?? current.stt_model;
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
  try {
    await testSttProvider(provider, apiKey ?? "", model);
    return { ok: true };
  } catch (error) {
    return reply.badRequest(`STT 测试失败: ${String(error)}`);
  }
});

app.post("/settings/ai/test-analysis", async (req, reply) => {
  const body = aiSettingsUpdateSchema.partial().parse(req.body ?? {});
  const current = await getRawAiSettingsForUser(req.userCtx.sub);
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
  const row = await pool.query<{ audio_object_key: string | null }>(
    "SELECT audio_object_key FROM recordings WHERE id = $1 AND user_id = $2",
    [params.id, req.userCtx.sub]
  );
  if (!row.rowCount) {
    return reply.notFound("Recording not found");
  }
  if (!row.rows[0]?.audio_object_key) {
    return reply.badRequest("Audio not uploaded");
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
  const body = z.object({ date: z.string() }).parse(req.body);
  await dailySummaryQueue.add(
    "generate-daily-summary",
    { userId: req.userCtx.sub, date: body.date },
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
    `SELECT id, date, report_md, tasks_json, created_at
     FROM daily_summaries
     WHERE user_id = $1 AND date = $2::date
     ORDER BY created_at DESC
     LIMIT 1`,
    [req.userCtx.sub, query.date]
  );
  return row.rows[0] ?? null;
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
    await app.listen({ port: config.PORT, host: config.HOST });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

await start();
