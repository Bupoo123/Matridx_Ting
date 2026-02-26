import OpenAI from "openai";
import { toFile } from "openai/uploads";
import { config } from "./config.js";

type AnalysisProvider = "openai" | "openrouter";
type SttProvider = "openai" | "openrouter" | "seed-asr" | "qwen3-asr";

function createAnalysisClient(provider: AnalysisProvider, apiKey: string): OpenAI {
  if (provider === "openrouter") {
    return new OpenAI({
      apiKey,
      baseURL: config.OPENROUTER_BASE_URL,
      defaultHeaders: {
        ...(config.OPENROUTER_SITE_URL ? { "HTTP-Referer": config.OPENROUTER_SITE_URL } : {}),
        ...(config.OPENROUTER_APP_NAME ? { "X-Title": config.OPENROUTER_APP_NAME } : {})
      }
    });
  }
  return new OpenAI({ apiKey });
}

function createSttCompatibleClient(provider: Exclude<SttProvider, "seed-asr">, apiKey: string): OpenAI {
  if (provider === "openrouter") {
    return createAnalysisClient("openrouter", apiKey);
  }
  if (provider === "qwen3-asr") {
    return new OpenAI({
      apiKey: apiKey || config.QWEN_ASR_API_KEY || "EMPTY",
      baseURL: config.QWEN_ASR_BASE_URL
    });
  }
  return new OpenAI({ apiKey });
}

async function testQwenAsr(apiKey: string, model: string) {
  if (model.includes("realtime")) {
    throw new Error("当前录音转写链路不支持 realtime 模型，请改用非 realtime 的 Qwen ASR 模型。");
  }
  const client = createSttCompatibleClient("qwen3-asr", apiKey);
  const audioBase64 = buildSilentWav().toString("base64");
  const result = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: {
              data: `data:audio/wav;base64,${audioBase64}`
            }
          }
        ]
      }
    ]
  } as never);
  const content = result.choices?.[0]?.message?.content;
  if (!content || (typeof content === "string" && !content.trim())) {
    throw new Error("Qwen ASR 返回空结果");
  }
}

function buildSilentWav(durationMs = 1000, sampleRate = 16000): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor((sampleRate * durationMs) / 1000);
  const dataSize = frameCount * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

async function testSeedAsr(apiKey: string, model: string) {
  if (!config.SEED_ASR_ENDPOINT) {
    throw new Error("SEED_ASR_ENDPOINT 未配置");
  }
  const form = new FormData();
  const audioBytes = new Uint8Array(buildSilentWav());
  form.append("model", model);
  form.append("language", "zh");
  form.append("file", new Blob([audioBytes], { type: "audio/wav" }), "test.wav");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.SEED_ASR_TIMEOUT_MS);
  try {
    const response = await fetch(config.SEED_ASR_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: form,
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function testSttProvider(provider: SttProvider, apiKey: string, model: string) {
  if (provider === "seed-asr") {
    await testSeedAsr(apiKey, model);
    return;
  }
  if (provider === "qwen3-asr") {
    await testQwenAsr(apiKey, model);
    return;
  }
  const client = createSttCompatibleClient(provider, apiKey);
  const wav = buildSilentWav();
  const file = await toFile(wav, "test.wav", { type: "audio/wav" });
  await client.audio.transcriptions.create({
    file,
    model,
    language: "zh"
  });
}

export async function testAnalysisProvider(provider: AnalysisProvider, apiKey: string, model: string) {
  const client = createAnalysisClient(provider, apiKey);
  await client.responses.create({
    model,
    input: "请回复“ok”"
  });
}
