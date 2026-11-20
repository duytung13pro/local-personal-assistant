// A small coding agent for a local Ollama model (e.g. qwen3-coder): the model may only list, read and write
// files inside one project folder, through tools this app implements and checks. There is no shell, no
// network and no way to run code. (Codex's own --oss mode hangs with the current Codex build on Windows.)
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { AgentError, KEEP_ALIVE, NUM_CTX, ollamaPost } from "./providers";

const MAX_TURNS = 30;
const MAX_FILE = 300_000;
const SKIP = new Set(["node_modules", ".git", "__pycache__"]);

const TOOLS = [
  { type: "function", function: { name: "list_files", description: "List all files in the project folder.",
    parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "read_file", description: "Read a text file from the project folder.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Relative path" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Create or overwrite a text file in the project folder (folders are created).",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
];

const SYSTEM = `You are a careful software engineer working in one project folder.
Use the tools to look at existing files and to write files. You cannot run commands or code.
Write complete files (no placeholders like "..."). Keep the solution small and working.
When you are done, reply WITHOUT a tool call: list the files you created or changed and what each does.`;

/** Resolve a model-supplied relative path, refusing anything outside the folder or through a link. */
export async function safePath(folder: string, rel: unknown): Promise<string> {
  const p = String(rel ?? "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!p || p.startsWith("/") || /^[a-z]:/i.test(p)) throw new AgentError(`Path must be relative: "${p}"`);
  const full = resolve(folder, p);
  if (full !== folder && !full.startsWith(folder + sep)) throw new AgentError(`Path is outside the project folder: "${p}"`);
  let cur = folder;
  for (const part of relative(folder, full).split(sep)) {
    cur = join(cur, part);
    try {
      if ((await lstat(cur)).isSymbolicLink()) throw new AgentError(`Refusing to follow a link: "${p}"`);
    } catch (e) {
      if (e instanceof AgentError) throw e;
      break; // does not exist yet: fine
    }
  }
  return full;
}

async function listAll(folder: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (out.length >= 400 || SKIP.has(e.name) || e.isSymbolicLink()) continue;
      const f = join(d, e.name);
      if (e.isDirectory()) await walk(f);
      else out.push(relative(folder, f).split(sep).join("/"));
    }
  };
  await walk(folder);
  return out.sort();
}

export async function runTool(folder: string, name: string, args: Record<string, unknown>, changed: Set<string>): Promise<string> {
  try {
    if (name === "list_files") return (await listAll(folder)).join("\n") || "(empty folder)";
    if (name === "read_file") {
      const f = await safePath(folder, args.path);
      const text = await readFile(f, "utf8");
      return text.length > MAX_FILE ? text.slice(0, MAX_FILE) + "\n[truncated]" : text;
    }
    if (name === "write_file") {
      const content = String(args.content ?? "");
      if (content.length > MAX_FILE) return "Error: file too large (300 KB limit).";
      const f = await safePath(folder, args.path);
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, content, "utf8");
      const rel = relative(folder, f).split(sep).join("/");
      changed.add(rel);
      return `Wrote ${rel} (${content.length} characters).`;
    }
    return `Error: unknown tool "${name}".`;
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

/** qwen3-coder on Ollama often writes its tool calls as text instead of structured calls:
 *   <function=write_file><parameter=path>a.html</parameter><parameter=content>...</parameter></function>
 * (sometimes inside <tool_call>…</tool_call>, sometimes as JSON {"name":..,"arguments":{..}}). Recover them. */
export function textToolCalls(content: string): { function: { name: string; arguments: Record<string, unknown> } }[] {
  const calls: { function: { name: string; arguments: Record<string, unknown> } }[] = [];
  const fnRe = /<function=([a-z_]+)>([\s\S]*?)(?:<\/function>|$)/gi;
  for (const m of content.matchAll(fnRe)) {
    const args: Record<string, unknown> = {};
    for (const p of m[2].matchAll(/<parameter=([a-z_]+)>\n?([\s\S]*?)\n?<\/parameter>/gi)) args[p[1]] = p[2];
    calls.push({ function: { name: m[1], arguments: args } });
  }
  if (calls.length) return calls;
  for (const m of content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)) {
    try {
      const j = JSON.parse(m[1]) as { name?: string; arguments?: Record<string, unknown> };
      if (j.name) calls.push({ function: { name: j.name, arguments: j.arguments ?? {} } });
    } catch { /* not JSON */ }
  }
  return calls;
}

interface Msg { role: string; content: string; tool_calls?: { function: { name: string; arguments: unknown } }[]; tool_name?: string }
interface ChatReply { message: Msg; prompt_eval_count?: number; eval_count?: number }

// ---- handover: when the model's memory (context) is nearly full, it writes a short note and a fresh session
// continues from it, instead of failing or silently forgetting the start of the task.
/** Hand over once the conversation uses this many tokens (70% of the window leaves room for the next file). */
export const HANDOVER_AT = Math.floor(NUM_CTX * 0.7);
const MAX_HANDOVERS = 3;
export const HANDOVER_ASK = `Your working memory is almost full, so a fresh engineer will take over this task.
Write a handover note of at most 10 short lines: what is done (files written and what is in them), what is left to do,
and names/decisions they must keep (ids, classes, function names). Reply with the note only, no tool calls.`;

/** Rough token count when Ollama doesn't report one: ~3.5 characters per token for code and English. */
export function approxTokens(messages: { content: string }[]): number {
  return Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 3.5);
}

