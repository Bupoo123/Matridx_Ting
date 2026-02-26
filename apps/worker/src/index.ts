import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { QueueEvents, Worker } from "bullmq";
import { config } from "./config.js";
import { pool } from "./db.js";
import { getRuntimeModelSettings } from "./ai-settings.js";
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

const transcribeWorker = new Worker(
  "transcribe",
  async (job) => {
    const { recordingId, userId } = job.data as { recordingId: string; userId: string };
    const recordingRow = await pool.query<{
      id: string;
      audio_object_key: string | null;
      title: string;
    }>("SELECT id, audio_object_key, title FROM recordings WHERE id = $1 AND user_id = $2", [
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
      const transcriptText = await transcribeAudio(audioBuffer, `${recording.id}.webm`, runtimeSettings.stt);

      await pool.query(
        `INSERT INTO transcripts (recording_id, text, language, stt_model, stt_meta_json)
         VALUES ($1, $2, 'zh', $3, $4::jsonb)
         ON CONFLICT (recording_id)
         DO UPDATE SET text = EXCLUDED.text, stt_meta_json = EXCLUDED.stt_meta_json`,
        [
          recordingId,
          transcriptText,
          runtimeSettings.stt.model,
          JSON.stringify({ provider: runtimeSettings.stt.provider })
        ]
      );

      await pool.query("UPDATE recordings SET status = 'transcribed' WHERE id = $1", [recordingId]);
    } catch (error) {
      await pool.query("UPDATE recordings SET status = 'failed', failed_reason = $2 WHERE id = $1", [
        recordingId,
        String(error)
      ]);
      throw error;
    } finally {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: config.S3_BUCKET,
          Key: recording.audio_object_key
        })
      );
    }
  },
  {
    connection: { url: config.REDIS_URL }
  }
);

const dailySummaryWorker = new Worker(
  "daily-summary",
  async (job) => {
    const { userId, date } = job.data as { userId: string; date: string };
    const transcriptRows = await pool.query<{ text: string }>(
      `SELECT t.text
       FROM transcripts t
       INNER JOIN recordings r ON r.id = t.recording_id
       WHERE r.user_id = $1 AND DATE(r.started_at AT TIME ZONE 'UTC') = $2::date
       ORDER BY r.started_at ASC`,
      [userId, date]
    );
    const sourceText = transcriptRows.rows.map((row) => row.text).join("\n\n");
    const runtimeSettings = await getRuntimeModelSettings(userId);
    const { parsed, reportMd } = await generateDailySummaryFromText(
      sourceText || "今天暂无转写内容。",
      runtimeSettings.analysis
    );

    const summaryRow = await pool.query<{ id: string }>(
      `INSERT INTO daily_summaries (user_id, date, report_md, tasks_json, llm_model, llm_meta_json)
       VALUES ($1, $2::date, $3, $4::jsonb, $5, $6::jsonb)
       RETURNING id`,
      [
        userId,
        date,
        reportMd,
        JSON.stringify(parsed.tasks),
        runtimeSettings.analysis.model,
        JSON.stringify({ provider: runtimeSettings.analysis.provider })
      ]
    );
    const summaryId = summaryRow.rows[0]?.id;
    if (!summaryId) {
      throw new Error("Failed to create daily summary");
    }

    for (const task of parsed.tasks) {
      await pool.query(
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
console.log("Worker is running");
