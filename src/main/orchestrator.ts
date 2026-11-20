// ChatGPT plans and reviews; local models do the work, in parallel where tasks don't depend on each other.
//
//   brief ──► ChatGPT plans tasks + dependencies ──► workers run (independent tasks at the same time)
//                ▲                                                   │
//                └──────── ChatGPT reviews results, adds fixes ◄─────┘
//
// If ChatGPT is unavailable, local Qwen plans with the same instructions; if that fails, fixed rules do.
import type { Project, Step, WorkerId } from "../shared/types";
import { ASSIGNABLE, WORKERS, isWorker } from "../shared/workers";

export interface Draft { ref?: string; title: string; agent: WorkerId; why: string; prompt: string; deps?: string[] }

export function teamDescription(available: WorkerId[]): string {
  return ASSIGNABLE.filter((w) => available.includes(w))
    .map((w) => `- "${w}": ${WORKERS[w].role}`).join("\n");
}

export function plannerPrompt(p: Project, available: WorkerId[]): string {
  return `You are the planner for a small team of AI workers on the user's PC. You do NOT do the work yourself:
you split the project into tasks and assign each task to the worker that fits it best.

Workers you can assign (only these):
${teamDescription(available)}

Rules:
- 2 to 8 tasks. Each task is self-contained: its prompt says exactly what to produce.
- Every task that creates or edits files goes to "qwen-coder"${available.includes("claude") ? ' (or "claude" only for very large builds)' : ""}.
- Prefer the smallest worker that can do a task well. Workers run locally, so they are free.
- Use "deps" so tasks that need another task's result wait for it. Tasks without dependencies on each other
  run AT THE SAME TIME, so split work so that several tasks can run in parallel.
- File-writing tasks run one at a time; keep them few and well-scoped.
- Do not read or modify files yourself. Do not include personal data that is not in the brief.

Reply with JSON only, no prose:
{"tasks":[{"id":"t1","title":"short title","worker":"qwen","why":"one short reason","deps":[],"prompt":"..."}]}

# Project: ${p.title}
## Brief
${p.brief.trim()}
${p.notes.trim() ? `## Notes\n${p.notes.trim()}\n` : ""}`;
}

export function reviewPrompt(p: Project, steps: Step[], files: string[], available: WorkerId[]): string {
  const results = steps.filter((s) => s.agent !== "chatgpt").map((s) =>
    `### ${s.title} (${s.agent}, ${s.status})\n${s.status === "done" && wantsReport(s) ? reportOf(s.output)
      : (s.output || "(no output)").trim().slice(0, 6000)}`).join("\n\n"); // builders: short report; the reviewer reads the files
  return `You are the reviewer for a team of local AI workers. Check their results against the brief.
You may read the files in the current folder; do not modify anything.

# Project: ${p.title}
## Brief
${p.brief.trim()}

## Files in the project folder
${files.length ? files.slice(0, 200).join("\n") : "(none)"}

## Worker results
${results || "(nothing has run yet)"}

Decide whether the brief is satisfied. If not, write follow-up tasks for these workers:
${teamDescription(available)}
Each follow-up must be concrete (which file, what is wrong, what to change).

Reply with JSON only:
{"verdict":"done"|"needs_work","summary":"3-6 sentences for the user","tasks":[{"id":"f1","title":"...","worker":"qwen-coder","why":"...","deps":[],"prompt":"..."}]}`;
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
}

/** Parse planner/reviewer tasks. Returns null when unusable. Only workers in `allowed` are accepted. */
export function parseTasks(raw: unknown, allowed: WorkerId[] = ASSIGNABLE): Draft[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: Draft[] = [];
  const seen = new Set<string>();
  for (const [i, t] of raw.slice(0, 10).entries()) {
    const o = t as Record<string, unknown>;
    const agent = String(o.worker ?? o.agent ?? "").toLowerCase();
    const title = String(o.title ?? "").trim();
    if (!isWorker(agent) || !allowed.includes(agent) || !title) return null;
    const ref = String(o.id ?? `t${i + 1}`);
    const deps = Array.isArray(o.deps) ? o.deps.map(String).filter((d) => seen.has(d)) : []; // only earlier tasks
    seen.add(ref);
    out.push({ ref, title: title.slice(0, 160), agent, why: String(o.why ?? "").trim().slice(0, 400),
      prompt: String(o.prompt ?? title).trim().slice(0, 8000), deps });
  }
  return out;
}

export function parsePlan(text: string, allowed: WorkerId[] = ASSIGNABLE): Draft[] | null {
  try {
    const data = extractJson(text) as { tasks?: unknown; steps?: unknown };
    return parseTasks(data.tasks ?? data.steps, allowed);
  } catch {
    return null;
  }
}

export interface Review { verdict: "done" | "needs_work"; summary: string; tasks: Draft[] }

export function parseReview(text: string, allowed: WorkerId[] = ASSIGNABLE): Review | null {
  try {
    const d = extractJson(text) as { verdict?: string; summary?: string; tasks?: unknown };
    const verdict = d.verdict === "done" ? "done" : "needs_work";
    const tasks = Array.isArray(d.tasks) && d.tasks.length ? parseTasks(d.tasks, allowed) : [];
    if (tasks === null || !d.summary) return null;
    return { verdict, summary: String(d.summary).slice(0, 3000), tasks: verdict === "done" ? [] : tasks };
  } catch {
    return null;
  }
}

