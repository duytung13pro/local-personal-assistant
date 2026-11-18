// Fill a throwaway data folder with sample data for screenshots: node scripts/run-seed.mjs <dataDir>
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/main/db";
import { addDays, today } from "../src/shared/dates";

const dir = process.argv[2];
if (!dir) throw new Error("usage: seed-demo <dataDir>");
mkdirSync(dir, { recursive: true });
const s = new Store(join(dir, "personal-assistant.db"));
const t = today();
const tasks: [string, number, "low" | "normal" | "high", string?][] = [
  ["Review Q4 budget draft", 0, "high", "Compare with last year"], ["Reply to landlord about the lease", 0, "normal"],
  ["Pick up dry cleaning", 0, "low"], ["Prepare slides for Friday demo", 1, "high"], ["Book dentist appointment", 1, "normal"],
  ["Call mom", 2, "normal"], ["Pay electricity bill", -2, "high"], ["Plan weekend hike", 2, "low", "Check weather first"],
];
for (const [title, off, priority, notes] of tasks) s.addTask({ title, due: addDays(t, off), priority, notes });
s.setTaskDone(s.listTasks().find((x) => x.title === "Pick up dry cleaning")!.id, true);
s.addTask({ title: "Learn Rust basics", priority: "low" });
const events: [string, number, string, string][] = [
  ["Standup", 0, "09:00", "09:15"], ["Design review", 0, "10:30", "11:30"], ["Lunch with Linh", 0, "12:00", "13:00"],
  ["Focus: budget", 0, "11:00", "12:00"], ["Gym", 0, "18:00", "19:00"], ["Team sync", 1, "14:00", "15:00"],
  ["Demo day", 2, "", ""], ["Dentist", 6, "08:30", "09:30"], ["Flight to Hanoi", 9, "07:10", "10:40"],
];
for (const [title, off, start, end] of events) s.addEvent({ title, date: addDays(t, off), start, end, notes: "" });
const p = s.createProject("Budget tracker");
s.updateProject(p.id, { brief: "A small offline web page that tracks monthly spending by category, with a chart and CSV export." });
s.replaceSteps(p.id, [
  { ref: "t1", title: "Write a short spec", agent: "qwen", why: "Turns the brief into requirements.", prompt: "Write the spec." },
  { ref: "t2", title: "List test cases", agent: "gpt-oss", why: "Runs in parallel with the spec.", prompt: "List test cases." },
  { ref: "t3", title: "Build the page", agent: "qwen-coder", why: "Writes the files.", prompt: "Implement it.", deps: ["t1", "t2"] },
  { ref: "t4", title: "Write the README", agent: "qwen-fast", why: "Short local writing.", prompt: "5-line README.", deps: ["t3"] },
]);
const st = s.listSteps(p.id);
s.updateStep(st[0].id, { status: "done", output: "Spec: monthly categories, chart, CSV export." });
s.updateStep(st[1].id, { status: "running" });
s.close();
console.log("seeded", dir);
