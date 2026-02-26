import OpenAI from "openai";
import { toFile } from "openai/uploads";
import {
  dailySummarySchema,
  renderDailySummaryMarkdown,
  summaryPromptTemplate,
  type DailySummary
} from "@matridx/shared";
import { config } from "../config.js";
import type { RuntimeModelConfig } from "../ai-settings.js";

function createClient(modelConfig: RuntimeModelConfig): OpenAI {
  if (modelConfig.provider === "openrouter") {
    if (!modelConfig.apiKey) {
      throw new Error("OpenRouter API Key 未配置");
    }
    return new OpenAI({
      apiKey: modelConfig.apiKey,
      baseURL: config.OPENROUTER_BASE_URL,
      defaultHeaders: {
        ...(config.OPENROUTER_SITE_URL ? { "HTTP-Referer": config.OPENROUTER_SITE_URL } : {}),
        ...(config.OPENROUTER_APP_NAME ? { "X-Title": config.OPENROUTER_APP_NAME } : {})
      }
    });
  }
  if (modelConfig.provider === "qwen3-asr") {
    return new OpenAI({
      apiKey: modelConfig.apiKey || config.QWEN_ASR_API_KEY || "EMPTY",
      baseURL: config.QWEN_ASR_BASE_URL
    });
  }
  if (!modelConfig.apiKey) {
    throw new Error("API Key 未配置");
  }
  return new OpenAI({ apiKey: modelConfig.apiKey });
}

async function transcribeByQwenAsr(
  buffer: Buffer,
  sttConfig: RuntimeModelConfig
): Promise<string> {
  if (sttConfig.model.includes("realtime")) {
    throw new Error("qwen realtime 模型不支持当前文件转写流程，请使用非 realtime 模型。");
  }
  const client = createClient({ ...sttConfig, provider: "qwen3-asr" });
  const audioBase64 = buffer.toString("base64");
  const response = await client.chat.completions.create({
    model: sttConfig.model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: {
              data: `data:audio/webm;base64,${audioBase64}`
            }
          }
        ]
      }
    ]
  } as never);
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }
  throw new Error("Qwen ASR 返回为空");
}

function resolveTextFromSeedAsrResponse(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const direct = record.text;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const data = record.data as Record<string, unknown> | undefined;
  if (data && typeof data.text === "string" && data.text.trim()) return data.text.trim();
  const result = record.result as Record<string, unknown> | undefined;
  if (result && typeof result.text === "string" && result.text.trim()) return result.text.trim();
  return null;
}

async function transcribeBySeedAsr(
  buffer: Buffer,
  filename: string,
  sttConfig: RuntimeModelConfig
): Promise<string> {
  if (!config.SEED_ASR_ENDPOINT) {
    throw new Error("SEED_ASR_ENDPOINT 未配置");
  }
  const form = new FormData();
  const audioBytes = new Uint8Array(buffer);
  form.append("model", sttConfig.model);
  form.append("language", "zh");
  form.append("file", new Blob([audioBytes], { type: "audio/webm" }), filename);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.SEED_ASR_TIMEOUT_MS);
  try {
    const response = await fetch(config.SEED_ASR_ENDPOINT, {
      method: "POST",
      headers: {
        ...(sttConfig.apiKey ? { Authorization: `Bearer ${sttConfig.apiKey}` } : {})
      },
      body: form,
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Seed-ASR 请求失败: ${await response.text()}`);
    }
    const json = (await response.json()) as unknown;
    const text = resolveTextFromSeedAsrResponse(json);
    if (!text) {
      throw new Error("Seed-ASR 返回中未找到 text 字段");
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

export async function transcribeAudio(
  buffer: Buffer,
  filename: string,
  sttConfig: RuntimeModelConfig
): Promise<string> {
  if (sttConfig.provider === "seed-asr") {
    return transcribeBySeedAsr(buffer, filename, sttConfig);
  }
  if (sttConfig.provider === "qwen3-asr") {
    return transcribeByQwenAsr(buffer, sttConfig);
  }
  const client = createClient(sttConfig);
  const file = await toFile(buffer, filename);
  const result = await client.audio.transcriptions.create({
    file,
    model: sttConfig.model,
    language: "zh"
  });
  return result.text?.trim() || "未获得转写结果。";
}

export async function generateDailySummaryFromText(
  sourceText: string,
  analysisConfig: RuntimeModelConfig
): Promise<{
  parsed: DailySummary;
  reportMd: string;
}> {
  const client = createClient(analysisConfig);
  const schemaDef = {
    name: "daily_summary",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        abstract: { type: "string" },
        progress: { type: "array", items: { type: "string" } },
        issues: { type: "array", items: { type: "string" } },
        todos: { type: "array", items: { type: "string" } },
        tomorrow_plan: { type: "array", items: { type: "string" } },
        tasks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string" },
              priority: { type: "string", enum: ["low", "medium", "high"] },
              due_date: { type: ["string", "null"] },
              estimate_min: { type: ["number", "null"] },
              context: { type: ["string", "null"] }
            },
            required: ["title", "priority", "due_date", "estimate_min", "context"]
          }
        },
        time_blocks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              start: { type: "string" },
              end: { type: "string" },
              title: { type: "string" }
            },
            required: ["start", "end", "title"]
          }
        }
      },
      required: ["abstract", "progress", "issues", "todos", "tomorrow_plan", "tasks", "time_blocks"]
    },
    strict: true
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await client.responses.create({
        model: analysisConfig.model,
        input: [
          {
            role: "system",
            content: summaryPromptTemplate
          },
          {
            role: "user",
            content: `以下是今天的对话转写，请生成 JSON：\n${sourceText}`
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: schemaDef.name,
            schema: schemaDef.schema,
            strict: true
          }
        }
      });
      const output = response.output_text ?? "{}";
      const parsed = dailySummarySchema.parse(JSON.parse(output));
      return { parsed, reportMd: renderDailySummaryMarkdown(parsed) };
    } catch (error) {
      lastError = error;
    }
  }

  const fallback = dailySummarySchema.parse({
    abstract: "模型结构化输出失败，已降级。",
    progress: [],
    issues: [`错误信息：${String(lastError)}`],
    todos: [],
    tomorrow_plan: [],
    tasks: [],
    time_blocks: []
  });
  return { parsed: fallback, reportMd: renderDailySummaryMarkdown(fallback) };
}
