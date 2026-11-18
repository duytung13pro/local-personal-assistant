import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { addDays, isValidDate, layoutTimed, monthGrid, rangeLabel } from "../src/shared/dates";
import { Store, ValidationError } from "../src/main/db";
import { goodPlan, parsePlan, parseReview, rulePlan, stepPrompt, waves } from "../src/main/orchestrator";
import { matches } from "../src/shared/filters";
import { parseMention } from "../src/shared/workers";
import { contextText, parseRoute, runPlannerTool } from "../src/main/chat";

const dir = () => mkdtempSync(join(process.env.PA_TEST_TMP ?? tmpdir(), "pa-test-"));

test("dates: real dates only, month grid, ranges", () => {
  assert.ok(isValidDate("2028-02-29"));
  assert.ok(!isValidDate("2026-02-29"));
  assert.ok(!isValidDate("2026-13-01"));
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  const g = monthGrid(2026, 10); // November 2026 starts on a Sunday
  assert.equal(g.length, 42);
  assert.equal(g[0], "2026-11-01");
  assert.equal(rangeLabel(["2026-11-18", "2026-11-19", "2026-11-20"]), "Nov 18 – 20, 2026");
  assert.equal(rangeLabel(["2026-12-31", "2027-01-01"]), "Dec 31, 2026 – Jan 1, 2027");
});

test("dates: overlapping events get side-by-side lanes", () => {
  const p = layoutTimed([{ start: "09:00", end: "10:00" }, { start: "09:30", end: "10:30" }, { start: "11:00", end: "11:30" }]);
  assert.deepEqual(p.map((x) => [x.lane, x.lanes]), [[0, 2], [1, 2], [0, 1]]);
});

test("store: tasks validate, complete, delete and undo exactly", () => {
  const d = dir();
  const s = new Store(join(d, "t.db"));
  try {
    assert.throws(() => s.addTask({ title: "  " }), ValidationError);
    assert.throws(() => s.addTask({ title: "x", due: "2026-02-30" }), ValidationError);
    const t = s.addTask({ title: "  Buy   milk ", due: "2026-11-18", priority: "high" });
    assert.equal(t.title, "Buy milk");
    s.setTaskDone(t.id, true);
    assert.equal(s.latestUndo()?.label, 'Complete "Buy milk"');
    assert.equal(s.undo(), 'Complete "Buy milk"');
    assert.equal(s.getTask(t.id).done, false);
    s.deleteTask(t.id);
    assert.equal(s.listTasks().length, 0);
    s.undo();
    assert.deepEqual(s.getTask(t.id), t, "undo restores the identical row");
    // undo refuses when the record changed after the action
    s.setTaskDone(t.id, true);
    s.updateTask(t.id, { title: "Changed" });
    assert.throws(() => s.undo(), /changed again/);
  } finally {
    s.close();
    rmSync(d, { recursive: true, force: true });
  }
});

test("store: events need both times, end after start", () => {
  const d = dir();
  const s = new Store(join(d, "e.db"));
  try {
    assert.throws(() => s.addEvent({ title: "x", date: "2026-11-18", start: "09:00", end: "", notes: "" }), /both a start/);
    assert.throws(() => s.addEvent({ title: "x", date: "2026-11-18", start: "10:00", end: "09:00", notes: "" }), /after the start/);
    const e = s.addEvent({ title: "Standup", date: "2026-11-18", start: "09:00", end: "09:15", notes: "" });
    s.addEvent({ title: "Holiday", date: "2026-11-18", start: "", end: "", notes: "" });
    assert.deepEqual(s.listEvents("2026-11-18", "2026-11-18").map((x) => x.title), ["Holiday", "Standup"]);
    s.deleteEvent(e.id);
    s.undo();
    assert.equal(s.getEvent(e.id).title, "Standup");
  } finally {
    s.close();
    rmSync(d, { recursive: true, force: true });
  }
});

