// Live check of the head chef (local only, no cloud): node dist/e2e-chat.cjs <tmpDir>
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/main/db";
import { parseRoute, routerPrompt, runPlanner } from "../src/main/chat";
import { ollamaChat } from "../src/main/providers";
import { addDays, today } from "../src/shared/dates";
import type { WorkerId } from "../src/shared/types";

const dir = process.argv[2];
mkdirSync(dir, { recursive: true });
const s = new Store(join(dir, "chat-e2e.db"));
const p = s.createProject("Budget tracker");
s.addTask({ title: "Pay electricity bill", due: addDays(today(), 1), priority: "high" });
s.addTask({ title: "Dentist booking", due: addDays(today(), 3) });
s.addEvent({ title: "Team sync", date: addDays(today(), 2), start: "14:00", end: "15:00", notes: "" });
const avail: WorkerId[] = ["qwen", "qwen-fast", "gpt-oss", "qwen-coder", "chatgpt", "codex", "claude", "claude-chat"];
const t = (t0: number) => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

(async () => {
  const msgs = [
    "Hi! Who are you?",
    "What's due in the next few days?",
    "Add a task to call the bank on " + addDays(today(), 4) + ", high priority",
    "Build a small HTML page that converts USD to VND with a live input",
    "Give me an in-depth comparison of SQLite vs Postgres for a personal desktop app, with a recommendation",
    "Viết giúp tôi một email ngắn xin nghỉ phép ngày mai",
  ];
  for (const m of msgs) {
    const t0 = Date.now();
    const ans = await ollamaChat("qwen3:30b", "Reply with JSON only.", routerPrompt(p, "", m, avail), { json: true, timeoutMs: 600_000, think: process.argv.includes("--think") });
    const r = parseRoute(ans, avail);
    const what = !r ? `UNUSABLE: ${ans.slice(0, 160)}` : r.mode === "single" ? `single → ${r.worker}` :
      r.mode === "split" ? `split → ${r.tasks!.map((x) => `${x.agent}${x.deps?.length ? `(after ${x.deps.join(",")})` : ""}`).join(" | ")}` : r.mode;
    console.log(`[${t(t0)}] "${m.slice(0, 50)}" ⇒ ${what}${r ? `  — ${r.reason}` : ""}`);
    if (r?.mode === "planner" && !process.argv.includes("--route-only")) {
      const t1 = Date.now();
      const out = await runPlanner(s, "qwen3:30b", "", m);
      console.log(`    planner ${t(t1)}: ${out.answer.replace(/\n/g, " ").slice(0, 220)}`);
      if (out.changes.length) console.log(`    changes: ${out.changes.join("; ")}`);
    }
  }
  console.log("tasks now:", s.listTasks().map((x) => `${x.title} (${x.due || "-"}, ${x.priority})`).join(" · "));
  s.close();
})();