/** A usable split has 2+ tasks, and work that builds something has a file-writing task. */
export function goodPlan(brief: string, steps: Draft[]): boolean {
  if (steps.length < 2) return false;
  const builds = /\b(build|make|create|implement|app|page|website|script|code|program|tool|game)\b/i.test(brief);
  return !builds || steps.some((s) => WORKERS[s.agent].writes);
}

/** Fallback when no model can plan: spec and test ideas in parallel, then build, then a local review. */
export function rulePlan(available: WorkerId[]): Draft[] {
  const writer: WorkerId = available.includes("qwen-coder") ? "qwen-coder" : available.includes("claude") ? "claude" : "qwen";
  const thinker: WorkerId = available.includes("qwen") ? "qwen" : "qwen-fast";
  const checker: WorkerId = available.includes("gpt-oss") ? "gpt-oss" : thinker;
  return [
    { ref: "t1", title: "Write a short spec", agent: thinker, why: "Turns the brief into concrete requirements.", deps: [],
      prompt: "Write a short spec: features, files, data, and what 'done' means." },
    { ref: "t2", title: "List test cases", agent: checker, why: "Runs in parallel with the spec.", deps: [],
      prompt: "List 8-12 concrete test cases (input → expected result) for this brief." },
    { ref: "t3", title: "Build it", agent: writer, why: "Writes the files.", deps: ["t1", "t2"],
      prompt: "Implement the spec in this folder so the listed test cases would pass. Keep it small and working." },
    { ref: "t4", title: "Check the result", agent: checker, why: "A second model looks for mistakes.", deps: ["t3"],
      prompt: "Compare the builder's report with the spec and test cases. List concrete problems, most severe first." },
  ];
}

/** Builders and checkers inside a team job report back to the head chef in at most 10 lines (their full output stays
 * on the Team plan board). Text deliverables (an itinerary, an email) are the answer itself, so they are passed whole. */
export const REPORT_LINES = 10;
export function wantsReport(step: Pick<Step, "agent" | "title">): boolean {
  return WORKERS[step.agent].writes || /\b(review|check|test|verify|audit|qa)\w*/i.test(step.title);
}
const REPORT_RULE = `Start your answer with a "## Report" section of at most ${REPORT_LINES} short lines for the head chef: ` +
  `what you did, files changed, and any open problems (most important first). Then a "## Details" section with everything else.`;

/** The worker's short report: its "## Report" section, else its first lines; never more than REPORT_LINES lines. */
export function reportOf(output: string): string {
  const text = output.replace(/<\/?tool_call>/g, "").trim();
  const m = /^#{1,3}\s*Report\s*:?\s*$([\s\S]*?)(?=^#{1,3}\s|$(?![\s\S]))/im.exec(text);
  const lines = (m ? m[1] : text).split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
  const out = lines.slice(0, REPORT_LINES).map((l) => l.slice(0, 300));
  // The local coder's own facts are always kept: handovers and the list of files written.
  for (const re of [/^\(Handed over \d+× .*\)$/m, /^Files written: .*$/m]) {
    const line = re.exec(text)?.[0];
    if (line && !out.includes(line)) out.push(line);
  }
  return out.join("\n");
}

/** What a worker receives: the project, the results of the tasks it depends on, and its own task. */
export function stepPrompt(p: Project, steps: Step[], step: Step, files = "", report = false): string {
  const deps = steps.filter((s) => step.deps.includes(s.id) && s.status === "done" && s.output.trim());
  const writes = WORKERS[step.agent].writes;
  // A text-only model can't open files, so after a build it gets the files themselves, not just the builder's summary.
  const afterBuild = !writes && deps.some((s) => WORKERS[s.agent].writes);
  const parts = [
    `# Project: ${p.title}`,
    `## Brief\n${p.brief.trim() || "(no brief)"}`,
    p.notes.trim() ? `## Notes\n${p.notes.trim()}` : "",
    ...deps.map((s) => `## Result of "${s.title}" (${WORKERS[s.agent].name})\n${s.output.trim().slice(0, 12000)}`),
    afterBuild && files ? `## Current project files (read these; judge only what is actually in them)\n${files}` : "",
    `## Your task: ${step.title}\n${step.prompt.trim()}`,
    writes ? "Create and edit files only inside the current folder. Do not run or install anything. First list and read the files " +
      "already there and stay consistent with them (same names, ids, classes; link new CSS/JS files from the HTML). " +
      (report ? REPORT_RULE : "When finished, list the files you changed and what each does.")
      : afterBuild ? `Answer in Markdown. Be concrete and brief. Quote the file and line for each problem; do not report problems the files above don't have.${report ? ` ${REPORT_RULE}` : ""}`
      : `Answer in Markdown. Be concrete and brief.${report ? ` ${REPORT_RULE}` : ""}`,
  ];
  return parts.filter(Boolean).join("\n\n");
}

/** Dependency levels for display: tasks in the same wave can run at the same time. */
export function waves(steps: Pick<Step, "id" | "deps">[]): Map<string, number> {
  const level = new Map<string, number>();
  const byId = new Map(steps.map((s) => [s.id, s]));
  const visit = (id: string, stack: Set<string>): number => {
    if (level.has(id)) return level.get(id)!;
    const s = byId.get(id);
    if (!s || stack.has(id)) return 0;
    stack.add(id);
    const l = s.deps.length ? 1 + Math.max(...s.deps.map((d) => visit(d, stack))) : 0;
    stack.delete(id);
    level.set(id, l);
    return l;
  };
  steps.forEach((s) => visit(s.id, new Set()));
  return level;
}
