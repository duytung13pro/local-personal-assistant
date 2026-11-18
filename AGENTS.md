# Instructions for AI agents working on this repo (Codex reads this; CLAUDE.md points here)

## Roles
- Codex: plan and review. Write plans as numbered steps with file names; review diffs for bugs, most severe first.
- Claude Code: implement. Small, working changes; run `npm run typecheck` and `npm test` before saying done.
- Qwen (local): summaries and drafts only; never edits the repo.

## Rules
- Stack is fixed: Electron + React + TypeScript + Tailwind 4 + Motion + node:sqlite. No new UI frameworks,
  no native npm modules (they need compilers), no network calls except Ollama on 127.0.0.1.
- The renderer never gets Node access; add new capabilities as IPC handlers in `src/main/main.ts`, typed in
  `src/shared/types.ts`, exposed in `src/main/preload.ts`.
- Pure logic goes in `src/shared/` with tests in `tests/`.
- Never send calendar/task data to a cloud agent. Cloud steps must keep the preview-and-confirm dialog.
- Motion: no animation on frequent actions (view switches, hovers beyond colour, list updates). Enter with
  ease-out under 250 ms; respect prefers-reduced-motion.
- Save everything on D:. Do not touch `D:\LocalAI` except reading the old database for import.
