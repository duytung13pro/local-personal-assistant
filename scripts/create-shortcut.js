// Creates (or updates) a Start menu shortcut that opens the app directly, without a console window.
// Run: npm run shortcut          Add --desktop to also put one on the Desktop.  --remove deletes them.
// The shortcut carries the same AppUserModelID as the app (see APP_ID in src/main/main.ts), so a pinned
// taskbar icon and the running window are one icon. Windows does not let programs pin themselves to the
// taskbar: right-click the Start menu entry > Pin to taskbar.
const { app, shell } = require("electron");
const { existsSync, mkdirSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");

const APP_ID = "Duytung.LocalPersonalAssistant";
const NAME = "Local Personal Assistant.lnk";
const root = resolve(__dirname, "..");

app.whenReady().then(() => {
  const places = [join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs")];
  if (process.argv.includes("--desktop")) places.push(app.getPath("desktop"));
  for (const dir of places) {
    const link = join(dir, NAME);
    if (process.argv.includes("--remove")) {
      if (existsSync(link)) rmSync(link);
      console.log("removed", link);
      continue;
    }
    mkdirSync(dir, { recursive: true });
    const ok = shell.writeShortcutLink(link, existsSync(link) ? "replace" : "create", {
      target: process.execPath, // node_modules\electron\dist\electron.exe
      args: `"${root}"`,
      cwd: root,
      description: "Planner, calendar, checklist and a multi-model AI team",
      icon: join(root, "build", "icon.ico"),
      iconIndex: 0,
      appUserModelId: APP_ID,
    });
    console.log(ok ? "wrote" : "FAILED", link);
  }
  app.quit();
});
