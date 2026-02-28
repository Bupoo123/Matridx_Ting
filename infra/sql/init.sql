CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  tz TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recordings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  duration_ms INTEGER NOT NULL,
  audio_object_key TEXT,
  status TEXT NOT NULL DEFAULT 'recorded',
  failed_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recordings_user_started_at ON recordings(user_id, started_at);

CREATE TABLE IF NOT EXISTS transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id UUID NOT NULL UNIQUE REFERENCES recordings(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'zh',
  stt_model TEXT,
  stt_meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS daily_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  report_md TEXT NOT NULL,
  tasks_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  llm_model TEXT,
  llm_meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  storage_path TEXT,
  checksum TEXT,
  last_error TEXT,
  trigger TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_daily_summaries_user_date ON daily_summaries(user_id, date, created_at DESC);

CREATE TABLE IF NOT EXISTS daily_summary_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  slot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT daily_summary_runs_slot_check CHECK (slot IN ('20:00', '23:30')),
  CONSTRAINT daily_summary_runs_user_date_slot_unique UNIQUE (user_id, date, slot)
);

CREATE INDEX IF NOT EXISTS idx_daily_summary_runs_created_at ON daily_summary_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT,
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'todo',
  due_date DATE,
  estimate_min INTEGER,
  source_summary_id UUID REFERENCES daily_summaries(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tasks_priority_check CHECK (priority IN ('low', 'medium', 'high')),
  CONSTRAINT tasks_status_check CHECK (status IN ('todo', 'doing', 'done'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_created ON tasks(user_id, created_at DESC);

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
);

CREATE INDEX IF NOT EXISTS idx_ai_settings_user ON ai_settings(user_id);

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
);

CREATE INDEX IF NOT EXISTS idx_realtime_sessions_user_started ON realtime_sessions(user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS meeting_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recording_id UUID NOT NULL UNIQUE REFERENCES recordings(id) ON DELETE CASCADE,
  contributor TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  transcript_text TEXT NOT NULL,
  source TEXT NOT NULL,
  storage_path TEXT,
  checksum TEXT,
  last_error TEXT,
  tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meeting_notes_source_check CHECK (source IN ('upload', 'realtime'))
);

CREATE INDEX IF NOT EXISTS idx_meeting_notes_user_recorded ON meeting_notes(user_id, recorded_at DESC);
