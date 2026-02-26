export type JwtPayload = {
  sub: string;
  username: string;
};

export type TaskRow = {
  id: string;
  user_id: string;
  title: string;
  notes: string | null;
  priority: "low" | "medium" | "high";
  status: "todo" | "doing" | "done";
  due_date: string | null;
  estimate_min: number | null;
  source_summary_id: string | null;
  created_at: string;
};
