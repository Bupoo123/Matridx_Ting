import { pool } from "./db.js";

let ensurePromise: Promise<void> | null = null;

export async function ensureDailySummarySchemaExists() {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await pool.query("ALTER TABLE daily_summaries ADD COLUMN IF NOT EXISTS storage_path TEXT");
      await pool.query("ALTER TABLE daily_summaries ADD COLUMN IF NOT EXISTS checksum TEXT");
      await pool.query("ALTER TABLE daily_summaries ADD COLUMN IF NOT EXISTS last_error TEXT");
      await pool.query("ALTER TABLE daily_summaries ADD COLUMN IF NOT EXISTS trigger TEXT");
      await pool.query("UPDATE daily_summaries SET trigger = 'manual' WHERE trigger IS NULL");
      await pool.query("ALTER TABLE daily_summaries ALTER COLUMN trigger SET DEFAULT 'manual'");
      await pool.query(
        "ALTER TABLE daily_summaries ADD CONSTRAINT daily_summaries_trigger_check CHECK (trigger IN ('manual', 'auto_20', 'auto_2330'))"
      ).catch(() => undefined);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS daily_summary_runs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          date DATE NOT NULL,
          slot TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT daily_summary_runs_slot_check CHECK (slot IN ('20:00', '23:30')),
          CONSTRAINT daily_summary_runs_user_date_slot_unique UNIQUE (user_id, date, slot)
        )
      `);
      await pool.query("CREATE INDEX IF NOT EXISTS idx_daily_summary_runs_created_at ON daily_summary_runs(created_at DESC)");
    })().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  await ensurePromise;
}
