// SQLite storage (Electron's built-in node:sqlite, no native modules).
// Tasks, events, a persistent undo journal, AI projects, their work steps and job history.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { CalEvent, ChatMessage, ChatMode, ChatStatus, ImportResult, Priority, Project, Step, StepStatus, Task, Job, UndoEntry,
  WorkerId } from "../shared/types";
import { CLOUD, isWorker } from "../shared/workers";
import { isValidDate, isValidTime, minutes } from "../shared/dates";

export class ValidationError extends Error {}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', due TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal', done INTEGER NOT NULL DEFAULT 0, done_at TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tasks_due ON tasks(due);
CREATE TABLE IF NOT EXISTS events(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, date TEXT NOT NULL, start TEXT NOT NULL DEFAULT '',
  end_ TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_date ON events(date);
CREATE TABLE IF NOT EXISTS undo(
  id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL,
  before_json TEXT NOT NULL, after_json TEXT NOT NULL, created TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active');
CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS steps(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, idx INTEGER NOT NULL,
  title TEXT NOT NULL, agent TEXT NOT NULL, why TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo', output TEXT NOT NULL DEFAULT '', updated TEXT NOT NULL,
  deps TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS jobs(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT '', step_id TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL,
  title TEXT NOT NULL, status TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
  started TEXT NOT NULL, finished TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS chat(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, role TEXT NOT NULL,
  author TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', private INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'done', mode TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
  reply_to TEXT NOT NULL DEFAULT '', created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chat_project ON chat(project_id, created);
INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1');
`;

const UNDO_KEEP = 50;
const now = () => new Date().toISOString();
const PRIORITIES: Priority[] = ["low", "normal", "high"];
type Row = Record<string, unknown>;

const toTask = (r: Row): Task => ({
  id: String(r.id), title: String(r.title), notes: String(r.notes), due: String(r.due),
  priority: r.priority as Priority, done: Number(r.done) === 1, doneAt: String(r.done_at),
  created: String(r.created), updated: String(r.updated),
});
const toEvent = (r: Row): CalEvent => ({
  id: String(r.id), title: String(r.title), date: String(r.date), start: String(r.start), end: String(r.end_),
  notes: String(r.notes), created: String(r.created), updated: String(r.updated),
});
const toProject = (r: Row): Project => ({
  id: String(r.id), title: String(r.title), brief: String(r.brief), notes: String(r.notes),
  created: String(r.created), updated: String(r.updated),
});
const toStep = (r: Row): Step => ({
  id: String(r.id), projectId: String(r.project_id), idx: Number(r.idx), title: String(r.title),
  agent: r.agent as WorkerId, why: String(r.why), prompt: String(r.prompt), status: r.status as StepStatus,
  deps: JSON.parse(String(r.deps ?? "[]")) as string[], chatMsg: String(r.chat_msg ?? ""), output: String(r.output),
  updated: String(r.updated),
});
const toChat = (r: Row): ChatMessage => ({
  id: String(r.id), projectId: String(r.project_id), role: r.role as ChatMessage["role"], author: String(r.author),
  content: String(r.content), private: Number(r.private) === 1, status: r.status as ChatStatus, mode: String(r.mode) as ChatMode | "",
  reason: String(r.reason), replyTo: String(r.reply_to), created: String(r.created),
});
const toJob = (r: Row): Job => ({
  id: String(r.id), projectId: String(r.project_id), stepId: String(r.step_id), agent: r.agent as WorkerId,
  title: String(r.title), status: r.status as Job["status"], output: String(r.output), error: String(r.error),
  started: String(r.started), finished: String(r.finished),
});

const TASK_ORDER = `ORDER BY done, CASE WHEN due='' THEN 1 ELSE 0 END, due,
  CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created`;

function cleanTitle(t: unknown, max = 200): string {
  const s = String(t ?? "").replace(/\s+/g, " ").trim();
  if (!s) throw new ValidationError("Title is required.");
  if (s.length > max) throw new ValidationError(`Title is longer than ${max} characters.`);
  return s;
}

function cleanDue(d: unknown): string {
  const s = String(d ?? "").trim();
  if (s && !isValidDate(s)) throw new ValidationError("Due date must be a real date (YYYY-MM-DD).");
  return s;
}

function cleanTimes(start: unknown, end: unknown): [string, string] {
  const a = String(start ?? "").trim();
  const b = String(end ?? "").trim();
  if (!a && !b) return ["", ""];
  if (!a || !b) throw new ValidationError("Give both a start and an end time, or neither for an all-day event.");
  if (!isValidTime(a) || !isValidTime(b)) throw new ValidationError("Times must look like 09:30.");
  if (minutes(b) <= minutes(a)) throw new ValidationError("The end time must be after the start time.");
  return [a, b];
}

export class Store {
  readonly db: DatabaseSync;

  constructor(readonly file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    const cols = (this.db.prepare("PRAGMA table_info(steps)").all() as Row[]).map((c) => String(c.name));
    if (!cols.includes("deps")) this.db.exec("ALTER TABLE steps ADD COLUMN deps TEXT NOT NULL DEFAULT '[]'");
    if (!cols.includes("chat_msg")) this.db.exec("ALTER TABLE steps ADD COLUMN chat_msg TEXT NOT NULL DEFAULT ''");
  }

  close() {
    this.db.close();
  }

  private all(sql: string, ...args: (string | number)[]): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }
  private get(sql: string, ...args: (string | number)[]): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  private run(sql: string, ...args: (string | number)[]) {
    return this.db.prepare(sql).run(...args);
  }
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---- tasks ---------------------------------------------------------------------------------
  listTasks(): Task[] {
    return this.all(`SELECT * FROM tasks ${TASK_ORDER}`).map(toTask);
  }

  getTask(id: string): Task {
    const r = this.get("SELECT * FROM tasks WHERE id=?", id);
    if (!r) throw new ValidationError("That task no longer exists.");
    return toTask(r);
  }

  addTask(t: { title: string; due?: string; priority?: Priority; notes?: string }): Task {
    const priority = t.priority ?? "normal";
    if (!PRIORITIES.includes(priority)) throw new ValidationError("Unknown priority.");
    const id = randomUUID();
    const ts = now();
    this.run("INSERT INTO tasks(id,title,notes,due,priority,done,done_at,created,updated) VALUES(?,?,?,?,?,0,'',?,?)",
      id, cleanTitle(t.title), String(t.notes ?? "").slice(0, 4000), cleanDue(t.due), priority, ts, ts);
    return this.getTask(id);
  }

  updateTask(id: string, t: Partial<Pick<Task, "title" | "due" | "priority" | "notes">>): Task {
    const cur = this.getTask(id);
    const priority = t.priority ?? cur.priority;
    if (!PRIORITIES.includes(priority)) throw new ValidationError("Unknown priority.");
    this.run("UPDATE tasks SET title=?, due=?, priority=?, notes=?, updated=? WHERE id=?",
      t.title !== undefined ? cleanTitle(t.title) : cur.title, t.due !== undefined ? cleanDue(t.due) : cur.due,
      priority, t.notes !== undefined ? String(t.notes).slice(0, 4000) : cur.notes, now(), id);
    return this.getTask(id);
  }

  setTaskDone(id: string, done: boolean): Task {
    return this.tx(() => {
      const before = this.get("SELECT * FROM tasks WHERE id=?", id);
      if (!before) throw new ValidationError("That task no longer exists.");
      if ((Number(before.done) === 1) === done) return toTask(before);
      const ts = now();
      this.run("UPDATE tasks SET done=?, done_at=?, updated=? WHERE id=?", done ? 1 : 0, done ? ts : "", ts, id);
      const after = this.get("SELECT * FROM tasks WHERE id=?", id)!;
      this.journal(`${done ? "Complete" : "Reopen"} "${before.title}"`, "task", id, before, after);
      return toTask(after);
    });
  }

  deleteTask(id: string) {
    this.tx(() => {
      const before = this.get("SELECT * FROM tasks WHERE id=?", id);
      if (!before) return;
      this.run("DELETE FROM tasks WHERE id=?", id);
      this.journal(`Delete task "${before.title}"`, "task", id, before, null);
    });
  }

  // ---- events --------------------------------------------------------------------------------
  listEvents(from: string, to: string): CalEvent[] {
    return this.all("SELECT * FROM events WHERE date BETWEEN ? AND ? ORDER BY date, start='' DESC, start, title", from, to)
      .map(toEvent);
  }

  getEvent(id: string): CalEvent {
    const r = this.get("SELECT * FROM events WHERE id=?", id);
    if (!r) throw new ValidationError("That event no longer exists.");
    return toEvent(r);
  }

  addEvent(e: Omit<CalEvent, "id" | "created" | "updated">): CalEvent {
    if (!isValidDate(e.date)) throw new ValidationError("Pick a real date for the event.");
    const [start, end] = cleanTimes(e.start, e.end);
    const id = randomUUID();
    const ts = now();
    this.run("INSERT INTO events(id,title,date,start,end_,notes,created,updated) VALUES(?,?,?,?,?,?,?,?)",
      id, cleanTitle(e.title), e.date, start, end, String(e.notes ?? "").slice(0, 4000), ts, ts);
    return this.getEvent(id);
  }

  updateEvent(id: string, e: Partial<Omit<CalEvent, "id" | "created" | "updated">>): CalEvent {
    const cur = this.getEvent(id);
    const date = e.date ?? cur.date;
    if (!isValidDate(date)) throw new ValidationError("Pick a real date for the event.");
    const [start, end] = cleanTimes(e.start ?? cur.start, e.end ?? cur.end);
    this.run("UPDATE events SET title=?, date=?, start=?, end_=?, notes=?, updated=? WHERE id=?",
      e.title !== undefined ? cleanTitle(e.title) : cur.title, date, start, end,
      e.notes !== undefined ? String(e.notes).slice(0, 4000) : cur.notes, now(), id);
    return this.getEvent(id);
  }

  deleteEvent(id: string) {
    this.tx(() => {
      const before = this.get("SELECT * FROM events WHERE id=?", id);
      if (!before) return;
      this.run("DELETE FROM events WHERE id=?", id);
      this.journal(`Delete event "${before.title}"`, "event", id, before, null);
    });
  }

  // ---- undo ----------------------------------------------------------------------------------
  private journal(label: string, entity: "task" | "event", id: string, before: Row, after: Row | null) {
    this.run("INSERT INTO undo(label,entity,entity_id,before_json,after_json,created) VALUES(?,?,?,?,?,?)",
      label, entity, id, JSON.stringify(before), after ? JSON.stringify(after) : "", now());
    this.run(`DELETE FROM undo WHERE id NOT IN (SELECT id FROM undo ORDER BY id DESC LIMIT ${UNDO_KEEP})`);
  }

  latestUndo(): UndoEntry | null {
    const r = this.get("SELECT id, label FROM undo WHERE state='active' ORDER BY id DESC LIMIT 1");
    return r ? { id: Number(r.id), label: String(r.label) } : null;
  }

  /** Undo the newest action. Refuses (changes nothing) if the record changed since. Returns the label. */
  undo(): string | null {
    return this.tx(() => {
      const u = this.get("SELECT * FROM undo WHERE state='active' ORDER BY id DESC LIMIT 1");
      if (!u) return null;
      const table = u.entity === "task" ? "tasks" : "events";
      const before = JSON.parse(String(u.before_json)) as Row;
      const current = this.get(`SELECT * FROM ${table} WHERE id=?`, String(u.entity_id));
      if (u.after_json) {
        const after = JSON.parse(String(u.after_json)) as Row;
        if (!current || JSON.stringify(current) !== JSON.stringify(after))
          throw new ValidationError(`Can't undo "${u.label}": it was changed again afterwards.`);
        this.run(`DELETE FROM ${table} WHERE id=?`, String(u.entity_id));
      } else if (current) {
        throw new ValidationError(`Can't undo "${u.label}": a record with that id exists again.`);
      }
      const cols = Object.keys(before);
      this.run(`INSERT INTO ${table}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`,
        ...cols.map((c) => before[c] as string | number));
      this.run("UPDATE undo SET state='done' WHERE id=?", Number(u.id));
      return String(u.label);
    });
  }

  // ---- projects, steps, jobs -------------------------------------------------------------------
  listProjects(): Project[] {
    return this.all("SELECT * FROM projects ORDER BY updated DESC").map(toProject);
  }
  getProject(id: string): Project {
    const r = this.get("SELECT * FROM projects WHERE id=?", id);
    if (!r) throw new ValidationError("That project no longer exists.");
    return toProject(r);
  }
  createProject(title: string): Project {
    const id = randomUUID();
    const ts = now();
    this.run("INSERT INTO projects(id,title,brief,notes,created,updated) VALUES(?,?,'','',?,?)", id, cleanTitle(title, 120), ts, ts);
    return this.getProject(id);
  }
  updateProject(id: string, p: Partial<Pick<Project, "title" | "brief" | "notes">>): Project {
    const cur = this.getProject(id);
    this.run("UPDATE projects SET title=?, brief=?, notes=?, updated=? WHERE id=?",
      p.title !== undefined ? cleanTitle(p.title, 120) : cur.title, (p.brief ?? cur.brief).slice(0, 12000),
      (p.notes ?? cur.notes).slice(0, 4000), now(), id);
    return this.getProject(id);
  }
  deleteProject(id: string) {
    this.run("DELETE FROM projects WHERE id=?", id);
  }

  listSteps(projectId: string): Step[] {
    return this.all("SELECT * FROM steps WHERE project_id=? ORDER BY idx", projectId).map(toStep);
  }
  getStep(id: string): Step {
    const r = this.get("SELECT * FROM steps WHERE id=?", id);
    if (!r) throw new ValidationError("That step no longer exists.");
    return toStep(r);
  }
  /** Replace unfinished steps (or append, when `append`) with drafts. Draft `ref`/`deps` are local names
   * like "t1"; they are mapped to step ids. Unknown or forward-only references are dropped. */
  replaceSteps(projectId: string, drafts: { ref?: string; title: string; agent: WorkerId; why: string; prompt: string; deps?: string[] }[],
    append = false, chatMsg = ""): Step[] {
    this.tx(() => {
      if (!append) this.run("DELETE FROM steps WHERE project_id=? AND chat_msg='' AND status NOT IN ('done','running')", projectId);
      const base = Number(this.get("SELECT COALESCE(MAX(idx),-1) AS m FROM steps WHERE project_id=?", projectId)!.m) + 1;
      const ids = new Map<string, string>();
      drafts.forEach((d, i) => {
        if (!isWorker(d.agent)) throw new ValidationError(`Unknown worker "${d.agent}".`);
        const id = randomUUID();
        const deps = (d.deps ?? []).map((r) => ids.get(r)).filter((x): x is string => !!x);
        if (d.ref) ids.set(d.ref, id);
        this.run("INSERT INTO steps(id,project_id,idx,title,agent,why,prompt,status,output,updated,deps,chat_msg) VALUES(?,?,?,?,?,?,?,'todo','',?,?,?)",
          id, projectId, base + i, cleanTitle(d.title, 160), d.agent, d.why.slice(0, 400), d.prompt.slice(0, 12000), now(),
          JSON.stringify(deps), chatMsg);
      });
    });
    return this.listSteps(projectId);
  }
  updateStep(id: string, s: Partial<Pick<Step, "title" | "agent" | "prompt" | "status" | "output">>): Step {
    const cur = this.getStep(id);
    if (s.agent && !isWorker(s.agent)) throw new ValidationError("Unknown worker.");
    this.run("UPDATE steps SET title=?, agent=?, prompt=?, status=?, output=?, updated=? WHERE id=?",
      s.title !== undefined ? cleanTitle(s.title, 160) : cur.title, s.agent ?? cur.agent,
      (s.prompt ?? cur.prompt).slice(0, 8000), s.status ?? cur.status, (s.output ?? cur.output).slice(0, 200_000), now(), id);
    return this.getStep(id);
  }
  /** Queue every unfinished step of a project (failed ones are retried). Returns how many were queued. */
  queueAll(projectId: string): number {
    return Number(this.run("UPDATE steps SET status='queued', updated=? WHERE project_id=? AND chat_msg='' AND status IN ('todo','failed')",
      now(), projectId).changes);
  }
  unqueue(projectId: string) {
    this.run("UPDATE steps SET status='todo', updated=? WHERE project_id=? AND status='queued'", now(), projectId);
  }
  stepsOfChat(messageId: string): Step[] {
    return this.all("SELECT * FROM steps WHERE chat_msg=? ORDER BY idx", messageId).map(toStep);
  }
  queuedSteps(): Step[] {
    return this.all("SELECT * FROM steps WHERE status='queued' ORDER BY idx").map(toStep);
  }
  deleteStep(id: string) {
    this.run("DELETE FROM steps WHERE id=?", id);
  }

  startJob(j: { projectId: string; stepId: string; agent: WorkerId; title: string }): Job {
    const id = randomUUID();
    this.run("INSERT INTO jobs(id,project_id,step_id,agent,title,status,started) VALUES(?,?,?,?,?,'running',?)",
      id, j.projectId, j.stepId, j.agent, j.title, now());
    return this.getJob(id);
  }
  finishJob(id: string, ok: boolean, output: string, error = ""): Job {
    this.run("UPDATE jobs SET status=?, output=?, error=?, finished=? WHERE id=?",
      ok ? "done" : "failed", output.slice(0, 200_000), error.slice(0, 4000), now(), id);
    return this.getJob(id);
  }
  getJob(id: string): Job {
    return toJob(this.get("SELECT * FROM jobs WHERE id=?", id)!);
  }
  listJobs(limit = 100): Job[] {
    return this.all("SELECT * FROM jobs ORDER BY started DESC LIMIT ?", limit).map(toJob);
  }
  /** Jobs left 'running' by a crash or forced quit can never finish; mark them failed at startup. */
  failStaleJobs() {
    this.run("UPDATE jobs SET status='failed', error='The app closed while this was running.', finished=? WHERE status='running'", now());
    this.run("UPDATE steps SET status='failed' WHERE status='running'");
    this.run("UPDATE steps SET status='todo' WHERE status='queued' AND chat_msg=''"); // chat steps resume by themselves
  }

  // ---- chat ---------------------------------------------------------------------------------------
  listChat(projectId: string, limit = 300): ChatMessage[] {
    return this.all("SELECT * FROM (SELECT *, rowid AS rid FROM chat WHERE project_id=? ORDER BY created DESC, rowid DESC LIMIT ?) ORDER BY created, rid",
      projectId, limit).map(toChat);
  }
  getChat(id: string): ChatMessage {
    const r = this.get("SELECT * FROM chat WHERE id=?", id);
    if (!r) throw new ValidationError("That message no longer exists.");
    return toChat(r);
  }
  addChat(m: { projectId: string; role: "user" | "assistant"; author: string; content?: string; private?: boolean;
    status?: ChatStatus; mode?: ChatMode | ""; reason?: string; replyTo?: string }): ChatMessage {
    this.getProject(m.projectId);
    const id = randomUUID();
    const ts = now();
    this.run("INSERT INTO chat(id,project_id,role,author,content,private,status,mode,reason,reply_to,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      id, m.projectId, m.role, m.author, (m.content ?? "").slice(0, 200_000), m.private ? 1 : 0, m.status ?? "done", m.mode ?? "",
      (m.reason ?? "").slice(0, 400), m.replyTo ?? "", ts, ts);
    return this.getChat(id);
  }
  updateChat(id: string, c: Partial<Pick<ChatMessage, "content" | "status" | "mode" | "reason" | "author" | "private">>): ChatMessage {
    const cur = this.getChat(id);
    this.run("UPDATE chat SET content=?, status=?, mode=?, reason=?, author=?, private=?, updated=? WHERE id=?",
      (c.content ?? cur.content).slice(0, 200_000), c.status ?? cur.status, c.mode ?? cur.mode, (c.reason ?? cur.reason).slice(0, 400),
      c.author ?? cur.author, (c.private ?? cur.private) ? 1 : 0, now(), id);
    return this.getChat(id);
  }
  /** After a restart: a reply that was being written can't continue, but one whose steps are still waiting
   * (for your approval, or queued) carries on when those steps finish. */
  failStaleChat() {
    for (const r of this.all("SELECT id FROM chat WHERE status IN ('thinking','working','waiting')")) {
      const open = this.get("SELECT COUNT(*) AS n FROM steps WHERE chat_msg=? AND status IN ('todo','queued')", String(r.id));
      if (!open || Number(open.n) === 0) this.run("UPDATE chat SET status='stopped', updated=? WHERE id=?", now(), String(r.id));
    }
  }
  /** Cloud calls started today (local time), per worker: for the usage counter. */
  cloudCallsToday(): Record<string, number> {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const out: Record<string, number> = {};
    for (const r of this.all(`SELECT agent, COUNT(*) AS n FROM jobs WHERE started >= ? AND agent IN (${CLOUD.map(() => "?").join(",")}) GROUP BY agent`,
      start.toISOString(), ...CLOUD)) out[String(r.agent)] = Number(r.n);
    return out;
  }

  getSetting(key: string, fallback: string): string {
    const r = this.get("SELECT value FROM meta WHERE key=?", `setting:${key}`);
    return r ? String(r.value) : fallback;
  }
  setSetting(key: string, value: string) {
    this.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", `setting:${key}`, value);
  }

  // ---- one-time import from the old tkinter app (opened read-only, never modified) -------------
  importOld(oldFile: string): ImportResult {
    if (!existsSync(oldFile)) throw new ValidationError(`No old database at ${oldFile}.`);
    const old = new DatabaseSync(oldFile, { readOnly: true });
    const res: ImportResult = { tasks: 0, events: 0, projects: 0, skipped: 0 };
    try {
      const has = (t: string) => !!old.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
      this.tx(() => {
        if (has("pa_tasks")) for (const r of old.prepare("SELECT * FROM pa_tasks").all() as Row[]) {
          const exists = this.get("SELECT 1 FROM tasks WHERE id=?", String(r.id));
          if (exists) { res.skipped++; continue; }
          this.run("INSERT INTO tasks(id,title,notes,due,priority,done,done_at,created,updated) VALUES(?,?,?,?,?,?,?,?,?)",
            String(r.id), String(r.title), String(r.notes ?? ""), String(r.due_date ?? ""),
            PRIORITIES.includes(r.priority as Priority) ? String(r.priority) : "normal", Number(r.done) ? 1 : 0,
            String(r.done_at ?? ""), String(r.created), String(r.updated));
          res.tasks++;
        }
        if (has("pa_events")) for (const r of old.prepare("SELECT * FROM pa_events").all() as Row[]) {
          const exists = this.get("SELECT 1 FROM events WHERE id=?", String(r.id));
          if (exists) { res.skipped++; continue; }
          this.run("INSERT INTO events(id,title,date,start,end_,notes,created,updated) VALUES(?,?,?,?,?,?,?,?)",
            String(r.id), String(r.title), String(r.event_date), String(r.start_time ?? ""), String(r.end_time ?? ""),
            String(r.notes ?? ""), String(r.created), String(r.updated));
          res.events++;
        }
        if (has("projects")) {
          const cols = (old.prepare("PRAGMA table_info(projects)").all() as Row[]).map((c) => String(c.name));
          for (const r of old.prepare("SELECT * FROM projects").all() as Row[]) {
            const id = String(r.id);
            if (this.get("SELECT 1 FROM projects WHERE id=?", id)) { res.skipped++; continue; }
            const pick = (k: string) => (cols.includes(k) ? String(r[k] ?? "") : "");
            const ts = pick("created") || now();
            this.run("INSERT INTO projects(id,title,brief,notes,created,updated) VALUES(?,?,?,?,?,?)",
              id, pick("title") || "Imported project", pick("brief"), pick("notes"), ts, pick("updated") || ts);
            res.projects++;
          }
        }
      });
    } finally {
      old.close();
    }
    return res;
  }
}
