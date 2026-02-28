import { z } from "zod";

export const taskPrioritySchema = z.enum(["low", "medium", "high"]);
export const taskStatusSchema = z.enum(["todo", "doing", "done"]);
export const sttProviderSchema = z.enum(["openai", "openrouter", "seed-asr", "qwen3-asr"]);
export const analysisProviderSchema = z.enum(["openai", "openrouter"]);
export const dailySummaryTriggerSchema = z.enum(["manual", "auto_20", "auto_2330"]);
export const LONG_AUDIO_THRESHOLD_MS = 300000;
export const sttDispatchModeSchema = z.enum(["short_inline", "long_filetrans"]);

export const llmTaskSchema = z.object({
  title: z.string().min(2),
  priority: taskPrioritySchema.default("medium"),
  due_date: z.string().nullable().optional(),
  estimate_min: z.number().int().positive().nullable().optional(),
  context: z.string().nullable().optional()
});

export const dailySummarySchema = z.object({
  abstract: z.string().min(1),
  progress: z.array(z.string()).default([]),
  issues: z.array(z.string()).default([]),
  todos: z.array(z.string()).default([]),
  tomorrow_plan: z.array(z.string()).default([]),
  tasks: z.array(llmTaskSchema).default([]),
  time_blocks: z
    .array(
      z.object({
        start: z.string(),
        end: z.string(),
        title: z.string().min(1)
      })
    )
    .default([])
});

export type DailySummary = z.infer<typeof dailySummarySchema>;
export type TaskPriority = z.infer<typeof taskPrioritySchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type LlmTask = z.infer<typeof llmTaskSchema>;
export type SttDispatchMode = z.infer<typeof sttDispatchModeSchema>;

export const aiSettingsSchema = z.object({
  stt_provider: sttProviderSchema.default("openai"),
  stt_file_model: z.string().min(1).default("gpt-4o-mini-transcribe"),
  stt_realtime_model: z.string().min(1).default("qwen3-asr-flash-realtime"),
  stt_api_key_configured: z.boolean().default(false),
  analysis_provider: analysisProviderSchema.default("openai"),
  analysis_model: z.string().min(1).default("gpt-4.1-mini"),
  analysis_api_key_configured: z.boolean().default(false)
});

export const aiSettingsUpdateSchema = z.object({
  stt_provider: sttProviderSchema.optional(),
  stt_model: z.string().min(1).optional(),
  stt_file_model: z.string().min(1).optional(),
  stt_realtime_model: z.string().min(1).optional(),
  stt_api_key: z.string().min(1).optional(),
  clear_stt_api_key: z.boolean().optional(),
  analysis_provider: analysisProviderSchema.optional(),
  analysis_model: z.string().min(1).optional(),
  analysis_api_key: z.string().min(1).optional(),
  clear_analysis_api_key: z.boolean().optional()
});

export const meetingNoteSourceSchema = z.enum(["upload", "realtime"]);

export const meetingNoteSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  recording_id: z.string().uuid(),
  contributor: z.string().min(1),
  recorded_at: z.string(),
  date: z.string(),
  time: z.string(),
  title: z.string().min(1),
  summary: z.string().min(1),
  transcript_text: z.string().min(1),
  tags: z.array(z.string()).default([]),
  source: meetingNoteSourceSchema,
  storage_path: z.string().nullable(),
  checksum: z.string().nullable(),
  last_error: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional()
});

export const meetingNoteListItemSchema = meetingNoteSchema.pick({
  id: true,
  recording_id: true,
  contributor: true,
  recorded_at: true,
  date: true,
  time: true,
  title: true,
  summary: true,
  source: true,
  storage_path: true,
  last_error: true,
  created_at: true
});

export const meetingNoteSyncSchema = z.object({
  date: z.string(),
  transcripts: z.array(
    z.object({
      id: z.string().uuid(),
      recording_id: z.string().uuid(),
      text: z.string(),
      created_at: z.string()
    })
  ),
  meeting_notes: z.array(meetingNoteListItemSchema)
});

