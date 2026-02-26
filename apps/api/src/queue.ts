import { Queue } from "bullmq";
import { config } from "./config.js";

export const transcribeQueue = new Queue("transcribe", {
  connection: { url: config.REDIS_URL }
});

export const dailySummaryQueue = new Queue("daily-summary", {
  connection: { url: config.REDIS_URL }
});
