// Electron main process: window, IPC handlers, agents and the job runner.
import { app, BrowserWindow, dialog, ipcMain, shell, screen } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { importedBody, renderNote } from "../shared/markdown";
import { readdir, readFile as readFileAsync, stat } from "node:fs/promises";
import { basename, join, resolve, relative, sep } from "node:path";
import { Store, ValidationError } from "./db";
import { AgentError, KEEP_ALIVE, NUM_CTX, agentStatuses, ollamaChat, ollamaPost, ollamaStream, runClaude, runClaudeChat, runCodex, runCodexEdit } from "./providers";
import { RECENT, SUMMARY_SYSTEM, cleanSummary, contextText, mergePrompt, parseRoute, parseTeam, routerPrompt, runPlanner, selfSystem, workerPrompt, type Route } from "./chat";
import { runLocalCoder } from "./localcoder";
import { goodPlan, parsePlan, parseReview, plannerPrompt, reportOf, reviewPrompt, rulePlan, stepPrompt, wantsReport, type Draft } from "./orchestrator";
import type { ChatMessage, ConnectionsReport, PlanResult, Project, Step, WorkerId } from "../shared/types";
import { ASSIGNABLE, CHAT_ROUTABLE, WORKERS, isCloud, isWorker, parseMention } from "../shared/workers";

const ROOT = app.getAppPath();
const DATA = resolve(process.env.PA_DATA_DIR || join(ROOT, "data"));
const OLD_DB = process.env.PA_OLD_DB || "D:/LocalAI/Workstation/workstation.db";
const SHOT = process.argv.find((a) => a.startsWith("--screenshot"));
const MAX_PARALLEL = Number(process.env.PA_MAX_PARALLEL || 3); // workers running at the same time

/** Same ID as the Start menu shortcut (scripts/create-shortcut.js), so Windows groups the running window
 * with a pinned taskbar icon instead of showing two icons. */
export const APP_ID = "Duytung.LocalPersonalAssistant";
app.setAppUserModelId(APP_ID);
const ICON = join(ROOT, "build", "icon.ico");

mkdirSync(join(DATA, "projects"), { recursive: true });
if (!SHOT && !app.requestSingleInstanceLock()) app.quit();

const store = new Store(join(DATA, "personal-assistant.db"));
store.failStaleJobs();
store.failStaleChat();
let win: BrowserWindow | null = null;
const running = new Map<string, { projectId: string; writes: boolean; abort: AbortController }>(); // stepId -> info

const changed = (what: string) => win?.webContents.send("pa:changed", what);
const projectDir = (id: string) => {
  store.getProject(id); // validates the id
  const dir = join(DATA, "projects", id);
  mkdirSync(dir, { recursive: true });
  return dir;
};

// ---- IPC: every handler returns {ok, value} or {ok:false, error}; preload turns errors into exceptions ----
function handle(name: string, fn: (...args: any[]) => unknown, notify?: string) {
  ipcMain.handle(`pa:${name}`, async (_e, ...args) => {
    try {
      const value = await fn(...args);
      if (notify) changed(notify);
      return { ok: true, value };
    } catch (e) {
      const known = e instanceof ValidationError || e instanceof AgentError;
      if (!known) console.error(e);
      return { ok: false, error: known ? (e as Error).message : `Unexpected problem: ${(e as Error).message}` };
    }
  });
}

handle("listTasks", () => store.listTasks());
handle("addTask", (t) => store.addTask(t), "tasks");
handle("updateTask", (id, t) => store.updateTask(id, t), "tasks");
handle("setTaskDone", (id, done) => store.setTaskDone(id, !!done), "tasks");
handle("deleteTask", (id) => store.deleteTask(id), "tasks");
handle("listEvents", (from, to) => store.listEvents(from, to));
handle("addEvent", (e) => store.addEvent(e), "events");
handle("updateEvent", (id, e) => store.updateEvent(id, e), "events");
handle("deleteEvent", (id) => store.deleteEvent(id), "events");
handle("latestUndo", () => store.latestUndo());
handle("undo", () => store.undo(), "all");

handle("listNotes", () => store.listNotes());
handle("createNote", (body) => store.createNote(body), "notes");
handle("updateNote", (id, n) => store.updateNote(id, n), "notes");
handle("deleteNote", (id) => store.deleteNote(id), "notes");
handle("importNotes", () => importNotes(), "notes");
handle("exportNote", (id, kind) =>exportNote(store.getNote(id), kind === "pdf" ? "pdf" : "md"));
handle("openLink", async (url) => {
  const u = String(url);
  if (!/^(https?:|mailto:)/i.test(u)) throw new ValidationError("Only web and mailto links can be opened.");
  await shell.openExternal(u);
});

