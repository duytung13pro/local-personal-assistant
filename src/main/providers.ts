// The agents: local models through Ollama's HTTP API, ChatGPT/Codex through the Codex CLI, Claude through Claude Code.
// CLIs run with list argv, the prompt on stdin, bounded output, a timeout and API-key variables
// removed, so they use the subscription sign-in and never silently bill an API key.
import { spawn, execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { AgentStatus, WorkerId } from "../shared/types";
import { WORKERS } from "../shared/workers";

export const OLLAMA = "http://127.0.0.1:11434";
const MAX_OUT = 2_000_000;
export const JOB_TIMEOUT_MS = 10 * 60_000;
const STRIP = ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];
export const CLAUDE_TOOLS = "Read,Write,Edit,Glob,Grep";

export class AgentError extends Error {}

function which(names: string[], extra: string[] = []): string | null {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...extra].filter(Boolean);
  for (const d of dirs) for (const n of names) {
    const p = join(d, n);
    if (existsSync(p)) return p;
  }
  return null;
}

export function findClaude(): string | null {
  return which(["claude.exe", "claude.cmd", "claude"], [join(homedir(), ".local", "bin")]);
}

/** Codex CLI: on PATH, from npm, or the copy bundled with the ChatGPT Codex desktop app (newest first). */
export function findCodex(): string | null {
  const npm = process.env.APPDATA ? [join(process.env.APPDATA, "npm")] : [];
  const onPath = which(["codex.exe", "codex.cmd", "codex"], npm);
  if (onPath) return onPath;
  const bundled = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin") : "";
  if (!bundled || !existsSync(bundled)) return null;
  const found = readdirSync(bundled).map((d) => join(bundled, d, "codex.exe")).filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return found[0] ?? null;
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of STRIP) delete env[k];
  env.DISABLE_AUTOUPDATER = "1";
  return env;
}

/** .cmd/.bat shims can't be spawned directly on Windows; run them through cmd.exe (static args only). */
function launch(exe: string, args: string[]): [string, string[]] {
  if (/\.(cmd|bat)$/i.test(exe)) return [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", exe, ...args]];
  return [exe, args];
}

export interface RunResult { code: number; stdout: string; stderr: string }

export interface RunOpts { cwd?: string; input?: string; timeoutMs?: number; signal?: AbortSignal }

export function runCli(exe: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  const [cmd, argv] = launch(exe, args);
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new AgentError("Stopped."));
    const child = spawn(cmd, argv, { cwd: opts.cwd, env: cleanEnv(), windowsHide: true, shell: false });
    const kill = () => { if (child.pid) execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => undefined); };
    opts.signal?.addEventListener("abort", () => { kill(); reject(new AgentError("Stopped.")); }, { once: true });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => { if (out.length < MAX_OUT) out += d; });
    child.stderr.on("data", (d: string) => { if (err.length < MAX_OUT) err += d; });
    const timer = setTimeout(() => {
      kill();
      reject(new AgentError(`Timed out after ${Math.round((opts.timeoutMs ?? JOB_TIMEOUT_MS) / 60000)} minutes.`));
    }, opts.timeoutMs ?? JOB_TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(timer); reject(new AgentError(`Could not start ${exe}: ${e.message}`)); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout: out, stderr: err }); });
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.input ?? "");
  });
}

// ---- Qwen via Ollama -----------------------------------------------------------------------------

export async function ollamaModels(): Promise<string[]> {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return [];
    const j = (await r.json()) as { models?: { name: string }[] };
    return (j.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

export async function loadedModels(): Promise<string[]> {
  try {
    const r = await fetch(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(3000) });
    const j = (await r.json()) as { models?: { name: string }[] };
    return (j.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

/** Qwen3 thinking models (qwen3:30b, and the 2507 qwen3:4b) leak their reasoning into the answer when told not to
 * think ("Okay, let me tackle this…"), so always let them think in Ollama's separate `thinking` field and keep only
 * the answer. JSON-constrained calls (routing) may still pass think:false explicitly. */
export function thinkOption(model: string): { think?: boolean } {
  return /^qwen3(?!-coder)/i.test(model) ? { think: true } : {};
}

/** Keep worker models in memory between tasks: loading an 18 GB model from disk can take minutes. */
export const KEEP_ALIVE = "30m";

/** POST JSON to Ollama with node:http. (fetch gives up after 5 minutes without response headers, and
 * Ollama sends none while it loads a large model, which can take longer than that.) */
export function ollamaPost<T>(path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((resolveP, reject) => {
    if (signal?.aborted) return reject(new AgentError("Stopped."));
    const req = request(`${OLLAMA}${path}`, { method: "POST",
      headers: { "content-type": "application/json", "content-length": data.length } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 500) >= 400) return reject(new AgentError(`Ollama returned ${res.statusCode}: ${text.slice(0, 300)}`));
        try { resolveP(JSON.parse(text) as T); } catch { reject(new AgentError("Ollama sent an unreadable answer.")); }
      });
    });
    const timer = setTimeout(() => req.destroy(new AgentError(`Timed out after ${Math.round(timeoutMs / 60000)} minutes.`)), timeoutMs);
    signal?.addEventListener("abort", () => req.destroy(new AgentError("Stopped.")), { once: true });
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e instanceof AgentError ? e : new AgentError(`Ollama is not reachable at ${OLLAMA} (${e.message}). Start Ollama and try again.`));
    });
    req.end(data);
  });
}

