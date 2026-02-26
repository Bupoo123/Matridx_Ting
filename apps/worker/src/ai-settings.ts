import { pool } from "./db.js";
import { config } from "./config.js";

const ensureAiSettingsTableSql = `
CREATE TABLE IF NOT EXISTS ai_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  stt_provider TEXT NOT NULL DEFAULT 'openai',
  stt_api_key TEXT,
  stt_model TEXT NOT NULL DEFAULT 'gpt-4o-mini-transcribe',
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
      await pool.query("CREATE INDEX IF NOT EXISTS idx_ai_settings_user ON ai_settings(user_id)");
    })().catch((error) => {
      ensureTablePromise = null;
      throw error;
    });
  }
  await ensureTablePromise;
}

export type RuntimeModelConfig = {
  provider: "openai" | "openrouter" | "seed-asr" | "qwen3-asr";
  apiKey: string | null;
  model: string;
};

type SettingsRow = {
  stt_provider: "openai" | "openrouter" | "seed-asr" | "qwen3-asr";
  stt_api_key: string | null;
  stt_model: string;
  analysis_provider: "openai" | "openrouter";
  analysis_api_key: string | null;
  analysis_model: string;
};

export async function getRuntimeModelSettings(userId: string): Promise<{
  stt: RuntimeModelConfig;
  analysis: RuntimeModelConfig;
}> {
  await ensureAiSettingsTableExists();
  const rowResult = await pool.query<SettingsRow>(
    `SELECT stt_provider, stt_api_key, stt_model, analysis_provider, analysis_api_key, analysis_model
     FROM ai_settings
     WHERE user_id = $1`,
    [userId]
  );
  const row = rowResult.rows[0];

  const sttProvider =
    row?.stt_provider ??
    (config.STT_PROVIDER === "openrouter" ||
    config.STT_PROVIDER === "seed-asr" ||
    config.STT_PROVIDER === "qwen3-asr"
      ? config.STT_PROVIDER
      : "openai");
  const analysisProvider =
    row?.analysis_provider ?? (config.LLM_PROVIDER === "openrouter" ? "openrouter" : "openai");

  return {
    stt: {
      provider: sttProvider,
      apiKey: row?.stt_api_key ?? config.STT_API_KEY ?? null,
      model: row?.stt_model ?? "gpt-4o-mini-transcribe"
    },
    analysis: {
      provider: analysisProvider,
      apiKey: row?.analysis_api_key ?? config.LLM_API_KEY ?? null,
      model: row?.analysis_model ?? "gpt-4.1-mini"
    }
  };
}
