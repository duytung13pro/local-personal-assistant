// The head chef: local Qwen 30B reads each chat message and decides who cooks.
//   self    → it answers itself (greetings, quick facts, rewording, short help)
//   planner → it reads/edits your tasks and events with local tools (never sent to cloud models)
//   single  → one worker does the job
//   split   → several workers, independent sub-tasks in parallel, then the head chef merges the results
import type { ChatMessage, Project, WorkerId } from "../shared/types";
import { CHAT_ROUTABLE, WORKERS, isCloud, isWorker } from "../shared/workers";
import { parseTasks, type Draft } from "./orchestrator";
import { addDays, isValidDate, today } from "../shared/dates";
import type { Store } from "./db";
import { AgentError, KEEP_ALIVE, ollamaPost } from "./providers";
import { textToolCalls } from "./localcoder";

export const RECENT = 10;

export interface Route { mode: "self" | "planner" | "single" | "split"; reason: string; worker?: WorkerId; tasks?: Draft[] }

const LANG = "Reply in the same language as the user's latest message (English or Vietnamese).";

export function teamList(available: WorkerId[]): string {
  return CHAT_ROUTABLE.filter((w) => available.includes(w))
    .map((w) => `- "${w}" (${isCloud(w) ? "cloud, needs the user's approval, uses their plan" : "local, free"}): ${WORKERS[w].role}`).join("\n");
}

export function routerPrompt(p: Project, context: string, message: string, available: WorkerId[], forceSplit = false): string {
  return `You are the head chef of a team of AI models on the user's PC. Decide how to handle the user's message.

Choose exactly one mode:
- "self": you can answer well yourself, quickly: greetings, small talk, quick facts, rewording, short explanations,
  advice that needs no files and no deep research.
- "planner": the message is about the user's own tasks, to-dos, deadlines, calendar, events or schedule
  (questions or changes). You have local tools for that. Never route this to anyone else.
- "single": one worker should do it. Pick the best worker below.
- "split": a bigger job with separable parts. Give 2-5 tasks; tasks without "deps" on each other run at the same time.

Choosing workers (the lead chef cooks, apprentices prep):
- Prefer local workers; they are free. Use cloud workers when quality really matters or the job is large.
- Code or file changes: small/medium → "qwen-coder"; large, multi-file or tricky → "codex" or "claude" (UI/front-end → "claude").
- Hard reasoning, planning, research-style questions → "chatgpt". Long or polished writing → "claude-chat" or "qwen".
- Checking/reviewing → "gpt-oss". Quick extraction/reformatting → "qwen-fast".
- In "split", give apprentices (local) the prep tasks and one lead (often cloud) the main dish.
- ONLY "qwen-coder", "codex" and "claude" can create or edit files. Any task that builds, implements, writes code,
  integrates or fixes files MUST go to one of them. "chatgpt", "qwen", "qwen-fast", "gpt-oss" and "claude-chat" only
  produce text (specs, designs, content, checklists, reviews) that later tasks can use through "deps".
- Prefer ONE file-writing lead for the main build (several writers editing the same files conflict); put the text
  prep in parallel before it and a review after it.
- Do NOT add a final "combine", "merge" or "integrate the results" task: you merge all results into one answer
  yourself at the end. A final review task is fine when something was built.

Workers available now:
${teamList(available)}
${forceSplit ? `
THE USER ASKED FOR TEAMWORK (@team): you MUST choose "split" with 3-5 tasks. Make at least two tasks independent
(no deps between them) so they run at the same time on different workers, give the main build to the best "lead",
and add a final check task that depends on the build.` : ""}

Reply with JSON only:
{"mode":"self|planner|single|split","reason":"one short sentence the user will see","worker":"<id, for single>",
 "tasks":[{"id":"t1","title":"...","worker":"...","deps":[],"prompt":"self-contained instructions"}]}

# Project: ${p.title}
${p.brief.trim() ? `Brief: ${p.brief.trim().slice(0, 1500)}\n` : ""}
# Conversation so far
${context || "(none)"}

# User's latest message
${message}`;
}