export const dailySummaryViewSchema = z.object({
  id: z.string().uuid(),
  date: z.string(),
  report_md: z.string(),
  tasks_json: z.array(llmTaskSchema).default([]),
  created_at: z.string(),
  storage_path: z.string().nullable().optional(),
  checksum: z.string().nullable().optional(),
  last_error: z.string().nullable().optional(),
  trigger: dailySummaryTriggerSchema.default("manual")
});

export type AiSettingsView = z.infer<typeof aiSettingsSchema>;
export type AiSettingsUpdate = z.infer<typeof aiSettingsUpdateSchema>;
export type MeetingNote = z.infer<typeof meetingNoteSchema>;
export type MeetingNoteListItem = z.infer<typeof meetingNoteListItemSchema>;
export type MeetingNoteSource = z.infer<typeof meetingNoteSourceSchema>;
export type DailySummaryTrigger = z.infer<typeof dailySummaryTriggerSchema>;
export type DailySummaryView = z.infer<typeof dailySummaryViewSchema>;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function toUtcDateParts(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hour = pad(date.getUTCHours());
  const minute = pad(date.getUTCMinutes());
  const second = pad(date.getUTCSeconds());
  return {
    year: String(year),
    month,
    day,
    hour,
    minute,
    second,
    ymd: `${year}${month}${day}`,
    hms: `${hour}${minute}${second}`,
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}:${second}`
  };
}

export function slugifyContributor(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const slug = trimmed.replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-").replace(/^-+|-+$/g, "");
  return slug || "unknown";
}

export function makeMeetingNoteSummary(transcriptText: string): string {
  const normalized = transcriptText.replace(/\s+/g, " ").trim();
  if (!normalized) return "暂无内容";
  const chunks = normalized
    .split(/[。！？!?；;\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 3);
  const summary = chunks.join("；");
  return summary.length > 200 ? `${summary.slice(0, 200)}…` : summary;
}

type MeetingNoteRenderInput = {
  noteId: string;
  recordingId: string;
  contributor: string;
  recordedAt: string;
  createdAt: string;
  source: MeetingNoteSource;
  language: string;
  sttModel: string;
  title: string;
  summary: string;
  transcriptText: string;
};

export function renderMeetingNoteMarkdown(input: MeetingNoteRenderInput): string {
  const frontmatter = [
    "---",
    `note_id: "${input.noteId}"`,
    `recording_id: "${input.recordingId}"`,
    `contributor: "${input.contributor.replace(/"/g, '\\"')}"`,
    `recorded_at: "${input.recordedAt}"`,
    `created_at: "${input.createdAt}"`,
    `source: "${input.source}"`,
    `language: "${input.language}"`,
    `stt_model: "${input.sttModel.replace(/"/g, '\\"')}"`,
    "---"
  ].join("\n");
  return [
    frontmatter,
    "",
    `# ${input.title}`,
    "",
    "## 摘要",
    input.summary,
    "",
    "## 转写全文",
    input.transcriptText
  ].join("\n");
}

export function renderDailySummaryMarkdown(summary: DailySummary): string {
  const section = (title: string, items: string[]) =>
    `## ${title}\n${items.length ? items.map((item) => `- ${item}`).join("\n") : "- 无"}\n`;

  return [
    "# 工作日报",
    "",
    "## 摘要",
    summary.abstract,
    "",
    section("进展", summary.progress),
    section("问题", summary.issues),
    section("待办", summary.todos),
    section("明日计划", summary.tomorrow_plan),
    "## 任务建议",
    summary.tasks.length
      ? summary.tasks
          .map((task) => {
            const due = task.due_date ? `，截止：${task.due_date}` : "";
            const estimate = task.estimate_min ? `，预计 ${task.estimate_min} 分钟` : "";
            return `- ${task.title}（优先级：${task.priority}${due}${estimate}）`;
          })
          .join("\n")
      : "- 无"
  ].join("\n");
}

export const summaryPromptTemplate = `
你是中文工作总结助手。请根据输入的对话转写，输出严格 JSON。

要求：
1. 输出字段必须包括：abstract, progress, issues, todos, tomorrow_plan, tasks, time_blocks
2. tasks 里每项要是可执行动作（动词开头），priority 只能 low/medium/high
3. 无法推断截止日期时 due_date 设为 null
4. 所有输出使用中文
`.trim();
