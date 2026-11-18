// Bundles the Electron main process and preload script (CommonJS, Node target).
import { build } from "esbuild";

const common = { bundle: true, platform: "node", target: "node24", format: "cjs", sourcemap: true,
  external: ["electron", "node:sqlite"], logLevel: "warning" };

await build({ ...common, entryPoints: ["src/main/main.ts"], outfile: "dist/main/main.js" });
await build({ ...common, entryPoints: ["src/main/preload.ts"], outfile: "dist/main/preload.js" });
console.log("main + preload built");