handle("listProjects", () => store.listProjects());
handle("createProject", (title) => store.createProject(title), "projects");
handle("updateProject", (id, p) => store.updateProject(id, p), "projects");
handle("deleteProject", (id) => store.deleteProject(id), "projects");
handle("projectFolder", (id) => projectDir(id));
handle("listFiles", async (id) => {
  const base = projectDir(id);
  const out: { path: string; size: number }[] = [];
  const walk = async (dir: string) => {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      if (out.length >= 500 || ent.isSymbolicLink() || ["node_modules", ".git", "__pycache__"].includes(ent.name)) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) await walk(full);
      else if (ent.isFile()) out.push({ path: relative(base, full).split(sep).join("/"), size: (await stat(full)).size });
    }
  };
  await walk(base);
  return out.sort((a, b) => a.path.localeCompare(b.path));
});
handle("readFile", async (id, rel) => {
  const base = projectDir(id);
  const full = resolve(base, String(rel));
  if (!full.startsWith(base + sep)) throw new ValidationError("That file is outside the project folder.");
  const info = await stat(full);
  if (info.size > 300_000) throw new ValidationError("File is too large to preview (over 300 KB).");
  return readFileAsync(full, "utf8");
});

handle("listSteps", (pid) => store.listSteps(pid));
handle("updateStep", (id, st) => store.updateStep(id, st), "steps");
handle("deleteStep", (id) => {
  if (running.has(id)) throw new ValidationError("That step is running; wait for it to finish.");
  store.deleteStep(id);
}, "steps");
/** Team-plan steps and parts of a split chat job report back briefly; a single chat reply is the answer itself. */
function reportFor(step: Step): boolean {
  if (!wantsReport(step)) return false;
  if (!step.chatMsg) return true;
  try { return store.getChat(step.chatMsg).mode === "split"; } catch { return false; }
}

handle("previewStep", async (id) => {
  const step = store.getStep(id);
  return stepPrompt(store.getProject(step.projectId), store.listSteps(step.projectId), step, await filesText(step.projectId), reportFor(step));
});

// ---- the team: settings and availability -----------------------------------------------------------
const modelOf = (w: WorkerId) => store.getSetting(`model:${w}`, WORKERS[w].model ?? "");
const enabledOf = (w: WorkerId) => store.getSetting(`enabled:${w}`, "1") === "1";
function settingsMaps() {
  const ids = Object.keys(WORKERS) as WorkerId[];
  return {
    models: Object.fromEntries(ids.map((w) => [w, modelOf(w)])) as Record<WorkerId, string>,
    enabled: Object.fromEntries(ids.map((w) => [w, enabledOf(w)])) as Record<WorkerId, boolean>,
  };
}
async function team() {
  const { models, enabled } = settingsMaps();
  const st = await agentStatuses(models, enabled);
  const ready = st.agents.filter((a) => a.available && a.enabled).map((a) => a.id);
  return { ...st, ready, assignable: ASSIGNABLE.filter((w) => ready.includes(w)) };
}

async function listFilesOf(pid: string): Promise<string[]> {
  const base = projectDir(pid);
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      if (out.length >= 500 || ent.isSymbolicLink() || ["node_modules", ".git", "__pycache__"].includes(ent.name)) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) await walk(full);
      else if (ent.isFile()) out.push(relative(base, full).split(sep).join("/"));
    }
  };
  await walk(base);
  return out.sort();
}

const TEXT_FILE = /\.(html?|css|js|mjs|ts|tsx|jsx|json|md|txt|py|csv|svg|xml|ya?ml|toml|ini|sh|ps1|bat)$/i;
/** The project's text files, inlined (capped) for a text-only reviewer that can't open files itself. */
async function filesText(pid: string, max = 40000): Promise<string> {
  const base = projectDir(pid);
  const out: string[] = [];
  let left = max;
  for (const f of await listFilesOf(pid)) {
    if (!TEXT_FILE.test(f) || left <= 0) continue;
    const body = (await readFileAsync(join(base, f), "utf8").catch(() => "")).slice(0, left);
    left -= body.length;
    out.push(`### ${f}\n\`\`\`\n${body}\n\`\`\``);
  }
  return out.join("\n\n");
}

