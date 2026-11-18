// Renders the app icon with Electron and writes build/icon.png + build/icon.ico (PNG-in-ICO, 16-256 px).
// Run: npx electron scripts/make-icon.js
const { app, BrowserWindow } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ff9a45"/><stop offset="1" stop-color="#ec7417"/></linearGradient></defs>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#g)"/>
  <rect x="58" y="62" width="140" height="132" rx="22" fill="#fff" opacity="0.96"/>
  <rect x="58" y="62" width="140" height="34" rx="22" fill="#2a1606"/>
  <rect x="58" y="80" width="140" height="16" fill="#2a1606"/>
  <path d="M92 144l22 22 46-50" fill="none" stroke="#ec7417" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

function ico(pngs) { // pngs: [{size, buf}]
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, buf }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(buf.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += buf.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.buf)]);
}

app.whenReady().then(async () => {
  const out = join(__dirname, "..", "build");
  mkdirSync(out, { recursive: true });
  const win = new BrowserWindow({ width: 256, height: 256, show: false, frame: false, transparent: true, useContentSize: true });
  await win.loadURL("data:text/html," + encodeURIComponent(
    `<html><body style="margin:0;background:transparent">${SVG.replace("<svg ", '<svg width="256" height="256" ')}</body></html>`));
  await new Promise((r) => setTimeout(r, 300));
  const full = await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  const base = full.resize({ width: 256, height: 256, quality: "best" });
  writeFileSync(join(out, "icon.png"), base.toPNG());
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  writeFileSync(join(out, "icon.ico"), ico(sizes.map((size) => ({ size, buf: base.resize({ width: size, height: size, quality: "best" }).toPNG() }))));
  console.log("icon written to", out);
  app.quit();
});
