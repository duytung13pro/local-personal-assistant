// The three agents: local Qwen (Ollama HTTP), OpenAI Codex CLI and Claude Code CLI.
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

export function runCli(exe: string, args: string[], opts: { cwd?: string; input?: string; timeoutMs?: number } = {}):
  Promise<RunResult> {
  const [cmd, argv] = launch(exe, args);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { cwd: opts.cwd, env: cleanEnv(), windowsHide: true, shell: false });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => { if (out.length < MAX_OUT) out += d; });
    child.stderr.on("data", (d: string) => { if (err.length < MAX_OUT) err += d; });
    const timer = setTimeout(() => {
      if (child.pid) execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => undefined);
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

/** Thinking models (qwen3:30b) leak their reasoning into the answer when told not to think, so let them think
 * in Ollama's separate `thinking` field and keep only the answer. Small models skip thinking for speed. */
export function thinkOption(model: string): { think?: boolean } {
  if (!/^qwen3(?!-coder)/i.test(model)) return {};
  return /:(0\.6|1\.7|4)b/i.test(model) ? { think: false } : { think: true };
}

/** Keep worker models in memory between tasks: loading an 18 GB model from disk can take minutes. */
export const KEEP_ALIVE = "30m";

/** POST JSON to Ollama with node:http. (fetch gives up after 5 minutes without response headers, and
 * Ollama sends none while it loads a large model, which can take longer than that.) */
export function ollamaPost<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((resolveP, reject) => {
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
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e instanceof AgentError ? e : new AgentError(`Ollama is not reachable at ${OLLAMA} (${e.message}). Start Ollama and try again.`));
    });
    req.end(data);
  });
}

/** One chat turn with a local Ollama model; returns only the answer (never the model's reasoning). */
export async function ollamaChat(model: string, system: string, user: string, opts: { json?: boolean; timeoutMs?: number } = {}):
  Promise<string> {
  const j = await ollamaPost<{ message?: { content?: string } }>("/api/chat", {
    model, stream: false, keep_alive: KEEP_ALIVE, ...thinkOption(model), ...(opts.json ? { format: "json" } : {}),
    options: { temperature: 0.2 },
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  }, opts.timeoutMs ?? JOB_TIMEOUT_MS);
  return (j.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
export const qwenChat = ollamaChat;

// ---- Codex and Claude --------------------------------------------------------------------------

/** ChatGPT through the signed-in Codex CLI. Read-only: it plans and reviews, it never edits. */
export async function runCodex(prompt: string, folder: string, resultFile: string): Promise<string> {
  return codexExec(["--sandbox", "read-only", "--ignore-user-config"], prompt, folder, resultFile, JOB_TIMEOUT_MS);
}

async function codexExec(mode: string[], prompt: string, folder: string, resultFile: string, timeoutMs: number): Promise<string> {
  const exe = findCodex();
  if (!exe) throw new AgentError("Codex CLI was not found. Install the ChatGPT Codex app or: npm install -g @openai/codex");
  const r = await runCli(exe, ["exec", ...mode, "--skip-git-repo-check", "--ephemeral",
    "--color", "never", "--output-last-message", resultFile, "-C", folder, "-"], { cwd: folder, input: prompt, timeoutMs });
  const { readFile } = await import("node:fs/promises");
  const last = existsSync(resultFile) ? (await readFile(resultFile, "utf8")).trim() : "";
  if (r.code !== 0 && !last) throw new AgentError(`Codex failed (exit ${r.code}): ${(r.stderr || r.stdout).slice(-1500)}`);
  return last || r.stdout.trim();
}

export async function runClaude(prompt: string, folder: string): Promise<string> {
  const exe = findClaude();
  if (!exe) throw new AgentError("Claude Code is not installed. See Connections.");
  const r = await runCli(exe, ["-p", "--output-format", "json", "--safe-mode", "--restricted", "--no-chrome",
    "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
    "--tools", CLAUDE_TOOLS, "--allowedTools", CLAUDE_TOOLS, "--permission-mode", "acceptEdits",
    "--permission-prompts", "none"], { cwd: folder, input: prompt });
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
  const agents: AgentStatus[] = [
    { id: "chatgpt", name: "ChatGPT (planner, via Codex)", cloud: true, model: "", enabled: true, available: !!codexV,
      detail: codexV || "Codex CLI not found", hint: "Install the ChatGPT Codex app (or npm install -g @openai/codex), then: codex login" },
    local("qwen-coder"), local("qwen"), local("qwen-fast"), local("gpt-oss"),
    { id: "claude", name: "Claude Code (optional)", cloud: true, model: "", enabled: enabled.claude, available: !!claudeV,
      detail: claudeV || "not installed", hint: "Install Claude Code, then run: claude auth login" },
  ];
  return { agents, models: list, loaded };
}