/** Ask ChatGPT (or, without it, the strongest local model) for JSON. Returns [text, who answered]. */
async function askPlanner(prompt: string, pid: string, ready: WorkerId[], what: string): Promise<[string, WorkerId] | null> {
  if (ready.includes("chatgpt")) {
    const job = store.startJob({ projectId: pid, stepId: "", agent: "chatgpt", title: `ChatGPT: ${what}` });
    changed("jobs");
    try {
      const text = await runCodex(prompt, projectDir(pid), join(DATA, `codex-last-${job.id}.txt`));
      store.finishJob(job.id, true, text);
      return [text, "chatgpt"];
    } catch (e) {
      store.finishJob(job.id, false, "", (e as Error).message);
    } finally {
      changed("jobs");
    }
  }
  for (const w of ["qwen", "gpt-oss", "qwen-fast"] as WorkerId[]) {
    if (!ready.includes(w)) continue;
    try {
      return [await ollamaChat(modelOf(w), "Reply with JSON only.", prompt, { json: true, timeoutMs: 240_000 }), w];
    } catch {
      /* try the next one */
    }
  }
  return null;
}

handle("previewPlan", async (pid) => plannerPrompt(store.getProject(pid), (await team()).assignable));
handle("planSteps", async (pid): Promise<PlanResult> => {
  const p = store.getProject(pid);
  if (!p.brief.trim()) throw new ValidationError("Write and save a brief first: it is what the team works from.");
  const t = await team();
  if (!t.assignable.length) throw new ValidationError("No workers are ready. Open Connections to see what is missing.");
  const answer = await askPlanner(plannerPrompt(p, t.assignable), pid, t.ready, "planning");
  const drafts = answer ? parsePlan(answer[0], t.assignable) : null;
  if (answer && drafts && goodPlan(p.brief, drafts))
    return { steps: store.replaceSteps(pid, drafts), plannedBy: answer[1], note: `Planned by ${WORKERS[answer[1]].name}.` };
  return { steps: store.replaceSteps(pid, rulePlan(t.assignable)), plannedBy: "rules",
    note: answer ? `${WORKERS[answer[1]].name}'s plan was unusable, so the standard plan was used.` :
      "No planner was available, so the standard plan was used." };
}, "steps");

handle("previewReview", async (pid) =>
  reviewPrompt(store.getProject(pid), store.listSteps(pid), await listFilesOf(pid), (await team()).assignable));
handle("reviewProject", async (pid): Promise<PlanResult> => {
  const p = store.getProject(pid);
  const steps = store.listSteps(pid);
  if (steps.some((s) => s.status === "running" || s.status === "queued"))
    throw new ValidationError("Wait for the running tasks to finish before reviewing.");
  const t = await team();
  const answer = await askPlanner(reviewPrompt(p, steps, await listFilesOf(pid), t.assignable), pid, t.ready, "reviewing");
  const review = answer ? parseReview(answer[0], t.assignable) : null;
  if (!answer || !review) throw new ValidationError("The reviewer's answer could not be read. Try again.");
  const note: Draft = { title: review.verdict === "done" ? "Review: brief satisfied" : "Review: needs more work",
    agent: answer[1], why: `Reviewed by ${WORKERS[answer[1]].name}.`, prompt: "Review the results.", deps: [] };
  const before = new Set(steps.map((s) => s.id));
  const all = store.replaceSteps(pid, [note, ...review.tasks], true);
  const added = all.filter((s) => !before.has(s.id)).sort((a, b) => a.idx - b.idx)[0];
  store.updateStep(added.id, { status: "done", output: review.summary });
  return { steps: store.listSteps(pid), plannedBy: answer[1],
    note: review.verdict === "done" ? "Review: the brief looks satisfied." : `Review added ${review.tasks.length} follow-up task(s).` };
}, "steps");

// ---- the scheduler: run queued steps whose dependencies are done, several at once -------------------
handle("runStep", (id) => {
  const s = store.getStep(id);
  if (s.status === "running") throw new ValidationError("That step is already running.");
  store.updateStep(id, { status: "queued" });
  if (s.chatMsg) { try { store.updateChat(s.chatMsg, { status: "working" }); changed("chat"); } catch { /* gone */ } }
  pump();
}, "steps");
handle("runAll", (pid) => {
  const n = store.queueAll(pid);
  pump();
  return n;
}, "steps");
handle("stopQueue", (pid) => store.unqueue(pid), "steps");

