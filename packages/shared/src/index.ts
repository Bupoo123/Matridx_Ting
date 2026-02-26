import { z } from "zod";

export const taskPrioritySchema = z.enum(["low", "medium", "high"]);
export const taskStatusSchema = z.enum(["todo", "doing", "done"]);
export const sttProviderSchema = z.enum(["openai", "openrouter", "seed-asr", "qwen3-asr"]);
export const analysisProviderSchema = z.enum(["openai", "openrouter"]);

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

export const aiSettingsSchema = z.object({
  stt_provider: sttProviderSchema.default("openai"),
  stt_model: z.string().min(1).default("gpt-4o-mini-transcribe"),
  stt_api_key_configured: z.boolean().default(false),
  analysis_provider: analysisProviderSchema.default("openai"),
  analysis_model: z.string().min(1).default("gpt-4.1-mini"),
  analysis_api_key_configured: z.boolean().default(false)
});

export const aiSettingsUpdateSchema = z.object({
  stt_provider: sttProviderSchema.optional(),
  stt_model: z.string().min(1).optional(),
  stt_api_key: z.string().min(1).optional(),
  clear_stt_api_key: z.boolean().optional(),
  analysis_provider: analysisProviderSchema.optional(),
  analysis_model: z.string().min(1).optional(),
  analysis_api_key: z.string().min(1).optional(),
  clear_analysis_api_key: z.boolean().optional()
});

export type AiSettingsView = z.infer<typeof aiSettingsSchema>;
export type AiSettingsUpdate = z.infer<typeof aiSettingsUpdateSchema>;

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