/** "@team build X" → [true, "build X"]: the user wants the job split across several models. */
export function parseTeam(text: string): [boolean, string] {
  const m = /^\s*@team\b[\s,:]*/i.exec(text);
  return m ? [true, text.slice(m[0].length).trim()] : [false, text];
}

export function parseRoute(text: string, available: WorkerId[]): Route | null {
  let d: Record<string, unknown>;
  try {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    d = JSON.parse(a >= 0 && b > a ? text.slice(a, b + 1) : text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const reason = String(d.reason ?? "").trim().slice(0, 200);
  const mode = String(d.mode ?? "");
  if (mode === "self" || mode === "planner") return { mode, reason };
  if (mode === "single") {
    const w = String(d.worker ?? "").toLowerCase();
    return isWorker(w) && available.includes(w) ? { mode, reason, worker: w } : null;
  }
  if (mode === "split") {
    const tasks = parseTasks(d.tasks, available.filter((w) => CHAT_ROUTABLE.includes(w)));
    if (!tasks || tasks.length < 2) return null;
    return { mode, reason, tasks: chainWriters(fixWriters(tasks.slice(0, 5), available)) };
  }
  return null;
}

const BUILDS = /\b(build|implement|cod(e|ing)|fix (the )?(bug|code|page|script)|refactor|write (the )?(code|files?|page|html|script)|create (the |a )?(page|files?|app|script|component))\b/i;

/** A task that builds or edits files must go to a worker that can write files; move it if the head chef slipped. */
export function fixWriters(tasks: Draft[], available: WorkerId[]): Draft[] {
  const writer = (["qwen-coder", "codex", "claude"] as WorkerId[]).find((w) => available.includes(w));
  if (!writer) return tasks;
  return tasks.map((t) => (!WORKERS[t.agent].writes && BUILDS.test(t.title) ? { ...t, agent: writer,
    why: `${t.why ? `${t.why} ` : ""}(moved to ${WORKERS[writer].name}: only file-writing models can build)`.trim() } : t));
}

/** File-writing tasks in one project run one after another, so each must build on the previous one's files
 * (otherwise e.g. the CSS task invents class names the HTML task never used). Make every writer task depend on
 * the writer task before it, and a review/check task listed after a writer that depends on nothing wait for it. */
export function chainWriters(tasks: Draft[]): Draft[] {
  let lastWriter = "";
  return tasks.map((t, i) => {
    const ref = t.ref ?? `t${i + 1}`;
    const deps = [...(t.deps ?? [])];
    const writes = WORKERS[t.agent].writes;
    const checks = deps.length === 0 && /\b(review|check|test|verify|audit|qa)\w*/i.test(t.title);
    if (lastWriter && !deps.includes(lastWriter) && (writes || checks)) deps.push(lastWriter);
    if (writes) lastWriter = ref;
    return { ...t, ref, deps };
  });
}

/** Recent conversation as text. Cloud models never see private (planner) messages. */
export function contextText(msgs: ChatMessage[], summary: string, forCloud: boolean): string {
  const recent = msgs.filter((m) => m.content.trim() && m.status !== "failed" && !(forCloud && m.private)).slice(-RECENT);
  const lines = recent.map((m) => `${m.role === "user" ? "User" : WORKERS[m.author as WorkerId]?.name ?? "Assistant"}: ${m.content.trim().slice(0, 2000)}`);
  return [summary ? `(Earlier, summarised) ${summary}` : "", ...lines].filter(Boolean).join("\n\n");
}

export function selfSystem(p: Project): string {
  return `You are the head chef of the user's local AI team, answering directly. Be warm, concise and concrete.
You cannot see the user's tasks or calendar in this mode and you cannot edit files. ${LANG}
Current project: ${p.title}.`;
}

export function workerPrompt(task: string, context: string): string {
  return `${task.trim()}\n\n## Conversation so far (for context)\n${context || "(none)"}\n\n${LANG}`;
}

export function mergePrompt(request: string, parts: { title: string; worker: WorkerId; status: string; output: string }[]): string {
  return `The user asked: "${request}"

Your team worked on it in parts. Combine their results into one clear answer for the user: what was done,
the key results, any files created, and anything that failed or still needs the user. Do not invent results.
Nothing was run or tested: never say a feature "works" or mark it ✅ unless a task's output shows it was checked
against the actual files. If a review found problems, list them plainly as open issues. Avoid Markdown tables.
${LANG}

${parts.map((x) => `### ${x.title} (${WORKERS[x.worker].name}, ${x.status})\n${x.output.trim().slice(0, 8000) || "(no output)"}`).join("\n\n")}`;
}

export const SUMMARY_SYSTEM = "Summarise this conversation in at most 120 words: the user's goals, decisions made, files created and open questions. Plain text.";

// ---- planner tools (local only) ------------------------------------------------------------------

const PLANNER_TOOLS = [
  { type: "function", function: { name: "list_tasks", description: "List tasks. status: open | done | all (default open).",
    parameters: { type: "object", properties: { status: { type: "string" } } } } },
  { type: "function", function: { name: "add_task", description: "Add a task.",
    parameters: { type: "object", properties: { title: { type: "string" }, due: { type: "string", description: "YYYY-MM-DD or empty" },
      priority: { type: "string", description: "low | normal | high" }, notes: { type: "string" } }, required: ["title"] } } },
  { type: "function", function: { name: "update_task", description: "Change a task's title, due date, priority or notes.",
    parameters: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, due: { type: "string" },
      priority: { type: "string" }, notes: { type: "string" } }, required: ["id"] } } },
  { type: "function", function: { name: "set_task_done", description: "Mark a task done (true) or open again (false).",
    parameters: { type: "object", properties: { id: { type: "string" }, done: { type: "boolean" } }, required: ["id", "done"] } } },
  { type: "function", function: { name: "delete_task", description: "Delete a task (the user can undo).",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } },
  { type: "function", function: { name: "list_events", description: "List calendar events between two dates (inclusive).",
    parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] } } },
  { type: "function", function: { name: "add_event", description: "Add an event. start/end HH:MM, both empty = all day.",
    parameters: { type: "object", properties: { title: { type: "string" }, date: { type: "string" }, start: { type: "string" },
      end: { type: "string" }, notes: { type: "string" } }, required: ["title", "date"] } } },
  { type: "function", function: { name: "update_event", description: "Change an event.",
    parameters: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, date: { type: "string" },
      start: { type: "string" }, end: { type: "string" }, notes: { type: "string" } }, required: ["id"] } } },
  { type: "function", function: { name: "delete_event", description: "Delete an event (the user can undo).",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } },
];