function pump() {
  for (const step of store.queuedSteps()) {
    if (running.size >= MAX_PARALLEL) break;
    const siblings = store.listSteps(step.projectId);
    const deps = siblings.filter((s) => step.deps.includes(s.id));
    if (deps.some((d) => d.status === "failed")) {
      store.updateStep(step.id, { status: "failed", output: "Skipped: a task it depends on failed." });
      changed("steps");
      continue;
    }
    if (deps.some((d) => d.status !== "done")) continue; // waits for its inputs
    const writes = WORKERS[step.agent].writes;
    if (writes && [...running.values()].some((r) => r.writes && r.projectId === step.projectId)) continue; // one writer
    start(step, siblings);
  }
}

function start(step: Step, siblings: Step[]) {
  const project = store.getProject(step.projectId);
  const folder = projectDir(project.id);
  const abort = new AbortController();
  running.set(step.id, { projectId: project.id, writes: WORKERS[step.agent].writes, abort });
  store.updateStep(step.id, { status: "running" });
  const job = store.startJob({ projectId: project.id, stepId: step.id, agent: step.agent,
    title: `${WORKERS[step.agent].name}: ${step.title}` });
  changed("steps");
  // A single-worker chat reply from a local text model streams straight into the chat.
  let streamTo = "";
  if (step.chatMsg) {
    try { if (store.getChat(step.chatMsg).mode !== "split") streamTo = step.chatMsg; } catch { /* message deleted */ }
  }
  (async () => {
    try {
      if (step.agent !== "chatgpt" && !enabledOf(step.agent))
        throw new AgentError(`${WORKERS[step.agent].name} is turned off in Connections.`);
      const prompt = stepPrompt(project, siblings, step, WORKERS[step.agent].writes ? "" : await filesText(project.id), reportFor(step));
      const last = join(DATA, `codex-last-${job.id}.txt`);
      const sig = abort.signal;
      const system = "You are a careful worker on the user's own PC. Answer in Markdown.";
      let output: string;
      if (step.agent === "qwen-coder") output = await runLocalCoder(modelOf("qwen-coder"), prompt, folder, undefined, sig);
      else if (step.agent === "claude") output = await runClaude(prompt, folder, sig);
      else if (step.agent === "claude-chat") output = await runClaudeChat(prompt, folder, sig);
      else if (step.agent === "chatgpt") output = await runCodex(prompt, folder, last, sig);
      else if (step.agent === "codex") output = await runCodexEdit(prompt, folder, last, sig);
      else if (streamTo) {
        store.updateChat(streamTo, { status: "working" });
        changed("chat");
        output = await ollamaStream(modelOf(step.agent), system, prompt, (so) => delta(streamTo, so), { signal: sig });
      } else output = await ollamaChat(modelOf(step.agent), system, prompt, { signal: sig });
      store.updateStep(step.id, { status: "done", output: output || "(finished without a written answer)" });
      store.finishJob(job.id, true, output);
    } catch (e) {
      const msg = abort.signal.aborted ? "Stopped by you." : e instanceof Error ? e.message : String(e);
      store.updateStep(step.id, { status: "failed", output: msg });
      store.finishJob(job.id, false, "", msg);
    } finally {
      running.delete(step.id);
      changed("steps");
      chatStepSettled(store.getStep(step.id));
      pump();
    }
  })();
}

// ---- Chat: the head chef routes each message --------------------------------------------------------
const CHEF: WorkerId = "qwen"; // head chef model = the "qwen" worker's model (qwen3:30b by default)
const streams = new Map<string, AbortController>(); // chat message id -> its own streaming work (self/planner/merge)
const delta = (id: string, text: string) => win?.webContents.send("pa:chatDelta", id, text);

function chatSummary(pid: string) {
  return cleanSummary(store.getSetting(`chatSummary:${pid}`, ""));
}

