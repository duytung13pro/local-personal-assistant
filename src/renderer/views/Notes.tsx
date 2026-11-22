// Notes: Markdown + LaTeX notes with a CodeMirror editor and a live KaTeX preview. Everything stays local.
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { Bold, Code, Columns2, Eye, FileDown, FileUp,FileText, Heading, Italic, Link, List, ListChecks, NotebookPen, PanelRightClose, PanelRightOpen, PenLine,
  Pin, PinOff, Plus, Quote, Search, Sigma, Table, Trash2 } from "lucide-react";
import "katex/dist/katex.min.css";
import "katex/contrib/copy-tex"; // copying rendered math copies its LaTeX source
import "../note.css";
import type { Note } from "../../shared/types";
import { renderNote } from "../../shared/markdown";
import { fmtShort, today } from "../../shared/dates";
import { api, attempt, cx, toast, undoLast, useData, useToggle } from "../lib";
import { Button, IconButton, inputCls } from "../ui";
import { block, noteExtensions, prefix, topLine, wrap } from "../noteEditor";

type Mode = "write" | "split" | "read";
const SAVE_MS = 500;

const SAMPLE = String.raw`# Welcome to Notes

Write **Markdown** with LaTeX math. Inline: $e^{i\pi} + 1 = 0$, or \(a^2 + b^2 = c^2\).

Display math goes between double dollars:

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

Numbered environments count through the whole note, and you can refer to them:

\begin{align}
\nabla \cdot \mathbf{E} &= \frac{\rho}{\varepsilon_0} \label{eq:gauss} \\
\nabla \times \mathbf{B} &= \mu_0 \mathbf{J} + \mu_0 \varepsilon_0 \frac{\partial \mathbf{E}}{\partial t}
\end{align}

Gauss's law is \eqref{eq:gauss}.

Define your own commands once: $\newcommand{\RR}{\mathbb{R}}$ then use them, $f : \RR^n \to \RR$.

| Matrix | Determinant |
|---|---|
| $\begin{pmatrix} a & b \\ c & d \end{pmatrix}$ | $ad - bc$ |

- [x] Chemistry works too: $\ce{2H2 + O2 -> 2H2O}$
- [ ] Type \ in the editor for LaTeX completions (Tab jumps between the blanks)

Shortcuts: Ctrl+B bold · Ctrl+I italic · Ctrl+M inline math · Ctrl+Shift+M display math · Ctrl+F find.
`;