test("store: import from the old app is read-only and idempotent", () => {
  const d = dir();
  const oldFile = join(d, "old.db");
  const old = new DatabaseSync(oldFile);
  old.exec(`CREATE TABLE pa_tasks(id TEXT PRIMARY KEY, title TEXT, notes TEXT, due_date TEXT, priority TEXT, done INTEGER,
      done_at TEXT, seq INTEGER, created TEXT, updated TEXT);
    CREATE TABLE pa_events(id TEXT PRIMARY KEY, title TEXT, event_date TEXT, start_time TEXT, end_time TEXT, notes TEXT,
      seq INTEGER, created TEXT, updated TEXT);
    INSERT INTO pa_tasks VALUES('t1','Old task','','2026-11-20','high',0,'',1,'2026-01-01','2026-01-01');
    INSERT INTO pa_events VALUES('e1','Old event','2026-11-21','','','',1,'2026-01-01','2026-01-01');`);
  old.close();
  const s = new Store(join(d, "new.db"));
  try {
    assert.deepEqual(s.importOld(oldFile), { tasks: 1, events: 1, projects: 0, skipped: 0 });
    assert.deepEqual(s.importOld(oldFile), { tasks: 0, events: 0, projects: 0, skipped: 2 });
    assert.equal(s.getTask("t1").priority, "high");
    const check = new DatabaseSync(oldFile, { readOnly: true });
    assert.equal((check.prepare("SELECT count(*) AS n FROM pa_tasks").get() as { n: number }).n, 1);
    check.close();
  } finally {
    s.close();
    rmSync(d, { recursive: true, force: true });
  }
});

test("orchestrator: planner JSON is validated; workers and deps are checked", () => {
  assert.equal(parsePlan("not json"), null);
  assert.equal(parsePlan('{"tasks":[{"title":"x","worker":"gpt5"}]}'), null);
  assert.equal(parsePlan('{"tasks":[{"title":"x","worker":"claude"}]}', ["qwen", "qwen-coder"]), null, "disabled worker refused");
  const ok = parsePlan(`Sure! {"tasks":[{"id":"t1","title":"Spec","worker":"qwen","deps":[],"prompt":"spec"},
    {"id":"t2","title":"Tests","worker":"gpt-oss","deps":["t9"]},{"id":"t3","title":"Build","worker":"Qwen-Coder","deps":["t1","t2","t3"]}]}`);
  assert.deepEqual(ok?.map((d) => [d.ref, d.agent, d.deps]), [["t1", "qwen", []], ["t2", "gpt-oss", []], ["t3", "qwen-coder", ["t1", "t2"]]],
    "unknown and self/forward dependencies are dropped");
  assert.equal(parsePlan('{"tasks":[{"title":"x","worker":"chatgpt"}]}'), null, "ChatGPT never assigns itself work");
});

test("orchestrator: weak splits are rejected; the fallback runs work in parallel", () => {
  const d = (agent: "qwen" | "qwen-coder" | "gpt-oss") => ({ title: "x", agent, why: "", prompt: "" });
  assert.ok(!goodPlan("Build a habit tracker app", [d("qwen")]), "a single task is not a split");
  assert.ok(!goodPlan("Build a habit tracker app", [d("qwen"), d("gpt-oss")]), "building needs a file-writing worker");
  assert.ok(goodPlan("Summarise my notes and draft an email", [d("qwen"), d("qwen")]));
  const rules = rulePlan(["qwen-coder", "qwen", "gpt-oss"]);
  assert.deepEqual(rules.map((r) => r.agent), ["qwen", "gpt-oss", "qwen-coder", "gpt-oss"]);
  assert.deepEqual(rules.map((r) => r.deps), [[], [], ["t1", "t2"], ["t3"]], "spec and tests run side by side");
});

test("orchestrator: review JSON and dependency waves", () => {
  const r = parseReview('{"verdict":"needs_work","summary":"Missing CSV export.","tasks":[{"id":"f1","title":"Add CSV","worker":"qwen-coder","prompt":"add it"}]}');
  assert.equal(r?.tasks.length, 1);
  assert.deepEqual(parseReview('{"verdict":"done","summary":"All good.","tasks":[{"id":"f1","title":"x","worker":"qwen"}]}')?.tasks, [],
    "a 'done' verdict adds no work");
  assert.equal(parseReview('{"verdict":"done"}'), null, "a summary is required");
  const w = waves([{ id: "a", deps: [] }, { id: "b", deps: [] }, { id: "c", deps: ["a", "b"] }, { id: "d", deps: ["c"] }]);
  assert.deepEqual([...w.entries()], [["a", 0], ["b", 0], ["c", 1], ["d", 2]]);
});

