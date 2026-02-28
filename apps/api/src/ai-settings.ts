import { aiSettingsSchema, type AiSettingsUpdate, type AiSettingsView } from "@matridx/shared";
import { pool } from "./db.js";

const ensureAiSettingsTableSql = `
CREATE TABLE IF NOT EXISTS ai_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  stt_provider TEXT NOT NULL DEFAULT 'openai',
  stt_api_key TEXT,
  stt_model TEXT,
  stt_file_model TEXT NOT NULL DEFAULT 'gpt-4o-mini-transcribe',
  stt_realtime_model TEXT NOT NULL DEFAULT 'qwen3-asr-flash-realtime',
  analysis_provider TEXT NOT NULL DEFAULT 'openai',
  analysis_api_key TEXT,
  analysis_model TEXT NOT NULL DEFAULT 'gpt-4.1-mini',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_settings_stt_provider_check CHECK (stt_provider IN ('openai', 'openrouter', 'seed-asr', 'qwen3-asr')),
  CONSTRAINT ai_settings_analysis_provider_check CHECK (analysis_provider IN ('openai', 'openrouter'))
)`;

let ensureTablePromise: Promise<void> | null = null;

async function ensureAiSettingsTableExists() {
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      await pool.query(ensureAiSettingsTableSql);
      await pool.query("ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS stt_file_model TEXT");
      await pool.query("ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS stt_realtime_model TEXT");
      await pool.query(
        "UPDATE ai_settings SET stt_file_model = COALESCE(stt_file_model, stt_model, 'gpt-4o-mini-transcribe')"
      );
      await pool.query(
        "UPDATE ai_settings SET stt_realtime_model = COALESCE(stt_realtime_model, 'qwen3-asr-flash-realtime')"
      );
      await pool.query(
        "ALTER TABLE ai_settings ALTER COLUMN stt_file_model SET DEFAULT 'gpt-4o-mini-transcribe'"
      );
      await pool.query(
        "ALTER TABLE ai_settings ALTER COLUMN stt_realtime_model SET DEFAULT 'qwen3-asr-flash-realtime'"
      );
      await pool.query("CREATE INDEX IF NOT EXISTS idx_ai_settings_user ON ai_settings(user_id)");
    })().catch((error) => {
      ensureTablePromise = null;
      throw error;
    });
  }
  await ensureTablePromise;
}

type AiSettingsRow = {
  stt_provider: "openai" | "openrouter" | "seed-asr" | "qwen3-asr";
  stt_api_key: string | null;
  stt_file_model: string;
  stt_realtime_model: string;
  analysis_provider: "openai" | "openrouter";
  analysis_api_key: string | null;
  analysis_model: string;
};

async function ensureSettingsRow(userId: string): Promise<AiSettingsRow> {
  await ensureAiSettingsTableExists();
  const inserted = await pool.query<AiSettingsRow>(
    `INSERT INTO ai_settings (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING
     RETURNING stt_provider, stt_api_key, stt_file_model, stt_realtime_model, analysis_provider, analysis_api_key, analysis_model`,
    [userId]
  );
  if (inserted.rowCount) {
    return inserted.rows[0] as AiSettingsRow;
  }

  const existing = await pool.query<AiSettingsRow>(
    `SELECT stt_provider, stt_api_key, stt_file_model, stt_realtime_model, analysis_provider, analysis_api_key, analysis_model
     FROM ai_settings
     WHERE user_id = $1`,
    [userId]
  );
  if (!existing.rowCount) {
    throw new Error("Unable to resolve AI settings");
  }
  return existing.rows[0] as AiSettingsRow;
}

export function toAiSettingsView(row: AiSettingsRow): AiSettingsView {
  return aiSettingsSchema.parse({
    stt_provider: row.stt_provider,
    stt_file_model: row.stt_file_model,
    stt_realtime_model: row.stt_realtime_model,
    stt_api_key_configured: Boolean(row.stt_api_key),
    analysis_provider: row.analysis_provider,
    analysis_model: row.analysis_model,
    analysis_api_key_configured: Boolean(row.analysis_api_key)
  });
}

export async function getAiSettingsForUser(userId: string): Promise<AiSettingsView> {
  const row = await ensureSettingsRow(userId);
  return toAiSettingsView(row);
}

export async function getRawAiSettingsForUser(userId: string): Promise<AiSettingsRow> {
  return ensureSettingsRow(userId);
}

export async function updateAiSettingsForUser(userId: string, patch: AiSettingsUpdate): Promise<AiSettingsView> {
  const current = await ensureSettingsRow(userId);
  const legacyModel = patch.stt_model;
  const next = {
    stt_provider: patch.stt_provider ?? current.stt_provider,
    stt_file_model:
      patch.stt_file_model ?? (legacyModel && !legacyModel.includes("realtime") ? legacyModel : current.stt_file_model),
    stt_realtime_model:
      patch.stt_realtime_model ??
      (legacyModel && legacyModel.includes("realtime") ? legacyModel : current.stt_realtime_model),
    stt_api_key:
      patch.clear_stt_api_key === true
        ? null
        : patch.stt_api_key !== undefined
          ? patch.stt_api_key
          : current.stt_api_key,
    analysis_provider: patch.analysis_provider ?? current.analysis_provider,
    analysis_model: patch.analysis_model ?? current.analysis_model,
    analysis_api_key:
      patch.clear_analysis_api_key === true
        ? null
        : patch.analysis_api_key !== undefined
          ? patch.analysis_api_key
          : current.analysis_api_key
  };
  const updated = await pool.query<AiSettingsRow>(
    `UPDATE ai_settings
     SET stt_provider = $2,
         stt_file_model = $3,
         stt_realtime_model = $4,
         stt_api_key = $5,
         analysis_provider = $6,
         analysis_model = $7,
         analysis_api_key = $8,
         updated_at = now()
     WHERE user_id = $1
     RETURNING stt_provider, stt_api_key, stt_file_model, stt_realtime_model, analysis_provider, analysis_api_key, analysis_model`,
    [
      userId,
      next.stt_provider,
      next.stt_file_model,
      next.stt_realtime_model,
      next.stt_api_key,
      next.analysis_provider,
      next.analysis_model,
      next.analysis_api_key
    ]
  );
  return toAiSettingsView(updated.rows[0] as AiSettingsRow);
}
