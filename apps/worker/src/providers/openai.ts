import OpenAI from "openai";
import { toFile } from "openai/uploads";
import {
  LONG_AUDIO_THRESHOLD_MS,
  dailySummarySchema,
  renderDailySummaryMarkdown,
  sttDispatchModeSchema,
  summaryPromptTemplate,
  type DailySummary,
  type SttDispatchMode
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

function mapUpstreamError(status: number, responseText: string): string {
  if (status === 401 || status === 403) {
    return `AUTH_ERROR: ${responseText || "认证失败，请检查 STT Key"}`;
  }
  if (status === 400) {
    return `MODEL_ERROR: ${responseText || "模型或参数不合法"}`;
  }
  if (status >= 500) {
    return `UPSTREAM_5XX: ${responseText || "上游服务错误"}`;
  }
  return `UPSTREAM_${status}: ${responseText || "请求失败"}`;
}

function buildQwenFiletransBaseUrl() {
  return config.QWEN_FILETRANS_API_BASE.replace(/\/$/, "");
}

async function submitQwenFiletransJob(input: {
  fileUrl: string;
  model: string;
  apiKey: string;
}): Promise<{ jobId: string }> {
  const response = await fetch(`${buildQwenFiletransBaseUrl()}/services/audio/asr/transcription`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable"
    },
    body: JSON.stringify({
      model: input.model,
      input: {
        file_url: input.fileUrl
      },
      parameters: {
        language: "zh",
        enable_itn: false,
        enable_words: true
      }
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(mapUpstreamError(response.status, text));
  }
  const payload = (await response.json()) as { output?: { task_id?: string } };
  const taskId = payload.output?.task_id;
  if (!taskId) {
    throw new Error("MODEL_ERROR: filetrans 未返回 task_id");
  }
  return { jobId: taskId };
}

function collectTextCandidates(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const stack: unknown[] = [payload];
  const values: string[] = [];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      if (
        typeof value === "string" &&
        value.trim() &&
        (key === "text" || key === "sentence" || key === "transcript" || key === "content")
      ) {
        values.push(value.trim());
      } else if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }
  return values;
}

async function parseQwenFiletransResult(payload: {
  output?: { transcription_url?: string };
}): Promise<string> {
  const resultUrl = payload.output?.transcription_url;
  if (!resultUrl) {
    throw new Error("MODEL_ERROR: filetrans 结果缺少 transcription_url");
  }
  const response = await fetch(resultUrl);
  if (!response.ok) {
    throw new Error(`UPSTREAM_${response.status}: 读取 transcription_url 失败`);
  }
  const resultPayload = (await response.json()) as unknown;
  const texts = collectTextCandidates(resultPayload);
  const merged = texts.join("\n").trim();
  if (!merged) {
    throw new Error("MODEL_ERROR: filetrans 返回为空");
  }
  return merged;
}

async function pollQwenFiletransResult(input: {
  jobId: string;
  apiKey: string;
  timeoutMs: number;
  intervalMs: number;
}): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < input.timeoutMs) {
    const response = await fetch(`${buildQwenFiletransBaseUrl()}/tasks/${input.jobId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${input.apiKey}`
      }
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(mapUpstreamError(response.status, text));
    }
    const payload = (await response.json()) as {
      output?: { task_status?: string; message?: string; transcription_url?: string };
    };
    const status = payload.output?.task_status ?? "";
    if (status === "SUCCEEDED") {
      return parseQwenFiletransResult(payload);
    }
    if (status === "FAILED" || status === "CANCELED") {
      const message = `${payload.output?.message ?? ""}`.trim();
      if (message.includes("FILE_DOWNLOAD_FAILED")) {
        throw new Error(
          "MODEL_ERROR: filetrans 任务失败 FILE_DOWNLOAD_FAILED（请确认音频 URL 对 DashScope 可访问，localhost/内网地址不可用）"
        );
      }
      throw new Error(`MODEL_ERROR: filetrans 任务失败 ${message}`.trim());
    }
    await new Promise((resolve) => setTimeout(resolve, input.intervalMs));
  }
  throw new Error(`TIMEOUT: filetrans 轮询超时（>${Math.floor(input.timeoutMs / 1000)}秒）`);
}

async function transcribeByQwenFiletrans(input: {
  fileUrl: string;
  model: string;
  apiKey: string;
}) {
  const submitted = await submitQwenFiletransJob({
    fileUrl: input.fileUrl,
    model: input.model,
    apiKey: input.apiKey
  });
  const text = await pollQwenFiletransResult({
    jobId: submitted.jobId,
    apiKey: input.apiKey,
    timeoutMs: config.QWEN_FILETRANS_TIMEOUT_MS,
    intervalMs: config.QWEN_FILETRANS_POLL_INTERVAL_MS
  });
  return {
    text,
    jobId: submitted.jobId
  };
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

export type TranscribeAudioResult = {
  text: string;
  dispatchMode: SttDispatchMode;
  providerJobId: string | null;
  modelUsed: string;
};

type TranscribeAudioOptions = {
  durationMs: number;
  sourceUrl?: string | null;
};

export function resolveQwenSttDispatchMode(durationMs: number): SttDispatchMode {
  const longAudioThreshold = config.LONG_AUDIO_THRESHOLD_MS || LONG_AUDIO_THRESHOLD_MS;
  return durationMs > longAudioThreshold ? "long_filetrans" : "short_inline";
}

export async function transcribeAudio(
  buffer: Buffer,
  filename: string,
  sttConfig: RuntimeModelConfig,
  options: TranscribeAudioOptions
): Promise<TranscribeAudioResult> {
  if (sttConfig.provider === "seed-asr") {
    const text = await transcribeBySeedAsr(buffer, filename, sttConfig);
    return { text, dispatchMode: "short_inline", providerJobId: null, modelUsed: sttConfig.model };
  }
  if (sttConfig.provider === "qwen3-asr") {
    const shouldUseFiletrans = resolveQwenSttDispatchMode(options.durationMs) === "long_filetrans";
    if (shouldUseFiletrans) {
      if (!options.sourceUrl) {
        throw new Error("MODEL_ERROR: 长音频转写缺少可访问的 file_url");
      }
      const model = config.QWEN_FILETRANS_MODEL || "qwen3-asr-flash-filetrans";
      const apiKey = sttConfig.apiKey || config.QWEN_ASR_API_KEY || "";
      if (!apiKey) {
        throw new Error("AUTH_ERROR: Qwen STT API Key 未配置");
      }
      const result = await transcribeByQwenFiletrans({
        fileUrl: options.sourceUrl,
        model,
        apiKey
      });
      return {
        text: result.text,
        dispatchMode: sttDispatchModeSchema.parse("long_filetrans"),
        providerJobId: result.jobId,
        modelUsed: model
      };
    }
    const text = await transcribeByQwenAsr(buffer, sttConfig);
    return {
      text,
      dispatchMode: sttDispatchModeSchema.parse("short_inline"),
      providerJobId: null,
      modelUsed: sttConfig.model
    };
  }
  const client = createClient(sttConfig);
  const file = await toFile(buffer, filename);
  const result = await client.audio.transcriptions.create({
    file,
    model: sttConfig.model,
    language: "zh"
  });
  return {
    text: result.text?.trim() || "未获得转写结果。",
    dispatchMode: "short_inline",
    providerJobId: null,
    modelUsed: sttConfig.model
  };
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
