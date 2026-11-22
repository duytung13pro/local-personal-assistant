import { test } from "node:test";
import assert from "node:assert/strict";
import { importedBody, noteTitle, numberMath, renderNote } from "../src/shared/markdown";

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

test("inline and display math render with KaTeX", () => {
  const h = renderNote("Euler: $e^{i\\pi}+1=0$ and \\(a^2\\).\n\n$$\n\\int_0^1 x\\,dx = \\tfrac12\n$$\n\n\\[ \\sum_{n=1}^\\infty \\frac1{n^2} \\]");
  assert.equal(count(h, /class="katex"/g), 4);
  assert.equal(count(h, /class="katex-display"/g), 2);
  assert.ok(!h.includes("math-error"));
});

test("money, escaped dollars and code are not math", () => {
  const h = renderNote("It costs $5 and $10 today. Price \\$3. `$x$` stays code.\n\n```\n$$ not math $$\n```");
  assert.equal(count(h, /class="katex"/g), 0);
  assert.ok(h.includes("$5 and $10") && h.includes("$3") && h.includes("<code>$x$</code>") && h.includes("$$ not math $$"));
});

test("bare environments, note-wide numbering, labels and refs", () => {
  const src = [
    "See \\eqref{eq:b} below.",
    "",
    "\\begin{equation}",
    "a = b \\label{eq:a}",
    "\\end{equation}",
    "",
    "\\begin{align}",
    "x &= 1 \\label{eq:b} \\\\",
    "y &= 2 \\notag \\\\",
    "z &= \\begin{cases} 1 \\\\ 2 \\end{cases}",
    "\\end{align}",
    "",
    "Equation \\ref{eq:a} and $\\eqref{eq:b}$.",
  ].join("\n");
  const h = renderNote(src);
  assert.ok(!h.includes("math-error"), h);
  assert.ok(h.includes("See (2) below."));
  assert.ok(h.includes("Equation 1 and"));
  // tags (1), (2), (3): cases rows are not numbered, \notag row is skipped
  const tags = numberMath("\\begin{align}x \\\\ y \\notag \\\\ z = \\begin{cases}1\\\\2\\end{cases}\\end{align}", { labels: new Map(), count: 0, macros: {} });
  assert.equal(count(tags, /\\tag\{/g), 2);
});

test("macros carry over, errors show the source, raw HTML is escaped", () => {
  const h = renderNote("$\\newcommand{\\RR}{\\mathbb{R}}$ then $x\\in\\RR$\n\n$$\\frac{1}{$$\n\n<script>alert(1)</script>");
  assert.ok(h.includes("mathbb"), "macro defined in an earlier formula works");
  assert.equal(count(h, /class="math-error"/g), 1);
  assert.ok(h.includes("&lt;script&gt;") && !h.includes("<script>"));
});

test("tables, task lists, chemistry, title", () => {
  const h = renderNote("| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n$\\ce{H2O}$");
  assert.ok(h.includes("<table") && count(h, /type="checkbox"/g) === 2 && h.includes("checked"));
  assert.ok(!h.includes("math-error"));
  assert.equal(noteTitle("\n\n## Lecture 3: *Fourier*  \nbody"), "Lecture 3: Fourier");
  assert.equal(noteTitle("  \n"), "Untitled");
});

test("imported files: file name becomes the title, front matter is kept but not shown", () => {
  assert.equal(importedBody("﻿Some text\r\nmore", "Lecture 4.md"), "# Lecture 4\n\nSome text\nmore");
  assert.equal(importedBody("# Own title\nbody", "file.md"), "# Own title\nbody");
  const fm = "---\ntags: [math]\ntitle: x\n---\n\nBody $x$";
  const b = importedBody(fm, "Fourier.markdown");
  assert.equal(b, "---\ntags: [math]\ntitle: x\n---\n# Fourier\n\nBody $x$");
  assert.equal(noteTitle(b), "Fourier");
  const h = renderNote(b);
  assert.ok(!h.includes("tags") && !h.includes("<hr") && h.includes('data-line="4"'), h);
  assert.equal(noteTitle("---\ntitle: x\n---\nFirst line"), "First line");
});

test("store: notes save, pin, sort and come back with undo after delete", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { Store } = await import("../src/main/db");
  const dir = mkdtempSync(join(process.env.PA_TEST_TMP || tmpdir(), "pa-notes-"));
  const s = new Store(join(dir, "t.db"));
  try {
    const a = s.createNote("# Alpha\n$x$");
    const b = s.createNote("");
    assert.equal(b.title, "Untitled");
    const b2 = s.updateNote(b.id, { body: "## Beta notes" });
    assert.equal(b2.title, "Beta notes");
    s.updateNote(a.id, { pinned: true });
    assert.deepEqual(s.listNotes().map((n) => n.title), ["Alpha", "Beta notes"]); // pinned first
    s.deleteNote(a.id);
    assert.equal(s.listNotes().length, 1);
    assert.match(s.latestUndo()!.label, /Delete note "Alpha"/);
    s.undo();
    const back = s.getNote(a.id);
    assert.equal(back.body, "# Alpha\n$x$");
    assert.ok(back.pinned);
    assert.throws(() => s.updateNote(a.id, { body: "x".repeat(2_000_001) }), /too long/);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
