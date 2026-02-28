export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8081";

export function getWsBase(): string {
  const url = new URL(API_BASE);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
}

export async function apiFetch<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "Request failed");
  }
  return (await response.json()) as T;
}

export type ApiTask = {
  id: string;
  title: string;
  notes: string | null;
  priority: "low" | "medium" | "high";
  status: "todo" | "doing" | "done";
  due_date: string | null;
  estimate_min: number | null;
};

export type AiSettingsView = {
  stt_provider: "openai" | "openrouter" | "seed-asr" | "qwen3-asr";
  stt_file_model: string;
  stt_realtime_model: string;
  stt_api_key_configured: boolean;
  analysis_provider: "openai" | "openrouter";
  analysis_model: string;
  analysis_api_key_configured: boolean;
};

export type AiSettingsUpdate = Partial<{
  stt_provider: "openai" | "openrouter" | "seed-asr" | "qwen3-asr";
  stt_model: string;
  stt_file_model: string;
  stt_realtime_model: string;
  stt_api_key: string;
  clear_stt_api_key: boolean;
  analysis_provider: "openai" | "openrouter";
  analysis_model: string;
  analysis_api_key: string;
  clear_analysis_api_key: boolean;
}>;

export type ApiMeetingNote = {
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
  last_error?: string | null;
  created_at?: string;
  updated_at?: string;
};
