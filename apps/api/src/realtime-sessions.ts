import { pool } from "./db.js";

const ensureRealtimeTableSql = `
CREATE TABLE IF NOT EXISTS realtime_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stt_provider TEXT NOT NULL,
  stt_model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  interim_text TEXT NOT NULL DEFAULT '',
  final_text TEXT,
  error TEXT,
  fallback_recording_id UUID REFERENCES recordings(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT realtime_sessions_status_check CHECK (status IN ('running', 'finished', 'failed', 'fallback'))
)`;

let ensurePromise: Promise<void> | null = null;

async function ensureRealtimeSessionTable() {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await pool.query(ensureRealtimeTableSql);
      await pool.query(
        "CREATE INDEX IF NOT EXISTS idx_realtime_sessions_user_started ON realtime_sessions(user_id, started_at DESC)"
      );
    })().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  await ensurePromise;
}

export async function ensureRealtimeSessionTableExists() {
  await ensureRealtimeSessionTable();
}

export type RealtimeSessionRow = {
  id: string;
  user_id: string;
  stt_provider: string;
  stt_model: string;
  status: "running" | "finished" | "failed" | "fallback";
  started_at: string;
  ended_at: string | null;
  interim_text: string;
  final_text: string | null;
  error: string | null;
  fallback_recording_id: string | null;
};

export async function createRealtimeSession(userId: string, sttProvider: string, sttModel: string) {
  await ensureRealtimeSessionTable();
  const row = await pool.query<RealtimeSessionRow>(
    `INSERT INTO realtime_sessions (user_id, stt_provider, stt_model, status)
     VALUES ($1, $2, $3, 'running')
     RETURNING *`,
    [userId, sttProvider, sttModel]
  );
  return row.rows[0] as RealtimeSessionRow;
}

export async function getRealtimeSessionForUser(sessionId: string, userId: string) {
  await ensureRealtimeSessionTable();
  const row = await pool.query<RealtimeSessionRow>(
    "SELECT * FROM realtime_sessions WHERE id = $1 AND user_id = $2",
    [sessionId, userId]
  );
  return row.rows[0] ?? null;
}

export async function appendRealtimeInterimText(sessionId: string, text: string) {
  await ensureRealtimeSessionTable();
  await pool.query(
    `UPDATE realtime_sessions
     SET interim_text = CASE
         WHEN interim_text = '' THEN $2
         ELSE interim_text || E'\n' || $2
       END,
       updated_at = now()
     WHERE id = $1`,
    [sessionId, text]
  );
}

export async function setRealtimeFinalText(sessionId: string, text: string) {
  await ensureRealtimeSessionTable();
  await pool.query(
    "UPDATE realtime_sessions SET final_text = $2, updated_at = now() WHERE id = $1",
    [sessionId, text]
  );
}

export async function markRealtimeFailed(sessionId: string, reason: string) {
  await ensureRealtimeSessionTable();
  await pool.query(
    `UPDATE realtime_sessions
     SET status = 'failed', error = $2, ended_at = now(), updated_at = now()
     WHERE id = $1`,
    [sessionId, reason]
  );
}

export async function markRealtimeFallback(
  sessionId: string,
  reason: string,
  fallbackRecordingId: string | null
) {
  await ensureRealtimeSessionTable();
  await pool.query(
    `UPDATE realtime_sessions
     SET status = 'fallback',
         error = $2,
         fallback_recording_id = COALESCE($3, fallback_recording_id),
         ended_at = now(),
         updated_at = now()
     WHERE id = $1`,
    [sessionId, reason, fallbackRecordingId]
  );
}

export async function finishRealtimeSessionAndPersist(sessionId: string, userId: string) {
  await ensureRealtimeSessionTable();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sessionRes = await client.query<RealtimeSessionRow>(
      "SELECT * FROM realtime_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [sessionId, userId]
    );
    const session = sessionRes.rows[0];
    if (!session) {
      throw new Error("Realtime session not found");
    }
    if (session.status === "finished" && session.fallback_recording_id) {
      await client.query("COMMIT");
      return {
        session,
        recordingId: session.fallback_recording_id,
        transcriptText: session.final_text ?? session.interim_text
      };
    }
    const text = (session.final_text?.trim() || session.interim_text?.trim() || "").trim();
    if (!text) {
      throw new Error("Realtime session has no transcript text");
    }
    const now = new Date();
    const startedAt = new Date(session.started_at);
    const durationMs = Math.max(1_000, now.getTime() - startedAt.getTime());
    const recordingRes = await client.query<{ id: string }>(
      `INSERT INTO recordings (user_id, title, started_at, duration_ms, status, failed_reason)
       VALUES ($1, $2, $3::timestamptz, $4, 'transcribed', NULL)
       RETURNING id`,
      [userId, `实时录音 ${now.toLocaleString()}`, session.started_at, durationMs]
    );
    const recordingId = recordingRes.rows[0]?.id;
    if (!recordingId) {
      throw new Error("Failed to create recording for realtime session");
    }
    await client.query(
      `INSERT INTO transcripts (recording_id, text, language, stt_model, stt_meta_json)
       VALUES ($1, $2, 'zh', $3, $4::jsonb)
       ON CONFLICT (recording_id) DO UPDATE SET text = EXCLUDED.text, stt_meta_json = EXCLUDED.stt_meta_json`,
      [
        recordingId,
        text,
        session.stt_model,
        JSON.stringify({ provider: session.stt_provider, realtime: true })
      ]
    );
    await client.query(
      `UPDATE realtime_sessions
       SET status = 'finished',
           final_text = $2,
           fallback_recording_id = $3,
           ended_at = now(),
           updated_at = now()
       WHERE id = $1`,
      [sessionId, text, recordingId]
    );
    await client.query("COMMIT");
    return { session, recordingId, transcriptText: text };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
