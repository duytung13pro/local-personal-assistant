// Live check of the real agents (not part of `npm test`): node dist/e2e-agents.cjs <tmpDir> [--chatgpt]
// 1) Qwen Coder (local file-tool agent) writes a file.  2) Two local models answer at the same time.
// 3) With --chatgpt: ChatGPT plans a made-up brief (uses a little of the ChatGPT plan; no personal data).
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ollamaChat, runCodex } from "../src/main/providers";
import { runLocalCoder } from "../src/main/localcoder";
import { goodPlan, parsePlan, plannerPrompt } from "../src/main/orchestrator";
import { ASSIGNABLE } from "../src/shared/workers";

const dir = process.argv[2];
const t = (t0: number) => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
(async () => {
  const work = join(dir, "coder");
  mkdirSync(work, { recursive: true });
  let t0 = Date.now();
  try {
    const out = await runLocalCoder("qwen3-coder:30b",
      "Create a file named hello.html containing a minimal HTML page whose <h1> says 'Hello from Qwen'. Then say which file you created.",
      work, 5 * 60_000);
    const files = readdirSync(work);
    console.log(`[qwen-coder] ${t(t0)} files=${files.join(",") || "(none)"} h1ok=${files.includes("hello.html") &&
      /Hello from Qwen/.test(readFileSync(join(work, "hello.html"), "utf8"))}\n  says: ${out.slice(0, 200).replace(/\n/g, " ")}`);
  } catch (e) {
    console.log(`[qwen-coder] FAILED ${t(t0)}: ${(e as Error).message.slice(0, 600)}`);
  }

  t0 = Date.now();
  const [a, b] = await Promise.all([
    ollamaChat("qwen3:30b", "Answer in one sentence.", "Why do budgets help?").then((x) => [x, t(t0)]),
    ollamaChat("gpt-oss:20b", "Answer in one sentence.", "Name one risk of storing money data in a CSV file.").then((x) => [x, t(t0)]),
  ]);
  console.log(`[parallel] qwen3:30b ${a[1]}: ${a[0].slice(0, 120)}\n[parallel] gpt-oss:20b ${b[1]}: ${b[0].slice(0, 120)}\n  total ${t(t0)}`);

  if (process.argv.includes("--chatgpt")) {
    t0 = Date.now();
    const p = { id: "x", title: "Tip calculator", brief: "Build a tiny offline tip calculator web page: bill, tip %, people; shows each person's share.",
      notes: "", created: "", updated: "" };
    const allowed = ASSIGNABLE.filter((w) => w !== "claude");
    const text = await runCodex(plannerPrompt(p, allowed), join(dir, "coder"), join(dir, "plan-last.txt"));
    const plan = parsePlan(text, allowed);
    console.log(`[chatgpt] ${t(t0)} valid=${!!plan} good=${!!plan && goodPlan(p.brief, plan)}`);
    for (const s of plan ?? []) console.log(`  ${s.ref} [${s.agent}] ${s.title}${s.deps?.length ? `  (after ${s.deps.join(",")})` : ""}`);
    if (!plan) console.log(text.slice(0, 800));
  }
})();