/** Keep a short running summary of older, non-private messages (local, in the background). */
async function refreshSummary(pid: string) {
  const all = store.listChat(pid).filter((m) => !m.private && m.content.trim() && m.status === "done");
  const older = all.slice(0, Math.max(0, all.length - RECENT));
  const covered = Number(store.getSetting(`chatSummaryCount:${pid}`, "0"));
  if (older.length - covered < 6) return;
  try {
    const text = `${chatSummary(pid) ? `Summary so far: ${chatSummary(pid)}\n\n` : ""}${older.slice(covered)
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 1500)}`).join("\n\n")}`;
    // think:true keeps qwen3's reasoning in its own field instead of leaking into the summary text.
    const s = cleanSummary(await ollamaChat(modelOf("qwen-fast"), SUMMARY_SYSTEM, text, { timeoutMs: 120_000, think: true }));
    if (!s) return; // only reasoning came back: keep the old summary, try again later
    store.setSetting(`chatSummary:${pid}`, s.slice(0, 1500));
    store.setSetting(`chatSummaryCount:${pid}`, String(older.length));
  } catch { /* try again next time */ }
}

handle("listChat", (pid) => store.listChat(pid));
handle("chatUsage", () => ({ today: store.cloudCallsToday() }));

handle("sendChat", async (pid: string, text: string) => {
  const raw = String(text ?? "").trim();
  if (!raw) throw new ValidationError("Type a message first.");
  if (raw.length > 12000) throw new ValidationError("That message is too long (12,000 characters max).");
  const project = store.getProject(pid);
  const history = store.listChat(pid);
  const user = store.addChat({ projectId: pid, role: "user", author: "you", content: raw });
  const reply = store.addChat({ projectId: pid, role: "assistant", author: "chef", status: "thinking", replyTo: user.id });
  changed("chat");
  void route(project, history, user.content, reply.id);
  return reply.id;
});

async function route(project: Project, history: ChatMessage[], text: string, replyId: string) {
  const ctl = new AbortController();
  streams.set(replyId, ctl);
  try {
    const t = await team();
    const avail = t.ready.filter((w) => CHAT_ROUTABLE.includes(w));
    const [wantsTeam, teamBody] = parseTeam(text);
    const [mention, body] = wantsTeam ? [null, teamBody] as const : parseMention(text);
    let r: Route | null = null;
    if (mention) {
      if (!avail.includes(mention)) throw new AgentError(`${WORKERS[mention].name} isn't available right now (see Connections).`);
      r = { mode: "single", worker: mention, reason: `You asked for ${WORKERS[mention].name}.` };
    } else if (avail.includes(CHEF)) {
      // @team forces a split; one retry if the head chef still doesn't split. JSON-constrained, so no thinking needed.
      for (let attemptNo = 0; attemptNo < (wantsTeam ? 2 : 1) && (!r || (wantsTeam && r.mode !== "split")); attemptNo++) {
        const ans = await ollamaChat(modelOf(CHEF), "Reply with JSON only.",
          routerPrompt(project, contextText(history, chatSummary(project.id), false), body, avail, wantsTeam),
          { json: true, think: false, timeoutMs: 15 * 60_000, signal: ctl.signal });
        r = parseRoute(ans, avail) ?? r;
      }
      if (wantsTeam && r && r.mode !== "split") r = { ...r, reason: `Couldn't split this one sensibly, so: ${r.reason}` };
    }
    if (!r) r = { mode: "self", reason: avail.includes(CHEF) ? "Answering directly." : "Head chef unavailable; answering with what's ready." };
    const content = mention || wantsTeam ? body : text;
    store.updateChat(replyId, { mode: r.mode, reason: r.reason, status: r.mode === "self" || r.mode === "planner" ? "working" : "waiting" });
    changed("chat");

    if (r.mode === "self") {
      const chef = avail.includes(CHEF) ? CHEF : avail.find((w) => WORKERS[w].local);
      if (!chef) throw new AgentError("No local model is ready. Start Ollama (see Connections).");
      store.updateChat(replyId, { author: chef });
      const out = await ollamaStream(modelOf(chef), selfSystem(project),
        `${contextText(history, chatSummary(project.id), false) ? `Conversation so far:\n${contextText(history, chatSummary(project.id), false)}\n\n` : ""}User: ${content}`,
        (so) => delta(replyId, so), { signal: ctl.signal });
      store.updateChat(replyId, { content: out, status: "done" });
    } else if (r.mode === "planner") {
      if (!avail.includes(CHEF)) throw new AgentError("Planner help needs the local head chef model (see Connections).");
      store.updateChat(replyId, { author: CHEF, private: true });
      const { answer, changes } = await runPlanner(store, modelOf(CHEF), contextText(history, "", false), content, ctl.signal);
      store.updateChat(replyId, { content: answer || (changes.length ? `Done: ${changes.join("; ")}.` : "Done."), status: "done", private: true });
      if (changes.length) { changed("tasks"); changed("events"); }
    } else {
      const ctxCloud = contextText(history, chatSummary(project.id), true);
      const ctxLocal = contextText(history, chatSummary(project.id), false);
      const drafts: Draft[] = r.mode === "single"
        ? [{ ref: "t1", title: content.split("\n")[0].slice(0, 80) || "Request", agent: r.worker!, why: r.reason, prompt: content, deps: [] }]
        : r.tasks!;
      for (const d of drafts) d.prompt = workerPrompt(d.prompt, isCloud(d.agent) ? ctxCloud : ctxLocal);
      if (r.mode === "single") store.updateChat(replyId, { author: r.worker! });
      store.replaceSteps(project.id, drafts, true, replyId);
      const steps = store.stepsOfChat(replyId); // only this reply's tasks, never older ones
      // Local steps start now; cloud steps wait for the user's OK in the chat ticket.
      for (const s of steps) if (!isCloud(s.agent)) store.updateStep(s.id, { status: "queued" });
      store.updateChat(replyId, { status: steps.some((s) => isCloud(s.agent)) ? "waiting" : "working" });
      changed("steps");
      pump();
    }
  } catch (e) {
    const stopped = ctl.signal.aborted;
    store.updateChat(replyId, { status: stopped ? "stopped" : "failed",
      content: stopped ? store.getChat(replyId).content : `Something went wrong: ${(e as Error).message}` });
  } finally {
    streams.delete(replyId);
    changed("chat");
    void refreshSummary(project.id);
  }
}

