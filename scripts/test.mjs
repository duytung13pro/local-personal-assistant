// Bundle tests/*.test.ts with esbuild and run them with node's built-in test runner.
import { build } from "esbuild";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const entries = readdirSync("tests").filter((f) => f.endsWith(".test.ts")).map((f) => `tests/${f}`);
await build({ entryPoints: entries, outdir: "dist/tests", bundle: true, platform: "node", target: "node24",
  format: "cjs", outExtension: { ".js": ".cjs" }, external: ["node:sqlite"], logLevel: "warning" });
const files = entries.map((e) => e.replace(/^tests\//, "dist/tests/").replace(/\.ts$/, ".cjs"));
const r = spawnSync(process.execPath, ["--test", "--no-warnings", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
