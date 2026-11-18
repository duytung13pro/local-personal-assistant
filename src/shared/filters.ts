import type { Task } from "./types";

export type Status = "open" | "done" | "all";
export type Due = "any" | "overdue" | "today" | "upcoming" | "none";

/** Checklist filter. Every search word must appear in the title or notes (case-insensitive). */
export function matches(t: Task, query: string, status: Status, priority: string, due: Due, today: string): boolean {
  if (status === "open" && t.done) return false;
  if (status === "done" && !t.done) return false;
  if (priority !== "all" && t.priority !== priority) return false;
  if (due === "overdue" && !(t.due && t.due < today && !t.done)) return false;
  if (due === "today" && t.due !== today) return false;
  if (due === "upcoming" && !(t.due && t.due > today)) return false;
  if (due === "none" && t.due) return false;
  const hay = `${t.title}\n${t.notes}`.toLocaleLowerCase();
  return query.toLocaleLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}