/** Called whenever a step finishes: completes its chat message when all of the message's steps are settled. */
function chatStepSettled(step: Step) {
  if (!step.chatMsg) return;
  let msg: ChatMessage;
  try { msg = store.getChat(step.chatMsg); } catch { return; }
  if (msg.status === "stopped") return;
  const steps = store.stepsOfChat(msg.id);
  if (steps.some((s) => s.status === "running" || s.status === "queued")) {
    store.updateChat(msg.id, { status: "working" });
    return changed("chat");
  }
  if (steps.some((s) => s.status === "todo")) return changed("chat"); // still waiting for an approval
  if (msg.mode !== "split") {
    const s = steps[0];
    store.updateChat(msg.id, { content: s.output, status: s.status === "done" ? "done" : "failed" });
    changed("chat");
    return void refreshSummary(msg.projectId);
  }
  void mergeChat(msg, steps);
}

async function mergeChat(msg: ChatMessage, steps: Step[]) {
  const ctl = new AbortController();
  streams.set(msg.id, ctl);
  store.updateChat(msg.id, { status: "working", author: CHEF });
  changed("chat");
  const request = msg.replyTo ? store.getChat(msg.replyTo).content : "";
  // Builders and checkers hand the head chef their ≤10-line report; text deliverables go in whole.
  const parts = steps.map((s) => ({ title: s.title, worker: s.agent, status: s.status,
    output: s.status === "done" && wantsReport(s) ? reportOf(s.output) : s.output }));
  try {
    const out = await ollamaStream(modelOf(CHEF), "You write the final answer for the user's AI team.", mergePrompt(request, parts),
      (so) => delta(msg.id, so), { signal: ctl.signal });
    store.updateChat(msg.id, { content: out, status: steps.every((s) => s.status === "done") ? "done" : "failed" });
  } catch (e) {
    store.updateChat(msg.id, { status: ctl.signal.aborted ? "stopped" : "failed",
      content: parts.map((x) => `**${x.title}** (${WORKERS[x.worker].name}): ${x.output.slice(0, 3000)}`).join("\n\n") });
  } finally {
    streams.delete(msg.id);
    changed("chat");
    void refreshSummary(msg.projectId);
  }
}

handle("declineStep", (id) => {
  const s = store.getStep(id);
  if (s.status !== "todo") throw new ValidationError("Only a step that hasn't started can be declined.");
  store.updateStep(id, { status: "failed", output: "Declined by you." });
  for (const d of store.listSteps(s.projectId)) if (d.deps.includes(id) && d.status === "queued") store.updateStep(d.id, { status: "failed", output: "Skipped: a task it depends on was declined." });
  chatStepSettled(store.getStep(id));
  pump();
}, "steps");

handle("stopChat", (mid) => {
  const msg = store.getChat(mid);
  streams.get(mid)?.abort();
  for (const s of store.stepsOfChat(mid)) {
    if (running.has(s.id)) running.get(s.id)!.abort.abort();
    else if (s.status === "todo" || s.status === "queued") store.updateStep(s.id, { status: "failed", output: "Stopped by you." });
  }
  store.updateChat(msg.id, { status: "stopped" });
  changed("steps");
}, "chat");

