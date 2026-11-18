// The kitchen. In the Chat, local Qwen 30B is the head chef: it reads each message and decides who cooks.
// In the Team plan, ChatGPT plans and reviews and the others do the work. Every cloud send needs your OK.

export type WorkerId = "chatgpt" | "codex" | "claude" | "claude-chat" | "qwen-coder" | "qwen" | "qwen-fast" | "gpt-oss";

export interface WorkerDef {
  id: WorkerId;
  name: string;
  /** Default Ollama model for local workers (overridable in Connections). */
  model?: string;
  local: boolean;
  /** Edits files in the project folder (only one writer runs at a time per project). */
  writes: boolean;
  /** Typing @mention in the chat sends the message straight to this worker. */
  mention: string;
  role: string;
}

export const WORKERS: Record<WorkerId, WorkerDef> = {
  chatgpt: { id: "chatgpt", name: "ChatGPT", local: false, writes: false, mention: "chatgpt",
    role: "Cloud reasoning (your ChatGPT plan, read-only): hard questions, planning, research-style answers, reviews." },
  codex: { id: "codex", name: "Codex", local: false, writes: true, mention: "codex",
    role: "Cloud coding agent (your ChatGPT plan): multi-file code changes, logic, refactors, fixing bugs, in the project folder." },
  claude: { id: "claude", name: "Claude Code", local: false, writes: true, mention: "claude",
    role: "Cloud coding agent (your Claude Pro): larger builds and UI/front-end work across files in the project folder." },
  "claude-chat": { id: "claude-chat", name: "Claude", local: false, writes: false, mention: "claude-chat",
    role: "Cloud writer and analyst (your Claude Pro, no file access): long or polished writing, nuanced analysis, explanations." },
  "qwen-coder": { id: "qwen-coder", name: "Qwen Coder", model: "qwen3-coder:30b", local: true, writes: true, mention: "coder",
    role: "Local coding agent (list/read/write file tools only): small or medium code and file edits in the project folder." },
  qwen: { id: "qwen", name: "Qwen", model: "qwen3:30b", local: true, writes: false, mention: "qwen",
    role: "Local general worker: drafting, explaining, specs, outlines, reasoning about a sub-problem." },
  "qwen-fast": { id: "qwen-fast", name: "Qwen Fast", model: "qwen3:4b", local: true, writes: false, mention: "fast",
    role: "Local and very fast: extract, classify, reformat, short summaries, checklists. Not for reasoning or code." },
  "gpt-oss": { id: "gpt-oss", name: "GPT-OSS", model: "gpt-oss:20b", local: true, writes: false, mention: "gpt-oss",
    role: "Local reasoning model: second opinions, checking logic, reviewing text or a design for mistakes." },
};

/** Workers the Team plan may assign (ChatGPT plans there, so it never assigns itself work). */
export const ASSIGNABLE: WorkerId[] = ["qwen-coder", "qwen", "qwen-fast", "gpt-oss", "codex", "claude", "claude-chat"];
/** Workers the chat's head chef may route to. */
export const CHAT_ROUTABLE: WorkerId[] = ["qwen", "qwen-fast", "gpt-oss", "qwen-coder", "chatgpt", "codex", "claude", "claude-chat"];
export const CLOUD: WorkerId[] = ["chatgpt", "codex", "claude", "claude-chat"];

export const isWorker = (x: unknown): x is WorkerId => typeof x === "string" && x in WORKERS;
export const isCloud = (w: WorkerId) => !WORKERS[w].local;

/** "@codex fix the bug" → ["codex", "fix the bug"]. Unknown mentions are left in the text. */
export function parseMention(text: string): [WorkerId | null, string] {
  const m = /^\s*@([a-z-]+)\b[\s,:]*/i.exec(text);
  if (!m) return [null, text];
  const hit = (Object.values(WORKERS) as WorkerDef[]).find((w) => w.mention === m[1].toLowerCase());
  return hit ? [hit.id, text.slice(m[0].length).trim()] : [null, text];
}