test("orchestrator: a task's prompt carries only the results it depends on", () => {
  const p = { id: "p", title: "Budget app", brief: "Track spending", notes: "", created: "", updated: "" };
  const mk = (id: string, status: "done" | "todo", output: string, deps: string[] = []) => ({ id, projectId: "p", idx: 0,
    title: `S${id}`, agent: "qwen-coder" as const, why: "", prompt: `do ${id}`, deps, chatMsg: "", status, output, updated: "" });
  const steps = [mk("a", "done", "SPEC-OUTPUT"), mk("b", "done", "UNRELATED"), mk("c", "todo", "", ["a"])];
  const text = stepPrompt(p, steps, steps[2]);
  assert.match(text, /SPEC-OUTPUT/);
  assert.doesNotMatch(text, /UNRELATED/);
  assert.match(text, /only inside the current folder/);
});

test("store: steps keep dependencies; queueing retries failures", () => {
  const dd = dir();
  const s = new Store(join(dd, "s.db"));
  try {
    const p = s.createProject("P");
    const steps = s.replaceSteps(p.id, [{ ref: "t1", title: "A", agent: "qwen", why: "", prompt: "" },
      { ref: "t2", title: "B", agent: "qwen-coder", why: "", prompt: "", deps: ["t1"] }]);
    assert.deepEqual(steps[1].deps, [steps[0].id]);
    s.updateStep(steps[0].id, { status: "failed" });
    assert.equal(s.queueAll(p.id), 2);
    assert.equal(s.queuedSteps().length, 2);
    s.unqueue(p.id);
    assert.equal(s.queuedSteps().length, 0);
    assert.throws(() => s.replaceSteps(p.id, [{ title: "x", agent: "gpt5" as never, why: "", prompt: "" }]), /Unknown worker/);
  } finally {
    s.close();
    rmSync(dd, { recursive: true, force: true });
  }
});

test("checklist search: every word must match title or notes", () => {
  const t = { id: "1", title: "Pay rent", notes: "landlord Mr. Phạm", due: "2026-11-10", priority: "high" as const, done: false,
    doneAt: "", created: "", updated: "" };
  assert.ok(matches(t, "rent phạm", "open", "all", "any", "2026-11-18"));
  assert.ok(!matches(t, "rent water", "open", "all", "any", "2026-11-18"));
  assert.ok(matches(t, "", "open", "high", "overdue", "2026-11-18"));
  assert.ok(!matches(t, "", "done", "all", "any", "2026-11-18"));
});

test("chat: @mentions pick a model; unknown ones are left alone", () => {
  assert.deepEqual(parseMention("@codex fix the login bug"), ["codex", "fix the login bug"]);
  assert.deepEqual(parseMention("@claude-chat: write a poem"), ["claude-chat", "write a poem"]);
  assert.deepEqual(parseMention("@coder add a test"), ["qwen-coder", "add a test"]);
  assert.deepEqual(parseMention("@bob hello"), [null, "@bob hello"]);
  assert.deepEqual(parseMention("email me @home"), [null, "email me @home"]);
});

test("chat: routes are validated against the workers that are ready", () => {
  const ready = ["qwen", "qwen-coder", "chatgpt", "gpt-oss"] as const;
  assert.deepEqual(parseRoute('{"mode":"self","reason":"Just a greeting."}', [...ready]), { mode: "self", reason: "Just a greeting." });
  assert.equal(parseRoute('{"mode":"single","worker":"claude","reason":"x"}', [...ready]), null, "unavailable worker refused");
  assert.equal(parseRoute('{"mode":"single","worker":"chatgpt","reason":"Hard question."}', [...ready])?.worker, "chatgpt");
  const split = parseRoute(`{"mode":"split","reason":"Prep then cook.","tasks":[{"id":"t1","title":"Spec","worker":"qwen"},
    {"id":"t2","title":"Build","worker":"qwen-coder","deps":["t1"]}]}`, [...ready]);
  assert.deepEqual(split?.tasks?.map((t) => [t.agent, t.deps]), [["qwen", []], ["qwen-coder", ["t1"]]]);
  assert.equal(parseRoute('{"mode":"split","tasks":[{"id":"t1","title":"Only one","worker":"qwen"}]}', [...ready]), null);
  assert.equal(parseRoute("I think you should...", [...ready]), null);
});

