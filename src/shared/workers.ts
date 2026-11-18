// The team. ChatGPT only plans and reviews; local models do the work, several at once.

export type WorkerId = "chatgpt" | "qwen-coder" | "qwen" | "qwen-fast" | "gpt-oss" | "claude";

export interface WorkerDef {
  id: WorkerId;
  name: string;
  /** Default Ollama model for local workers (overridable in Connections). */
  model?: string;
  local: boolean;
  /** Edits files in the project folder (only one writer runs at a time per project). */
  writes: boolean;
  role: string;
}

export const WORKERS: Record<WorkerId, WorkerDef> = {
  chatgpt: { id: "chatgpt", name: "ChatGPT", local: false, writes: false,
    role: "Planner and reviewer only. Splits the brief into tasks, assigns workers, reviews results. Never does the work itself." },
  "qwen-coder": { id: "qwen-coder", name: "Qwen Coder", model: "qwen3-coder:30b", local: true, writes: true,
    role: "Writes and edits code and files in the project folder (local agent with list/read/write file tools only). Use for every task that creates or changes files." },
  qwen: { id: "qwen", name: "Qwen", model: "qwen3:30b", local: true, writes: false,
    role: "General local worker: drafting text, explaining, designing data models, writing specs or test cases as text, reasoning about a sub-problem." },
  "qwen-fast": { id: "qwen-fast", name: "Qwen Fast", model: "qwen3:4b", local: true, writes: false,
    role: "Very fast and small: extract, classify, reformat, short summaries, checklists. Not for reasoning or code." },
  "gpt-oss": { id: "gpt-oss", name: "GPT-OSS", model: "gpt-oss:20b", local: true, writes: false,
    role: "Local reasoning model: second opinions, tricky logic, reviewing a design or a piece of text for mistakes." },
  claude: { id: "claude", name: "Claude", local: false, writes: true,
    role: "Cloud coding agent (Claude Pro). Only when enabled: large or difficult multi-file builds the local coder failed at." },
};

/** Workers ChatGPT may assign tasks to (it never assigns itself). */
export const ASSIGNABLE: WorkerId[] = ["qwen-coder", "qwen", "qwen-fast", "gpt-oss", "claude"];

export const isWorker = (x: unknown): x is WorkerId => typeof x === "string" && x in WORKERS;