/** One chat turn with a local Ollama model; returns only the answer (never the model's reasoning). */
export async function ollamaChat(model: string, system: string, user: string,
  opts: { json?: boolean; timeoutMs?: number; signal?: AbortSignal; think?: boolean } = {}): Promise<string> {
  // With format "json" the output is constrained to JSON, so reasoning can't leak into it: thinking can be
  // skipped for speed by passing think: false.
  const think = opts.think === undefined ? thinkOption(model) : /^qwen3(?!-coder)/i.test(model) ? { think: opts.think } : {};
  const j = await ollamaPost<{ message?: { content?: string } }>("/api/chat", {
    model, stream: false, keep_alive: KEEP_ALIVE, ...think, ...(opts.json ? { format: "json" } : {}),
    options: { temperature: 0.2 },
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  }, opts.timeoutMs ?? JOB_TIMEOUT_MS, opts.signal);
  return (j.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/** Like ollamaChat, but calls onText with the answer so far as it is generated (reasoning is never shown). */
export function ollamaStream(model: string, system: string, user: string, onText: (soFar: string) => void,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string> {
  const data = Buffer.from(JSON.stringify({ model, stream: true, keep_alive: KEEP_ALIVE, ...thinkOption(model),
    options: { temperature: 0.3 }, messages: [{ role: "system", content: system }, { role: "user", content: user }] }));
  const timeoutMs = opts.timeoutMs ?? JOB_TIMEOUT_MS;
  return new Promise((resolveP, reject) => {
    if (opts.signal?.aborted) return reject(new AgentError("Stopped."));
    let text = "";
    let buf = "";
    let last = 0;
    const req = request(`${OLLAMA}/api/chat`, { method: "POST",
      headers: { "content-type": "application/json", "content-length": data.length } }, (res) => {
      if ((res.statusCode ?? 500) >= 400) {
        let err = "";
        res.on("data", (c: Buffer) => { err += c.toString("utf8"); });
        res.on("end", () => { clearTimeout(timer); reject(new AgentError(`Ollama returned ${res.statusCode}: ${err.slice(0, 300)}`)); });
        return;
      }
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const j = JSON.parse(line) as { message?: { content?: string }; error?: string };
            if (j.error) { req.destroy(new AgentError(`Ollama: ${j.error}`)); return; }
            if (j.message?.content) {
              text += j.message.content;
              const now = Date.now();
              if (now - last > 60) { last = now; onText(clean(text)); } // ~16 updates/second is plenty
            }
          } catch { /* partial line */ }
        }
      });
      res.on("end", () => { clearTimeout(timer); const out = clean(text); onText(out); resolveP(out); });
    });
    const clean = (t: string) => t.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
    const timer = setTimeout(() => req.destroy(new AgentError(`Timed out after ${Math.round(timeoutMs / 60000)} minutes.`)), timeoutMs);
    opts.signal?.addEventListener("abort", () => req.destroy(new AgentError("Stopped.")), { once: true });
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e instanceof AgentError ? e : new AgentError(`Ollama is not reachable at ${OLLAMA} (${e.message}).`));
    });
    req.end(data);
  });
}
export const qwenChat = ollamaChat;

// ---- Codex and Claude --------------------------------------------------------------------------

/** ChatGPT through the signed-in Codex CLI, read-only: answers, plans and reviews, never edits. */
export async function runCodex(prompt: string, folder: string, resultFile: string, signal?: AbortSignal): Promise<string> {
  return codexExec(["--sandbox", "read-only", "--ignore-user-config"], prompt, folder, resultFile, JOB_TIMEOUT_MS, signal);
}

/** Codex as a coding agent: may edit files inside `folder` only. Your other Codex settings (plugins, MCP
 * servers, computer use) are ignored; only the Windows sandbox mode is kept, without which Codex falls back to
 * read-only. Files it writes are owned by Codex's sandbox account but remain deletable by you. */
