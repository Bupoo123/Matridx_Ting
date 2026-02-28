import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  makeMeetingNoteSummary,
  renderMeetingNoteMarkdown,
  slugifyContributor,
  toUtcDateParts,
  type MeetingNoteSource
} from "@matridx/shared";
import { config } from "./config.js";
import { pool } from "./db.js";

const ensureMeetingNotesTableSql = `
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
)`;

let ensureTablePromise: Promise<void> | null = null;

export async function ensureMeetingNotesTableExists() {
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      await pool.query(ensureMeetingNotesTableSql);
      await pool.query("ALTER TABLE meeting_notes ADD COLUMN IF NOT EXISTS last_error TEXT");
      await pool.query("ALTER TABLE meeting_notes ADD COLUMN IF NOT EXISTS tags_json JSONB NOT NULL DEFAULT '[]'::jsonb");
      await pool.query("CREATE INDEX IF NOT EXISTS idx_meeting_notes_user_recorded ON meeting_notes(user_id, recorded_at DESC)");
    })().catch((error) => {
      ensureTablePromise = null;
      throw error;
    });
  }
  await ensureTablePromise;
}

function buildRelativePath(recordedAt: string, contributor: string, recordingId: string): string {
  const dateParts = toUtcDateParts(recordedAt);
  const contributorSlug = slugifyContributor(contributor);
  const fileName = `${dateParts.ymd}-${dateParts.hms}-${contributorSlug}-${recordingId.slice(0, 8)}.md`;
  return `${dateParts.year}/${dateParts.month}/${dateParts.day}/${fileName}`;
}

async function writeMeetingNoteFile(relativePath: string, markdown: string) {
  const absolutePath = join(config.NOTES_STORAGE_ROOT, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  const tempPath = `${absolutePath}.tmp`;
  await writeFile(tempPath, markdown, "utf8");
  await rename(tempPath, absolutePath);
}

type PersistRow = {
  note_id: string | null;
  username: string;
  recording_title: string;
  started_at: string;
  transcript_text: string;
  stt_model: string | null;
};

export async function persistMeetingNoteForRecording(
  recordingId: string,
  userId: string,
  source: MeetingNoteSource
): Promise<void> {
  await ensureMeetingNotesTableExists();
  const rowResult = await pool.query<PersistRow>(
    `SELECT
        n.id AS note_id,
        u.username,
        r.title AS recording_title,
        r.started_at,
        t.text AS transcript_text,
        t.stt_model
     FROM recordings r
     INNER JOIN users u ON u.id = r.user_id
     INNER JOIN transcripts t ON t.recording_id = r.id
     LEFT JOIN meeting_notes n ON n.recording_id = r.id
     WHERE r.id = $1 AND r.user_id = $2`,
    [recordingId, userId]
  );
  const row = rowResult.rows[0];
  if (!row) {
    throw new Error("Cannot build meeting note without recording/transcript");
  }

  const recordedAtIso = new Date(row.started_at).toISOString();
  const dateParts = toUtcDateParts(recordedAtIso);
  const noteId = row.note_id ?? randomUUID();
  const summary = makeMeetingNoteSummary(row.transcript_text);
  const title = row.recording_title?.trim() || `会议笔记 ${dateParts.date} ${dateParts.time}`;
  const contributor = row.username || "unknown";
  const relativePath = buildRelativePath(recordedAtIso, contributor, recordingId);
  const createdAt = new Date().toISOString();
  const markdown = renderMeetingNoteMarkdown({
    noteId,
    recordingId,
    contributor,
    recordedAt: recordedAtIso,
    createdAt,
    source,
    language: "zh",
    sttModel: row.stt_model ?? "",
    title,
    summary,
    transcriptText: row.transcript_text
  });
  const checksum = createHash("sha256").update(markdown).digest("hex");
  let fileError: string | null = null;
  try {
    await writeMeetingNoteFile(relativePath, markdown);
  } catch (error) {
    fileError = String(error);
  }

  await pool.query(
    `INSERT INTO meeting_notes (
      id, user_id, recording_id, contributor, recorded_at, title, summary, transcript_text, source, storage_path, checksum, last_error, tags_json
    ) VALUES (
      $1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12, '[]'::jsonb
    )
    ON CONFLICT (recording_id)
    DO UPDATE SET
      contributor = EXCLUDED.contributor,
      recorded_at = EXCLUDED.recorded_at,
      title = EXCLUDED.title,
      summary = EXCLUDED.summary,
      transcript_text = EXCLUDED.transcript_text,
      source = EXCLUDED.source,
      storage_path = EXCLUDED.storage_path,
      checksum = EXCLUDED.checksum,
      last_error = EXCLUDED.last_error,
      updated_at = now()`,
    [
      noteId,
      userId,
      recordingId,
      contributor,
      recordedAtIso,
      title,
      summary,
      row.transcript_text,
      source,
      fileError ? null : relativePath,
      fileError ? null : checksum,
      fileError
    ]
  );
}

type MeetingNoteRow = {
  id: string;
  user_id: string;
  recording_id: string;
  contributor: string;
  recorded_at: string;
  date: string;
  time: string;
  title: string;
  summary: string;
  transcript_text: string;
  source: "upload" | "realtime";
  storage_path: string | null;
  checksum: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export async function listMeetingNotesByDate(userId: string, date: string): Promise<MeetingNoteRow[]> {
  await ensureMeetingNotesTableExists();
  const result = await pool.query<MeetingNoteRow>(
    `SELECT
        id, user_id, recording_id, contributor, recorded_at,
        TO_CHAR(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
        TO_CHAR(recorded_at AT TIME ZONE 'UTC', 'HH24:MI:SS') AS time,
        title, summary, transcript_text, source, storage_path, checksum, last_error, created_at, updated_at
     FROM meeting_notes
     WHERE user_id = $1 AND DATE(recorded_at AT TIME ZONE 'UTC') = $2::date
     ORDER BY recorded_at ASC`,
    [userId, date]
  );
  return result.rows;
}

export async function getMeetingNoteById(userId: string, noteId: string): Promise<MeetingNoteRow | null> {
  await ensureMeetingNotesTableExists();
  const result = await pool.query<MeetingNoteRow>(
    `SELECT
        id, user_id, recording_id, contributor, recorded_at,
        TO_CHAR(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
        TO_CHAR(recorded_at AT TIME ZONE 'UTC', 'HH24:MI:SS') AS time,
        title, summary, transcript_text, source, storage_path, checksum, last_error, created_at, updated_at
     FROM meeting_notes
     WHERE user_id = $1 AND id = $2
     LIMIT 1`,
    [userId, noteId]
  );
  return result.rows[0] ?? null;
}

export async function getRecordingSource(userId: string, recordingId: string): Promise<MeetingNoteSource> {
  const result = await pool.query<{ source: MeetingNoteSource }>(
    "SELECT source FROM meeting_notes WHERE user_id = $1 AND recording_id = $2 LIMIT 1",
    [userId, recordingId]
  );
  if (result.rowCount) {
    return result.rows[0]?.source ?? "upload";
  }
  return "upload";
}
