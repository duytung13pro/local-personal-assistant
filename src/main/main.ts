// Electron main process: window, IPC handlers, agents and the job runner.
import { app, BrowserWindow, ipcMain, shell, screen } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { readdir, readFile as readFileAsync, stat } from "node:fs/promises";
import { join, resolve, relative, sep } from "node:path";
import { Store, ValidationError } from "./db";
import { AgentError, KEEP_ALIVE, agentStatuses, ollamaChat, ollamaPost, runClaude, runCodex } from "./providers";
import { runLocalCoder } from "./localcoder";
import { goodPlan, parsePlan, parseReview, plannerPrompt, reviewPrompt, rulePlan, stepPrompt, type Draft } from "./orchestrator";
import type { ConnectionsReport, PlanResult, Step, WorkerId } from "../shared/types";
import { ASSIGNABLE, WORKERS, isWorker } from "../shared/workers";

const ROOT = app.getAppPath();
const DATA = resolve(process.env.PA_DATA_DIR || join(ROOT, "data"));
const OLD_DB = process.env.PA_OLD_DB || "D:/LocalAI/Workstation/workstation.db";
const SHOT = process.argv.find((a) => a.startsWith("--screenshot"));
const MAX_PARALLEL = Number(process.env.PA_MAX_PARALLEL || 3); // workers running at the same time

mkdirSync(join(DATA, "projects"), { recursive: true });
if (!SHOT && !app.requestSingleInstanceLock()) app.quit();

const store = new Store(join(DATA, "personal-assistant.db"));
store.failStaleJobs();
let win: BrowserWindow | null = null;
const running = new Map<string, { projectId: string; writes: boolean }>(); // stepId -> info

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
handle("previewStep", (id) => {
  const step = store.getStep(id);
  return stepPrompt(store.getProject(step.projectId), store.listSteps(step.projectId), step);
});

// ---- the team: settings and availability -----------------------------------------------------------
const modelOf = (w: WorkerId) => store.getSetting(`model:${w}`, WORKERS[w].model ?? "");
const enabledOf = (w: WorkerId) => store.getSetting(`enabled:${w}`, w === "claude" ? "0" : "1") === "1";
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
  const prompt = stepPrompt(project, siblings, step);
  const folder = projectDir(project.id);
  running.set(step.id, { projectId: project.id, writes: WORKERS[step.agent].writes });
  store.updateStep(step.id, { status: "running" });
  const job = store.startJob({ projectId: project.id, stepId: step.id, agent: step.agent,
    title: `${WORKERS[step.agent].name}: ${step.title}` });
  changed("steps");
  (async () => {
    try {
      if (step.agent !== "chatgpt" && !enabledOf(step.agent))
        throw new AgentError(`${WORKERS[step.agent].name} is turned off in Connections.`);
      const last = join(DATA, `codex-last-${job.id}.txt`);
      let output: string;
      if (step.agent === "qwen-coder") output = await runLocalCoder(modelOf("qwen-coder"), prompt, folder);
      else if (step.agent === "claude") output = await runClaude(prompt, folder);
      else if (step.agent === "chatgpt") output = await runCodex(prompt, folder, last);
      else output = await ollamaChat(modelOf(step.agent), "You are a careful worker on the user's own PC. Answer in Markdown.", prompt);
      store.updateStep(step.id, { status: "done", output: output || "(finished without a written answer)" });
      store.finishJob(job.id, true, output);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      store.updateStep(step.id, { status: "failed", output: msg });
      store.finishJob(job.id, false, "", msg);
    } finally {
      running.delete(step.id);
      changed("steps");
      pump();
    }
  })();
}

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
      try { await ollamaPost("/api/generate", { model, keep_alive: KEEP_ALIVE }, 15 * 60_000); } catch { /* reported by Connections */ }
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
    title: "Personal Assistant", autoHideMenuBar: true,
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
  for (const view of ["planner", "calendar", "checklist", "ai", "activity", "connections"]) {
    await win!.webContents.executeJavaScript(`window.__pa && window.__pa.show(${JSON.stringify(view)})`);
    await wait(view === "connections" ? 2500 : 500);
    const img = await win!.webContents.capturePage();
    writeFileSync(join(dir, `${view}.png`), img.toPNG());
    if (view === "ai") { // also the team board
      await win!.webContents.executeJavaScript(`document.querySelectorAll('[role=tab]')[1]?.click()`);
      await wait(500);
      writeFileSync(join(dir, "ai-team.png"), (await win!.webContents.capturePage()).toPNG());
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
app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  store.close();
  app.quit();
});