/** The fresh session's first message: the original task plus the previous engineer's note. */
export function handoverPrompt(task: string, note: string, files: string[], n: number): string {
  const clean = note.replace(/<\/?tool_call>/g, "").split("\n").filter((l) => l.trim()).slice(0, 10).join("\n");
  return `${task}\n\n## Handover note #${n} from the previous engineer (they ran out of memory)\n${clean || "(no note)"}\n` +
    `Files written so far: ${files.join(", ") || "none"}\n\nContinue from where they stopped. Re-read only the files you need; ` +
    "do not start over or rewrite finished files.";
}

export async function runLocalCoder(model: string, prompt: string, folder: string, timeoutMs = 20 * 60_000,
  signal?: AbortSignal, handoverAt = HANDOVER_AT): Promise<string> {
  const root = resolve(folder);
  await mkdir(root, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const changed = new Set<string>();
  let messages: Msg[] = [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }];
  const notes: string[] = [];
  const ask = async (msgs: Msg[], tools: boolean): Promise<ChatReply> => {
    const left = deadline - Date.now();
    if (left <= 0) throw new AgentError("Timed out.");
    if (signal?.aborted) throw new AgentError("Stopped.");
    return ollamaPost<ChatReply>("/api/chat", { model, messages: msgs, ...(tools ? { tools: TOOLS } : {}), stream: false,
      keep_alive: KEEP_ALIVE, options: { temperature: 0.2, num_ctx: NUM_CTX } }, left, signal);
  };
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const reply = await ask(messages, true);
    const msg = reply.message;
    if (!msg.tool_calls?.length) {
      const recovered = textToolCalls(msg.content ?? "");
      if (recovered.length) msg.tool_calls = recovered;
    }
    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
    if (!msg.tool_calls?.length) {
      const files = [...changed];
      const text = (msg.content ?? "").replace(/<\/?tool_call>/g, "").trim();
      return `${text}${notes.length ? `\n\n(Handed over ${notes.length}× when memory filled up.)` : ""}` +
        `${files.length ? `\n\nFiles written: ${files.join(", ")}` : "\n\n(No files were written.)"}`;
    }
    for (const call of msg.tool_calls) {
      const raw = call.function.arguments;
      let args: Record<string, unknown> = {};
      try { args = typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>) ?? {}; } catch { /* bad JSON */ }
      messages.push({ role: "tool", tool_name: call.function.name, content: await runTool(root, call.function.name, args, changed) });
    }
    // Memory check: what Ollama counted for this turn, or our estimate including the tool results just added.
    const used = Math.max((reply.prompt_eval_count ?? 0) + (reply.eval_count ?? 0), approxTokens(messages));
    if (used >= handoverAt && notes.length < MAX_HANDOVERS) {
      const note = (await ask([...messages, { role: "user", content: HANDOVER_ASK }], false)).message.content ?? "";
      notes.push(note);
      messages = [{ role: "system", content: SYSTEM }, { role: "user", content: handoverPrompt(prompt, note, [...changed], notes.length) }];
    }
  }
  throw new AgentError(`Stopped after ${MAX_TURNS} tool rounds. Files written so far: ${[...changed].join(", ") || "none"}.`);
}
