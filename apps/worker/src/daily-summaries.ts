import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Queue } from "bullmq";
import {
  dailySummarySchema,
  renderDailySummaryMarkdown,
  slugifyContributor,
  toUtcDateParts,
  type DailySummaryTrigger
} from "@matridx/shared";
import { config } from "./config.js";
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

export function buildNoMeetingDailySummary() {
  return dailySummarySchema.parse({
    abstract: "今日无会议记录。",
    progress: [],
    issues: [],
    todos: [],
    tomorrow_plan: [],
    tasks: [],
    time_blocks: []
  });
}

function buildDailySummaryRelativePath(date: string, username: string) {
  const dateParts = toUtcDateParts(`${date}T00:00:00.000Z`);
  const usernameSlug = slugifyContributor(username);
  return `daily-summaries/${dateParts.year}/${dateParts.month}/${dateParts.day}/${dateParts.ymd}-${usernameSlug}.md`;
}

function renderDailySummaryFileMarkdown(input: {
  date: string;
  username: string;
  trigger: DailySummaryTrigger;
  generatedAt: string;
  llmModel: string;
  reportMd: string;
}) {
  const frontmatter = [
    "---",
    `date: "${input.date}"`,
    `user: "${input.username.replace(/"/g, '\\"')}"`,
    `trigger: "${input.trigger}"`,
    `generated_at: "${input.generatedAt}"`,
    `llm_model: "${input.llmModel.replace(/"/g, '\\"')}"`,
    "---",
    ""
  ].join("\n");
  return `${frontmatter}${input.reportMd}\n`;
}

async function writeAtomicFile(relativePath: string, content: string) {
  const absolutePath = join(config.NOTES_STORAGE_ROOT, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  const tempPath = `${absolutePath}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, absolutePath);
}

export async function persistDailySummaryFile(input: {
  userId: string;
  username: string;
  date: string;
  reportMd: string;
  llmModel: string;
  trigger: DailySummaryTrigger;
}) {
  const generatedAt = new Date().toISOString();
  const relativePath = buildDailySummaryRelativePath(input.date, input.username);
  const content = renderDailySummaryFileMarkdown({
    date: input.date,
    username: input.username,
    trigger: input.trigger,
    generatedAt,
    llmModel: input.llmModel,
    reportMd: input.reportMd
  });
  const checksum = createHash("sha256").update(content).digest("hex");
  let fileError: string | null = null;
  try {
    await writeAtomicFile(relativePath, content);
  } catch (error) {
    fileError = String(error);
  }
  return {
    storagePath: fileError ? null : relativePath,
    checksum: fileError ? null : checksum,
    lastError: fileError
  };
}

type UserTzRow = {
  id: string;
  tz: string | null;
};

function getTimePartsAtTimezone(date: Date, timeZone: string): { date: string; hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const parts = formatter.formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return {
    date: `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`,
    hour: Number(byType.get("hour") ?? "0"),
    minute: Number(byType.get("minute") ?? "0")
  };
}

type ScheduleSlot = {
  slot: "20:00" | "23:30";
  trigger: DailySummaryTrigger;
  hour: number;
  minute: number;
};

const scheduleSlots: ScheduleSlot[] = [
  { slot: "20:00", trigger: "auto_20", hour: 20, minute: 0 },
  { slot: "23:30", trigger: "auto_2330", hour: 23, minute: 30 }
];

export async function enqueueAutoDailySummaryRuns(now = new Date()) {
  await ensureDailySummarySchemaExists();
  const users = await pool.query<UserTzRow>("SELECT id, tz FROM users");
  if (!users.rowCount) return;
  const queue = new Queue("daily-summary", { connection: { url: config.REDIS_URL } });
  try {
    for (const user of users.rows) {
      const tz = user.tz || "Asia/Shanghai";
      let localTime: { date: string; hour: number; minute: number };
      try {
        localTime = getTimePartsAtTimezone(now, tz);
      } catch {
        localTime = getTimePartsAtTimezone(now, "Asia/Shanghai");
      }
      for (const slot of scheduleSlots) {
        if (localTime.hour !== slot.hour || localTime.minute !== slot.minute) {
          continue;
        }
        const inserted = await pool.query<{ id: string }>(
          `INSERT INTO daily_summary_runs (user_id, date, slot)
           VALUES ($1, $2::date, $3)
           ON CONFLICT (user_id, date, slot) DO NOTHING
           RETURNING id`,
          [user.id, localTime.date, slot.slot]
        );
        if (!inserted.rowCount) continue;
        try {
          await queue.add(
            "generate-daily-summary",
            { userId: user.id, date: localTime.date, trigger: slot.trigger },
            {
              attempts: 2,
              backoff: { type: "exponential", delay: 3000 },
              jobId: `auto-summary-${user.id}-${localTime.date}-${slot.slot.replace(":", "")}`
            }
          );
        } catch (error) {
          await pool.query("DELETE FROM daily_summary_runs WHERE id = $1", [inserted.rows[0]?.id]).catch(() => undefined);
          throw error;
        }
      }
    }
  } finally {
    await queue.close();
  }
}