handle("rerunChat", (mid, worker) => {
  if (!isWorker(worker)) throw new ValidationError("Unknown model.");
  const msg = store.getChat(mid);
  if (!msg.replyTo) throw new ValidationError("There's no request to re-run.");
  const req = store.getChat(msg.replyTo);
  const reply = store.addChat({ projectId: msg.projectId, role: "assistant", author: worker, status: "waiting", mode: "single",
    reason: `Re-run with ${WORKERS[worker].name}, as you asked.`, replyTo: req.id });
  const history = store.listChat(msg.projectId).filter((m) => m.created < req.created);
  const ctx = contextText(history, chatSummary(msg.projectId), isCloud(worker));
  const [, body] = parseMention(req.content);
  store.replaceSteps(msg.projectId, [{ ref: "t1", title: body.split("\n")[0].slice(0, 80) || "Request", agent: worker,
    why: "Re-run", prompt: workerPrompt(body, ctx), deps: [] }], true, reply.id);
  const [step] = store.stepsOfChat(reply.id);
  if (!isCloud(worker)) { store.updateStep(step.id, { status: "queued" }); store.updateChat(reply.id, { status: "working" }); pump(); }
  changed("steps");
  return reply.id;
}, "chat");

handle("listJobs", (limit) => store.listJobs(limit ?? 100));
handle("connections", async (): Promise<ConnectionsReport> => {
  const t = await team();
  return { agents: t.agents, ollamaModels: t.models, loadedModels: t.loaded, dataDir: DATA, oldDbFound: existsSync(OLD_DB),
    maxParallel: MAX_PARALLEL };
});
/** Load enabled local models into memory ahead of time (one after another; loading from disk is slow). */
let warming = false;
handle("warmUp", async () => {
  if (warming) return "Already warming up.";
  warming = true;
  const models = [...new Set((["qwen-coder", "qwen", "gpt-oss", "qwen-fast"] as WorkerId[]).filter(enabledOf).map(modelOf))];
  (async () => {
    for (const model of models) {
      try { await ollamaPost("/api/generate", { model, keep_alive: KEEP_ALIVE, options: { num_ctx: NUM_CTX } }, 15 * 60_000); } catch { /* reported by Connections */ }
      changed("settings");
    }
    warming = false;
  })();
  return `Loading ${models.join(", ")} into memory in the background.`;
});
handle("setWorkerModel", (w, m) => {
  if (!isWorker(w) || !WORKERS[w].local) throw new ValidationError("Only local workers have a model to choose.");
  store.setSetting(`model:${w}`, String(m));
}, "settings");
handle("setWorkerEnabled", (w, on) => {
  if (!isWorker(w) || w === "chatgpt") throw new ValidationError("ChatGPT is the planner and can't be turned off here.");
  store.setSetting(`enabled:${w}`, on ? "1" : "0");
}, "settings");
handle("importOld", () => store.importOld(OLD_DB), "all");
handle("openPath", async (p) => {
  const full = resolve(String(p));
  if (!full.startsWith(DATA)) throw new ValidationError("Only folders inside the app's data folder can be opened.");
  await shell.openPath(full);
});

// ---- notes export ------------------------------------------------------------------------------
const safeName = (t: string) => t.replace(/[<>:"/\|?*\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "Note";

/** Save a note as Markdown, or as a PDF rendered with the same Markdown + KaTeX as the preview. */
async function exportNote(note: { title: string; body: string }, kind: "md" | "pdf"): Promise<string | null> {
  const dir = join(DATA, "exports");
  mkdirSync(dir, { recursive: true });
  const res = await dialog.showSaveDialog(win!, {
    title: kind === "pdf" ? "Export note as PDF" : "Export note as Markdown",
    defaultPath: join(dir, `${safeName(note.title)}.${kind}`),
    filters: kind === "pdf" ? [{ name: "PDF", extensions: ["pdf"] }] : [{ name: "Markdown", extensions: ["md"] }],
  });
  if (res.canceled || !res.filePath) return null;
  if (kind === "md") {
    writeFileSync(res.filePath, note.body, "utf8");
    return res.filePath;
  }
  const katexDir = join(ROOT, "node_modules", "katex", "dist");
  const fonts = pathToFileURL(join(katexDir, "fonts")).href + "/";
  const css = readFileSync(join(katexDir, "katex.min.css"), "utf8").replace(/url\(fonts\//g, `url(${fonts}`) +
    readFileSync(join(ROOT, "src", "renderer", "note.css"), "utf8");
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>${note.title.replace(/</g, "&lt;")}</title>` +
    `<style>${css} body{margin:0;font:11pt/1.6 "Segoe UI",system-ui,sans-serif;color:#1d1d1b}</style></head>` +
    `<body><article class="note-prose">${renderNote(note.body)}</article></body></html>`;
  const tmp = join(dir, `.print-${Date.now()}.html`);
  writeFileSync(tmp, page, "utf8");
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    pdfWin.webContents.on("will-navigate", (e) => e.preventDefault());
    await pdfWin.loadFile(tmp);
    await pdfWin.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
    const pdf = await pdfWin.webContents.printToPDF({ pageSize: "A4", printBackground: true,
      margins: { top: 0.7, bottom: 0.7, left: 0.75, right: 0.75 } });
    writeFileSync(res.filePath, pdf);
    return res.filePath;
  } finally {
    pdfWin.destroy();
    rmSync(tmp, { force: true });
  }
}

/** Pick .md files and turn each into a note. Files that can't be read or are too long are skipped and reported. */
async function importNotes(): Promise<{ ids: string[]; skipped: string[] }> {
  const res = await dialog.showOpenDialog(win!, {
    title: "Import Markdown notes",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "txt"] }, { name: "All files", extensions: ["*"] }],
  });
  const ids: string[] = [];
  const skipped: string[] = [];
  if (res.canceled) return { ids, skipped };
  for (const file of res.filePaths) {
    const name = basename(file);
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > 8_000_000) throw new Error("too big");
      ids.push(store.createNote(importedBody(await readFileAsync(file, "utf8"), name)).id);
    } catch {
      skipped.push(name);
    }
  }
  return { ids, skipped };
}

