import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const currentDir = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(currentDir, "../../../.env") });
const defaultNotesRoot = resolve(currentDir, "../../../infra/data/notes");

const schema = z.object({
  REDIS_URL: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  OPENROUTER_SITE_URL: z.string().url().optional(),
  OPENROUTER_APP_NAME: z.string().optional(),
  QWEN_ASR_BASE_URL: z.string().url().default("https://dashscope.aliyuncs.com/compatible-mode/v1"),
  QWEN_FILETRANS_API_BASE: z.string().url().default("https://dashscope.aliyuncs.com/api/v1"),
  QWEN_FILETRANS_MODEL: z.string().default("qwen3-asr-flash-filetrans"),
  QWEN_FILETRANS_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3000),
  QWEN_FILETRANS_TIMEOUT_MS: z.coerce.number().int().positive().default(1800000),
  LONG_AUDIO_THRESHOLD_MS: z.coerce.number().int().positive().default(300000),
  NOTES_STORAGE_ROOT: z.string().default(defaultNotesRoot),
  QWEN_ASR_API_KEY: z.string().optional(),
  SEED_ASR_ENDPOINT: z.string().url().optional(),
  SEED_ASR_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  STT_PROVIDER: z.string().default("openai"),
  STT_API_KEY: z.string().optional(),
  LLM_PROVIDER: z.string().default("openai"),
  LLM_API_KEY: z.string().optional()
});

export const config = schema.parse(process.env);