const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));

export function runPlannerTool(store: Store, name: string, a: Record<string, unknown>, changes: string[]): string {
  try {
    switch (name) {
      case "list_tasks": {
        const st = String(a.status ?? "open");
        const tasks = store.listTasks().filter((t) => st === "all" || (st === "done" ? t.done : !t.done));
        return JSON.stringify(tasks.slice(0, 80).map((t) => ({ id: t.id, title: t.title, due: t.due, priority: t.priority, done: t.done,
          notes: t.notes.slice(0, 200) })));
      }
      case "add_task": {
        const t = store.addTask({ title: String(a.title ?? ""), due: str(a.due) ?? "", priority: (str(a.priority) as never) ?? "normal",
          notes: str(a.notes) ?? "" });
        changes.push(`added task "${t.title}"`);
        return JSON.stringify(t);
      }
      case "update_task": {
        const t = store.updateTask(String(a.id), { title: str(a.title), due: str(a.due), priority: str(a.priority) as never, notes: str(a.notes) });
        changes.push(`updated task "${t.title}"`);
        return JSON.stringify(t);
      }
      case "set_task_done": {
        const t = store.setTaskDone(String(a.id), a.done === true || a.done === "true");
        changes.push(`${t.done ? "completed" : "reopened"} "${t.title}"`);
        return JSON.stringify(t);
      }
      case "delete_task": {
        const t = store.getTask(String(a.id));
        store.deleteTask(t.id);
        changes.push(`deleted task "${t.title}"`);
        return "deleted";
      }
      case "list_events": {
        const from = isValidDate(String(a.from)) ? String(a.from) : today();
        const to = isValidDate(String(a.to)) ? String(a.to) : addDays(from, 7);
        return JSON.stringify(store.listEvents(from, to).slice(0, 100).map((e) => ({ id: e.id, title: e.title, date: e.date,
          start: e.start, end: e.end, notes: e.notes.slice(0, 200) })));
      }
      case "add_event": {
        const e = store.addEvent({ title: String(a.title ?? ""), date: String(a.date ?? ""), start: str(a.start) ?? "",
          end: str(a.end) ?? "", notes: str(a.notes) ?? "" });
        changes.push(`added event "${e.title}" on ${e.date}`);
        return JSON.stringify(e);
      }
      case "update_event": {
        const e = store.updateEvent(String(a.id), { title: str(a.title), date: str(a.date), start: str(a.start), end: str(a.end),
          notes: str(a.notes) });
        changes.push(`updated event "${e.title}"`);
        return JSON.stringify(e);
      }
      case "delete_event": {
        const e = store.getEvent(String(a.id));
        store.deleteEvent(e.id);
        changes.push(`deleted event "${e.title}"`);
        return "deleted";
      }
    }
    return `Error: unknown tool ${name}`;
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

/** The head chef works with the planner itself, locally. Returns its answer plus what it changed. */
export async function runPlanner(store: Store, model: string, context: string, message: string, signal?: AbortSignal):
  Promise<{ answer: string; changes: string[] }> {
  const d = new Date();
  const system = `You manage the user's tasks and calendar with the tools. Today is ${today()} (${d.toLocaleDateString("en-US", { weekday: "long" })}).
Look things up with the tools before answering; never guess ids. Make only the changes the user asked for.
After making changes, say exactly what you changed. Dates are YYYY-MM-DD, times HH:MM (24h). ${LANG}`;
  type Msg = { role: string; content: string; tool_calls?: { function: { name: string; arguments: unknown } }[]; tool_name?: string };
  const messages: Msg[] = [{ role: "system", content: system },
    { role: "user", content: `${context ? `Conversation so far:\n${context}\n\n` : ""}Request: ${message}` }];
  const changes: string[] = [];
  for (let turn = 0; turn < 12; turn++) {
    if (signal?.aborted) throw new AgentError("Stopped.");
    const { message: msg } = await ollamaPost<{ message: Msg }>("/api/chat", { model, messages, tools: PLANNER_TOOLS, stream: false,
      keep_alive: KEEP_ALIVE, think: true, options: { temperature: 0.1 } }, 10 * 60_000, signal);
    if (!msg.tool_calls?.length) {
      const recovered = textToolCalls(msg.content ?? "");
      if (recovered.length) msg.tool_calls = recovered;
    }
    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
    if (!msg.tool_calls?.length) return { answer: (msg.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim(), changes };
    for (const call of msg.tool_calls) {
      const raw = call.function.arguments;
      let args: Record<string, unknown> = {};
      try { args = typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>) ?? {}; } catch { /* bad JSON */ }
      messages.push({ role: "tool", tool_name: call.function.name, content: runPlannerTool(store, call.function.name, args, changes) });
    }
  }
  return { answer: "I stopped after too many steps. Here's what I changed so far.", changes };
}