export async function runCodexEdit(prompt: string, folder: string, resultFile: string, signal?: AbortSignal): Promise<string> {
  return codexExec(["--sandbox", "workspace-write", "--ignore-user-config", "-c", 'windows.sandbox="elevated"'],
    prompt, folder, resultFile, 2 * JOB_TIMEOUT_MS, signal);
}

async function codexExec(mode: string[], prompt: string, folder: string, resultFile: string, timeoutMs: number,
  signal?: AbortSignal): Promise<string> {
  const exe = findCodex();
  if (!exe) throw new AgentError("Codex CLI was not found. Install the ChatGPT Codex app or: npm install -g @openai/codex");
  const r = await runCli(exe, ["exec", ...mode, "--skip-git-repo-check", "--ephemeral",
    "--color", "never", "--output-last-message", resultFile, "-C", folder, "-"], { cwd: folder, input: prompt, timeoutMs, signal });
  const { readFile } = await import("node:fs/promises");
  const last = existsSync(resultFile) ? (await readFile(resultFile, "utf8")).trim() : "";
  if (r.code !== 0 && !last) throw new AgentError(`Codex failed (exit ${r.code}): ${(r.stderr || r.stdout).slice(-1500)}`);
  return last || r.stdout.trim();
}

/** Claude Code as a coding agent: Read/Write/Edit/Glob/Grep inside `folder`, no shell, no web, no MCP. */
export async function runClaude(prompt: string, folder: string, signal?: AbortSignal): Promise<string> {
  return claudeExec(["--tools", CLAUDE_TOOLS, "--allowedTools", CLAUDE_TOOLS, "--permission-mode", "acceptEdits"], prompt, folder, signal);
}

/** Claude for answers only: no tools at all. */
export async function runClaudeChat(prompt: string, folder: string, signal?: AbortSignal): Promise<string> {
  return claudeExec(["--tools", ""], prompt, folder, signal);
}

async function claudeExec(mode: string[], prompt: string, folder: string, signal?: AbortSignal): Promise<string> {
  const exe = findClaude();
  if (!exe) throw new AgentError("Claude Code is not installed. See Connections.");
  const r = await runCli(exe, ["-p", "--output-format", "json", "--safe-mode", "--restricted", "--no-chrome",
    "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", ...mode,
    "--permission-prompts", "none"], { cwd: folder, input: prompt, signal });
  try {
    const j = JSON.parse(r.stdout) as { result?: string; is_error?: boolean; subtype?: string };
    if (j.is_error) throw new AgentError(`Claude reported an error (${j.subtype ?? "unknown"}): ${(j.result ?? "").slice(0, 1500)}`);
    return (j.result ?? "").trim();
  } catch (e) {
    if (e instanceof AgentError) throw e;
    throw new AgentError(`Claude failed (exit ${r.code}): ${(r.stderr || r.stdout).slice(-1500)}`);
  }
}

// ---- status for the Connections view ---------------------------------------------------------------

async function version(exe: string | null): Promise<string> {
  if (!exe) return "";
  try {
    const r = await runCli(exe, ["--version"], { timeoutMs: 20_000 });
    return (r.stdout || r.stderr).trim().split(/\r?\n/)[0] ?? "";
  } catch {
    return "";
  }
}

export async function agentStatuses(models: Record<WorkerId, string>, enabled: Record<WorkerId, boolean>):
  Promise<{ agents: AgentStatus[]; models: string[]; loaded: string[] }> {
  const [list, loaded, claudeV, codexV] = await Promise.all([ollamaModels(), loadedModels(), version(findClaude()), version(findCodex())]);
  const local = (id: WorkerId): AgentStatus => {
    const m = models[id];
    const ok = list.includes(m);
    return { id, name: WORKERS[id].name, cloud: false, model: m, enabled: enabled[id], available: ok,
      detail: !list.length ? "Ollama is not running" : !list.includes(m) ? `${m} is not downloaded` :
        `${m}${loaded.includes(m) ? " · loaded" : ""}`,
      hint: !list.length ? "Start the Ollama app, then press Refresh." : `Run: ollama pull ${m}` };
  };
  const cloud = (id: WorkerId, v: string, hint: string): AgentStatus => ({ id, name: WORKERS[id].name, cloud: true, model: "",
    enabled: id === "chatgpt" ? true : enabled[id], available: !!v, detail: v || "not found", hint });
  const codexHint = "Install the ChatGPT Codex app (or npm install -g @openai/codex), then: codex login";
  const claudeHint = "Install Claude Code, then run: claude auth login";
  const agents: AgentStatus[] = [
    local("qwen"), local("qwen-coder"), local("qwen-fast"), local("gpt-oss"),
    cloud("chatgpt", codexV, codexHint), cloud("codex", codexV, codexHint),
    cloud("claude", claudeV, claudeHint), cloud("claude-chat", claudeV, claudeHint),
  ];
  return { agents, models: list, loaded };
}
