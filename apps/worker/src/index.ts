import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { QueueEvents, Worker } from "bullmq";
import { renderDailySummaryMarkdown, type DailySummaryTrigger } from "@matridx/shared";
import { config } from "./config.js";
import { pool } from "./db.js";
import { getRuntimeModelSettings } from "./ai-settings.js";
import {
  buildNoMeetingDailySummary,
  enqueueAutoDailySummaryRuns,
  ensureDailySummarySchemaExists,
  persistDailySummaryFile
} from "./daily-summaries.js";
import { ensureMeetingNotesTableExists, persistMeetingNoteForRecording } from "./meeting-notes.js";
import { generateDailySummaryFromText, transcribeAudio } from "./providers/openai.js";

const s3 = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY
  }
});

async function streamToBuffer(stream: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function createTemporaryObjectReadUrl(objectKey: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: objectKey
  });
  return getSignedUrl(s3, command, { expiresIn: 3600 });
}

const transcribeWorker = new Worker(
  "transcribe",
  async (job) => {
    const { recordingId, userId } = job.data as { recordingId: string; userId: string };
    const recordingRow = await pool.query<{
      id: string;
      audio_object_key: string | null;
      title: string;
      duration_ms: number;
    }>("SELECT id, audio_object_key, title, duration_ms FROM recordings WHERE id = $1 AND user_id = $2", [
      recordingId,
      userId
    ]);
    const recording = recordingRow.rows[0];
    if (!recording || !recording.audio_object_key) {
      throw new Error("Recording or audio object key not found");
    }

    await pool.query("UPDATE recordings SET status = 'transcribing', failed_reason = NULL WHERE id = $1", [
      recordingId
    ]);

    let transcribeSucceeded = false;
    try {
      const object = await s3.send(
        new GetObjectCommand({
          Bucket: config.S3_BUCKET,
          Key: recording.audio_object_key
        })
      );
      if (!object.Body) {
        throw new Error("Audio object body is empty");
      }
      const audioBuffer = await streamToBuffer(object.Body);
      const runtimeSettings = await getRuntimeModelSettings(userId);
      const sourceUrl = await createTemporaryObjectReadUrl(recording.audio_object_key);
      const transcribed = await transcribeAudio(audioBuffer, `${recording.id}.webm`, runtimeSettings.stt, {
        durationMs: recording.duration_ms,
        sourceUrl
      });

      await pool.query(
        `INSERT INTO transcripts (recording_id, text, language, stt_model, stt_meta_json)
         VALUES ($1, $2, 'zh', $3, $4::jsonb)
         ON CONFLICT (recording_id)
         DO UPDATE SET text = EXCLUDED.text, stt_meta_json = EXCLUDED.stt_meta_json`,
        [
          recordingId,
          transcribed.text,
          transcribed.modelUsed,
          JSON.stringify({
            provider: runtimeSettings.stt.provider,
            dispatch_mode: transcribed.dispatchMode,
            source_duration_ms: recording.duration_ms,
            source_size_bytes: audioBuffer.length,
            provider_job_id: transcribed.providerJobId
          })
        ]
      );

      await pool.query("UPDATE recordings SET status = 'transcribed' WHERE id = $1", [recordingId]);
      transcribeSucceeded = true;
      try {
        await persistMeetingNoteForRecording(recordingId, userId, "upload");
      } catch (noteError) {
        console.error(`meeting note persist failed for recording ${recordingId}`, noteError);
      }
    } catch (error) {
      const maybeNoSuchKey = String(error).includes("NoSuchKey");
      if (maybeNoSuchKey) {
        const transcriptExists = await pool.query<{ id: string }>(
          "SELECT id FROM transcripts WHERE recording_id = $1",
          [recordingId]
        );
        if (transcriptExists.rowCount) {
          await pool.query(
            "UPDATE recordings SET status = 'transcribed', failed_reason = NULL WHERE id = $1",
            [recordingId]
          );
          return;
        }
        const existingFailure = await pool.query<{ failed_reason: string | null }>(
          "SELECT failed_reason FROM recordings WHERE id = $1",
          [recordingId]
        );
        if (existingFailure.rows[0]?.failed_reason) {
          await pool.query("UPDATE recordings SET status = 'failed' WHERE id = $1", [recordingId]);
          throw error;
        }
      }
      await pool.query(
        "UPDATE recordings SET status = 'failed', failed_reason = $2 WHERE id = $1",
        [recordingId, String(error)]
      );
      throw error;
    } finally {
      const configuredAttempts = job.opts.attempts ?? 1;
      const isFinalAttempt = (job.attemptsMade + 1) >= configuredAttempts;
      if (!transcribeSucceeded && !isFinalAttempt) {
        return;
      }
      try {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: config.S3_BUCKET,
            Key: recording.audio_object_key
          })
        );
      } catch {
      }
    }
  },
  {
    connection: { url: config.REDIS_URL }
  }
);