function when(isoTs: string): string {
  const d = isoTs.slice(0, 10);
  const local = new Date(isoTs);
  if (d === today()) return local.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return fmtShort(`${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`);
}
const snippet = (n: Note) => n.body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(1, 3).join(" ")
  .replace(/[#*_`>$\\]/g, "").slice(0, 90);

export function Notes() {
  const [notes] = useData(() => api.listNotes(), [], ["notes"]);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem("notes:mode") as Mode) || "split");
  useEffect(() => { try { localStorage.setItem("notes:mode", mode); } catch { /* storage off */ } }, [mode]);

  const [listOpen, toggleList] = useToggle("ui:notes-list");
  const list = notes ?? [];
  const current = list.find((n) => n.id === selected) ?? null;
  const showList = listOpen || !current; // with no note open, the list is the page
  useEffect(() => { // keep a valid selection: first note when nothing (or a deleted note) is selected
    if (notes && (!selected || !notes.some((n) => n.id === selected))) setSelected(notes[0]?.id ?? null);
  }, [notes, selected]);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return list.filter((n) => words.every((w) => n.body.toLowerCase().includes(w)));
  }, [list, query]);

  const create = async (body = "") => {
    let made: Note | undefined;
    if (await attempt(async () => { made = await api.createNote(body); })) { setSelected(made!.id); setQuery(""); }
  };
  const importFiles = async () => {
    let res: { ids: string[]; skipped: string[] } | undefined;
    if (!(await attempt(async () => { res = await api.importNotes(); })) || !res) return;
    const { ids, skipped } = res;
    if (ids.length) { setSelected(ids[ids.length - 1]); setQuery(""); }
    const done = ids.length ? `Imported ${ids.length} note${ids.length === 1 ? "" : "s"}.` : "";
    if (skipped.length) toast.error(`${done} Couldn't import ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? ` and ${skipped.length - 3} more` : ""}.`.trim());
    else if (ids.length > 1) toast.info(done);
  };

  return (
    <div className={cx("grid h-full", showList ? "grid-cols-[1fr_268px]" : "grid-cols-[1fr]")}>
      {current ? <NoteEditor key={current.id} note={current} mode={mode} setMode={setMode}
        listOpen={listOpen} toggleList={toggleList} onNew={() => void create()} />
        : !notes ? <div /> : (
          <div className="grid place-items-center">
            <div className="max-w-[360px] text-center">
              <NotebookPen size={28} className="mx-auto text-faint" />
              <h2 className="mt-3 text-[17px] font-semibold">Notes with real math</h2>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">Markdown plus LaTeX: $…$, $$…$$, align, matrices,
                numbered equations with \eqref, and \newcommand. Notes stay on this computer.</p>
              <div className="mt-4 flex justify-center gap-2">
                <Button variant="primary" icon={<Plus size={15} />} onClick={() => void create()}>New note</Button>
                <Button icon={<FileUp size={15} />} onClick={() => void importFiles()}>Import .md</Button>
                <Button onClick={() => void create(SAMPLE)}>Open a sample</Button>
              </div>
            </div>
          </div>
        )}

      <aside hidden={!showList} className="flex min-h-0 flex-col border-l border-line bg-[#fafaf8]">
        <header className="flex items-center gap-2 px-4 pt-4 pb-3">
          <h1 className="text-[22px] font-semibold">Notes</h1>
          <IconButton label="Import Markdown files" className="ml-auto" onClick={() => void importFiles()}><FileUp size={15} /></IconButton>
          <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => void create()}>New</Button>
        </header>
        <div className="relative px-3 pb-2">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-6 -translate-y-1/2 text-faint" />
          <input className={cx(inputCls, "h-8 pl-8 text-[13px]")} placeholder="Search notes" value={query}
            onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" role="listbox" aria-label="Notes">
          {notes && shown.length === 0 && (
            <p className="px-3 py-6 text-center text-[13px] text-faint">{list.length ? "No notes match." : "No notes yet."}</p>)}
          {shown.map((n) => (
            <button key={n.id} type="button" role="option" aria-selected={n.id === selected} onClick={() => setSelected(n.id)}
              className={cx("mb-0.5 flex w-full flex-col rounded-lg px-3 py-2 text-left transition-colors duration-100",
                n.id === selected ? "bg-panel shadow-[0_1px_2px_rgba(0,0,0,0.06),0_0_0_1px_rgba(0,0,0,0.04)]" : "hover:bg-hover")}>
              <span className="flex items-center gap-1.5">
                {n.pinned && <Pin size={11} className="shrink-0 text-accent-ink" aria-label="Pinned" />}
                <span className={cx("min-w-0 flex-1 truncate text-[13.5px]", n.id === selected && "font-semibold")}>{n.title}</span>
                <span className="shrink-0 text-[11.5px] text-faint">{when(n.updated)}</span>
              </span>
              {snippet(n) && <span className="mt-0.5 truncate text-[12px] text-muted">{snippet(n)}</span>}
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}

function NoteEditor({ note, mode, setMode, listOpen, toggleList, onNew }: {
  note: Note; mode: Mode; setMode: (m: Mode) => void; listOpen: boolean; toggleList: () => void; onNew: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [body, setBody] = useState(note.body);
  const [saving, setSaving] = useState<"saved" | "saving" | "error">("saved");
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const text = pending.current;
    if (text === null) return;
    pending.current = null;
    try {
      await api.updateNote(note.id, { body: text });
      if (pending.current === null) setSaving("saved");
    } catch (e) {
      pending.current ??= text;
      setSaving("error");
      toast.error(String((e as Error).message ?? e));
    }
  }, [note.id]);

  // One editor per note (the component is keyed by note id); save on a short pause and when leaving.
  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: note.body, extensions: noteExtensions((doc) => {
        setBody(doc);
        pending.current = doc;
        setSaving("saving");
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void flush(), SAVE_MS);
      }) }),
    });
    view.current = v;
    if (!note.body) v.focus();
    const onScroll = () => syncPreview(topLine(v));
    v.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    return () => { v.scrollDOM.removeEventListener("scroll", onScroll); void flush(); v.destroy(); view.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const save = () => void flush();
    window.addEventListener("beforeunload", save);
    return () => window.removeEventListener("beforeunload", save);
  }, [flush]);

  const shownBody = useDeferredValue(body);
  const html = useMemo(() => renderNote(shownBody), [shownBody]);

  /** Scroll the preview so the block for the editor's top line sits at its top. */
  const syncPreview = (line: number) => {
    const box = preview.current;
    if (!box || box.hidden) return;
    const els = [...box.querySelectorAll<HTMLElement>("[data-line]")];
    let best: HTMLElement | null = null;
    for (const el of els) { if (Number(el.dataset.line) <= line) best = el; else break; }
    box.scrollTop = best ? best.offsetTop - box.offsetTop - 12 : 0;
  };

  const act = (fn: (v: EditorView) => unknown) => () => { if (view.current) fn(view.current); };
  const togglePin = () => void attempt(() => api.updateNote(note.id, { pinned: !note.pinned }));
  const remove = async () => {
    await flush();
    if (await attempt(() => api.deleteNote(note.id))) toast.info(`Deleted "${note.title}".`, { label: "Undo", run: undoLast });
  };
  const exportAs = async (kind: "md" | "pdf") => {
    await flush();
    try {
      const path = await api.exportNote(note.id, kind);
      if (path) toast.info(`Saved ${path}`, { label: "Show", run: () => void api.openPath(path.replace(/[\\/][^\\/]+$/, "")).catch(() => undefined) });
    } catch (e) { toast.error(String((e as Error).message ?? e)); }
  };
  const onPreviewClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (/^(https?:|mailto:)/i.test(href)) void attempt(() => api.openLink(href));
  };

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-0.5 border-b border-line bg-panel px-3">
        <Tool label="Heading (toggle)" onClick={act((v) => prefix(v, "## "))}><Heading size={15} /></Tool>
        <Tool label="Bold (Ctrl+B)" onClick={act((v) => wrap(v, "**", "**", "bold"))}><Bold size={15} /></Tool>
        <Tool label="Italic (Ctrl+I)" onClick={act((v) => wrap(v, "*", "*", "italic"))}><Italic size={15} /></Tool>
        <Tool label="Link (Ctrl+K)" onClick={act((v) => wrap(v, "[", "](https://)", "link"))}><Link size={15} /></Tool>
        <Sep />
        <Tool label="Inline math (Ctrl+M)" onClick={act((v) => wrap(v, "$", "$", "x"))}><span className="font-serif text-[15px] italic">x</span></Tool>
        <Tool label="Display math (Ctrl+Shift+M)" onClick={act((v) => block(v, "$$\n", "\n$$", "x"))}><Sigma size={15} /></Tool>
        <Tool label="Numbered equations (align)" onClick={act((v) => block(v, "\\begin{align}\n", " \\\\\n\\end{align}", "a &= b"))}>
          <span className="text-[11.5px] font-semibold">(1)</span></Tool>
        <Sep />
        <Tool label="Bulleted list" onClick={act((v) => prefix(v, "- "))}><List size={15} /></Tool>
        <Tool label="Checklist" onClick={act((v) => prefix(v, "- [ ] "))}><ListChecks size={15} /></Tool>
        <Tool label="Quote" onClick={act((v) => prefix(v, "> "))}><Quote size={15} /></Tool>
        <Tool label="Code block" onClick={act((v) => block(v, "```\n", "\n```", "code"))}><Code size={15} /></Tool>
        <Tool label="Table" onClick={act((v) => block(v, "| ", " | B |\n|---|---|\n| 1 | 2 |", "A"))}><Table size={15} /></Tool>

        <span className={cx("ml-auto pr-2 text-[12px]", saving === "error" ? "text-danger" : "text-faint")} aria-live="polite">
          {saving === "saving" ? "Saving…" : saving === "error" ? "Not saved" : "Saved"}</span>
        <div role="radiogroup" aria-label="Layout" className="mr-1 inline-flex h-8 items-center rounded-lg border border-line-strong bg-[#f1f1ee] p-0.5">
          {([["write", "Write", <PenLine key="w" size={14} />], ["split", "Split", <Columns2 key="s" size={14} />], ["read", "Read", <Eye key="r" size={14} />]] as const)
            .map(([m, label, icon]) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} title={label} aria-label={label} onClick={() => setMode(m)}
                className={cx("inline-grid h-full w-8 place-items-center rounded-md transition-[background-color,color] duration-100",
                  mode === m ? "bg-panel text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-muted hover:text-ink")}>{icon}</button>
            ))}
        </div>
        <IconButton label={note.pinned ? "Unpin" : "Pin to top"} onClick={togglePin}>{note.pinned ? <PinOff size={15} /> : <Pin size={15} />}</IconButton>
        <IconButton label="Export as Markdown (.md)" onClick={() => void exportAs("md")}><FileText size={15} /></IconButton>
        <IconButton label="Export as PDF" onClick={() => void exportAs("pdf")}><FileDown size={15} /></IconButton>
        <IconButton label="Delete note" className="hover:text-danger" onClick={() => void remove()}><Trash2 size={15} /></IconButton>
        <Sep />
        {!listOpen && <IconButton label="New note" onClick={onNew}><Plus size={15} /></IconButton>}
        <IconButton label={listOpen ? "Hide notes list" : "Show notes list"} onClick={toggleList}>
          {listOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}</IconButton>
      </div>

      <div className={cx("grid min-h-0 flex-1", mode === "split" ? "grid-cols-2" : "grid-cols-1")}>
        <div ref={host} hidden={mode === "read"} className={cx("min-h-0 overflow-hidden bg-panel", mode === "split" && "border-r border-line")} />
        <div ref={preview} hidden={mode === "write"} onClick={onPreviewClick} data-selectable
          className="relative min-h-0 overflow-y-auto bg-bg px-8 pt-6 pb-[30vh]">
          {shownBody.trim() ? <article className="note-prose" dangerouslySetInnerHTML={{ __html: html }} />
            : <p className="note-prose text-faint">Nothing to preview yet.</p>}
        </div>
      </div>
    </div>
  );
}

function Tool({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return <IconButton label={label} className="size-8" onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{children}</IconButton>;
}
const Sep = () => <span className="mx-1 h-5 w-px bg-line" aria-hidden />;