// ---- window ------------------------------------------------------------------------------------
const BOUNDS = join(DATA, "window.json");

function savedBounds() {
  try {
    const b = JSON.parse(readFileSync(BOUNDS, "utf8"));
    const area = screen.getDisplayMatching(b).workArea;
    const fits = b.x >= area.x - 50 && b.y >= area.y - 50 && b.width >= 900 && b.height >= 600;
    return fits ? b : null;
  } catch {
    return null;
  }
}

function saveBounds() {
  if (!win || win.isMinimized()) return;
  const tmp = BOUNDS + ".tmp";
  writeFileSync(tmp, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
  renameSync(tmp, BOUNDS);
}

function createWindow() {
  const b = SHOT ? { width: 1440, height: 900 } : savedBounds() ?? { width: 1360, height: 860 };
  win = new BrowserWindow({
    ...b, minWidth: 900, minHeight: 600, show: false, backgroundColor: "#f6f6f4",
    title: "Personal Assistant", autoHideMenuBar: true, ...(existsSync(ICON) ? { icon: ICON } : {}),
    webPreferences: { preload: join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.once("ready-to-show", () => {
    if (!SHOT && b && "maximized" in b && b.maximized) win?.maximize();
    win?.show();
  });
  let t: NodeJS.Timeout | undefined;
  const later = () => { clearTimeout(t); t = setTimeout(saveBounds, 400); };
  win.on("resize", later);
  win.on("move", later);
  win.on("close", saveBounds);
  win.loadFile(join(ROOT, "dist", "renderer", "index.html"));
  if (SHOT) win.webContents.once("did-finish-load", () => void screenshots());
}

/** --screenshot[=dir]: render every view, save PNGs, quit. Used for visual checks. */
async function screenshots() {
  const dir = SHOT!.includes("=") ? SHOT!.split("=")[1] : join(DATA, "screenshots");
  mkdirSync(dir, { recursive: true });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await wait(900);
  for (const view of ["planner", "calendar", "checklist", "notes", "ai", "activity", "connections"]) {
    await win!.webContents.executeJavaScript(`window.__pa && window.__pa.show(${JSON.stringify(view)})`);
    await wait(view === "connections" ? 2500 : 500);
    const img = await win!.webContents.capturePage();
    writeFileSync(join(dir, `${view}.png`), img.toPNG());
    if (view === "ai") { // also the team board, then back to the chat
      await win!.webContents.executeJavaScript(`document.querySelectorAll('[role=tab]')[2]?.click()`);
      await wait(500);
      writeFileSync(join(dir, "ai-team.png"), (await win!.webContents.capturePage()).toPNG());
      await win!.webContents.executeJavaScript(`document.querySelectorAll('[role=tab]')[0]?.click()`);
      await wait(300);
    }
  }
  console.log(`screenshots saved to ${dir}`);
  app.quit();
}

app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
app.whenReady().then(() => { createWindow(); pump(); }); // resume chat steps queued before a restart
app.on("window-all-closed", () => {
  store.close();
  app.quit();
});