const dailySummaryWorker = new Worker(
  "daily-summary",
  async (job) => {
    const { userId, date, trigger = "manual" } = job.data as {
      userId: string;
      date: string;
      trigger?: DailySummaryTrigger;
    };
    await ensureDailySummarySchemaExists();
    const userRow = await pool.query<{ username: string; tz: string | null }>(
      "SELECT username, tz FROM users WHERE id = $1",
      [userId]
    );
    const user = userRow.rows[0];
    if (!user) {
      throw new Error("User not found for daily summary");
    }
    const userTz = user.tz || "Asia/Shanghai";
    const transcriptRows = await pool.query<{ text: string }>(
      `SELECT t.text
       FROM transcripts t
       INNER JOIN recordings r ON r.id = t.recording_id
       WHERE r.user_id = $1 AND DATE(r.started_at AT TIME ZONE $3) = $2::date
       ORDER BY r.started_at ASC`,
      [userId, date, userTz]
    );
    const runtimeSettings = await getRuntimeModelSettings(userId);
    const sourceText = transcriptRows.rows.map((row) => row.text).join("\n\n");
    const noMeetingDay = sourceText.trim().length === 0;
    const summaryOutput = noMeetingDay
      ? (() => {
          const parsed = buildNoMeetingDailySummary();
          return { parsed, reportMd: renderDailySummaryMarkdown(parsed) };
        })()
      : await generateDailySummaryFromText(sourceText, runtimeSettings.analysis);

    const filePersist = await persistDailySummaryFile({
      userId,
      username: user.username,
      date,
      reportMd: summaryOutput.reportMd,
      llmModel: runtimeSettings.analysis.model,
      trigger
    });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM tasks
         WHERE source_summary_id IN (
           SELECT id FROM daily_summaries WHERE user_id = $1 AND date = $2::date
         )`,
        [userId, date]
      );
      const summaryRow = await client.query<{ id: string }>(
        `INSERT INTO daily_summaries (
           user_id, date, report_md, tasks_json, llm_model, llm_meta_json, storage_path, checksum, last_error, trigger
         )
         VALUES ($1, $2::date, $3, $4::jsonb, $5, $6::jsonb, $7, $8, $9, $10)
         RETURNING id`,
        [
          userId,
          date,
          summaryOutput.reportMd,
          JSON.stringify(summaryOutput.parsed.tasks),
          runtimeSettings.analysis.model,
          JSON.stringify({
            provider: runtimeSettings.analysis.provider,
            no_meeting_day: noMeetingDay
          }),
          filePersist.storagePath,
          filePersist.checksum,
          filePersist.lastError,
          trigger
        ]
      );
      const summaryId = summaryRow.rows[0]?.id;
      if (!summaryId) {
        throw new Error("Failed to create daily summary");
      }

      for (const task of summaryOutput.parsed.tasks) {
        await client.query(
          `INSERT INTO tasks (user_id, title, notes, priority, status, due_date, estimate_min, source_summary_id)
           VALUES ($1, $2, $3, $4, 'todo', $5::date, $6, $7)`,
          [
            userId,
            task.title,
            task.context ?? null,
            task.priority,
            task.due_date ?? null,
            task.estimate_min ?? null,
            summaryId
          ]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
  {
    connection: { url: config.REDIS_URL }
  }
);

const transcribeEvents = new QueueEvents("transcribe", { connection: { url: config.REDIS_URL } });
const summaryEvents = new QueueEvents("daily-summary", { connection: { url: config.REDIS_URL } });

transcribeWorker.on("failed", (job, error) => {
  console.error(`transcribe job failed: ${job?.id}`, error);
});
dailySummaryWorker.on("failed", (job, error) => {
  console.error(`daily summary job failed: ${job?.id}`, error);
});

await Promise.all([transcribeEvents.waitUntilReady(), summaryEvents.waitUntilReady()]);
await ensureMeetingNotesTableExists();
await ensureDailySummarySchemaExists();

let schedulerRunning = false;
const runSchedulerTick = async () => {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    await enqueueAutoDailySummaryRuns(new Date());
  } catch (error) {
    console.error("auto daily summary scheduler tick failed", error);
  } finally {
    schedulerRunning = false;
  }
};
await runSchedulerTick();
setInterval(() => {
  void runSchedulerTick();
}, 60_000).unref();

console.log("Worker is running");