test("chat: planner answers never reach cloud models", () => {
  const m = (role: "user" | "assistant", content: string, priv = false) => ({ id: content, projectId: "p", role, author: role === "user" ? "you" : "qwen",
    content, private: priv, status: "done" as const, mode: "" as const, reason: "", replyTo: "", created: "" });
  const msgs = [m("user", "what's due friday"), m("assistant", "Pay rent (due Friday)", true), m("user", "write a haiku")];
  assert.match(contextText(msgs, "", false), /Pay rent/);
  assert.doesNotMatch(contextText(msgs, "", true), /Pay rent/);
});

test("chat: planner tools change real tasks (with undo) and report what changed", () => {
  const dd = dir();
  const s = new Store(join(dd, "c.db"));
  try {
    const changes: string[] = [];
    const t = JSON.parse(runPlannerTool(s, "add_task", { title: "Call the bank", due: "2026-11-20", priority: "high" }, changes));
    runPlannerTool(s, "set_task_done", { id: t.id, done: true }, changes);
    assert.deepEqual(changes, ['added task "Call the bank"', 'completed "Call the bank"']);
    assert.match(runPlannerTool(s, "add_task", { title: "x", due: "2026-02-31" }, []), /^Error: Due date/);
    assert.match(runPlannerTool(s, "delete_task", { id: "nope" }, []), /^Error:/);
    assert.equal(s.latestUndo()?.label, 'Complete "Call the bank"');
  } finally {
    s.close();
    rmSync(dd, { recursive: true, force: true });
  }
});

test("chat: messages, chat steps stay out of Run all, cloud usage counts today", () => {
  const dd = dir();
  const s = new Store(join(dd, "m.db"));
  try {
    const p = s.createProject("P");
    const u = s.addChat({ projectId: p.id, role: "user", author: "you", content: "hi" });
    const a = s.addChat({ projectId: p.id, role: "assistant", author: "chef", status: "thinking", replyTo: u.id });
    s.updateChat(a.id, { content: "hello", status: "done" });
    assert.deepEqual(s.listChat(p.id).map((m) => m.content), ["hi", "hello"]);
    s.replaceSteps(p.id, [{ title: "Team step", agent: "qwen", why: "", prompt: "" }]);
    s.replaceSteps(p.id, [{ title: "Chat step", agent: "codex", why: "", prompt: "" }], true, a.id);
    assert.equal(s.queueAll(p.id), 1, "Run all must not send chat steps that wait for approval");
    assert.equal(s.stepsOfChat(a.id)[0].status, "todo");
    s.replaceSteps(p.id, [{ title: "Re-plan", agent: "qwen", why: "", prompt: "" }]);
    assert.equal(s.stepsOfChat(a.id).length, 1, "re-planning the Team board keeps chat steps");
    s.finishJob(s.startJob({ projectId: p.id, stepId: "", agent: "chatgpt", title: "x" }).id, true, "ok");
    s.startJob({ projectId: p.id, stepId: "", agent: "qwen", title: "local" });
    assert.deepEqual(s.cloudCallsToday(), { chatgpt: 1 });
    const streaming = s.addChat({ projectId: p.id, role: "assistant", author: "chef", status: "working" });
    s.failStaleChat();
    assert.equal(s.getChat(streaming.id).status, "stopped", "a reply that was being written stops on restart");
    assert.equal(s.getChat(a.id).status, "done", "finished replies are untouched");
    const waiting = s.addChat({ projectId: p.id, role: "assistant", author: "chef", status: "waiting" });
    s.replaceSteps(p.id, [{ title: "Needs OK", agent: "claude", why: "", prompt: "" }], true, waiting.id);
    s.failStaleChat();
    assert.equal(s.getChat(waiting.id).status, "waiting", "a reply waiting for your approval survives a restart");
  } finally {
    s.close();
    rmSync(dd, { recursive: true, force: true });
  }
});
