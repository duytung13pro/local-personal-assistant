import { useEffect, useMemo, useState } from "react";
import { ClipboardCheck, FolderOpen, Loader2, PanelRightClose, PanelRightOpen, Pencil, Play, Plus, Sparkles, Square, Trash2 } from "lucide-react";
import type { Project, Step, WorkerId } from "../../shared/types";
import { waves } from "../../main/orchestrator";
import { ChatTab } from "./Chat";
import { isCloud } from "../../shared/workers";
import { api, attempt, cx, toast, useData, useToggle } from "../lib";
import { AGENT_LABEL, AgentBadge, Button, Dialog, Empty, Field, IconButton, inputCls, textareaCls } from "../ui";

type Tab = "chat" | "brief" | "team" | "files";

export function AIWorkspace() {
  const [projects] = useData(() => api.listProjects(), [], ["projects"]);
  const [pid, setPid] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null); // a just-created project opens on its Brief
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  useEffect(() => { if (!pid && projects?.length) setPid(projects[0].id); }, [projects, pid]);
  const project = projects?.find((p) => p.id === pid) ?? null;
  const [listOpen, toggleList] = useToggle("ui:projects-list");
  const showList = listOpen || !project; // with no project open, the list is the page

  const create = async () => {
    try {
      const p = await api.createProject(newTitle);
      setFresh(p.id);
      setPid(p.id);
      setCreating(false);
      setNewTitle("");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="flex h-full gap-5 px-5 pt-4 pb-4">
      <div className="min-w-0 flex-1">
        {project ? <ProjectPane key={project.id} project={project} startOn={fresh === project.id ? "brief" : "chat"}
          onDeleted={() => setPid(null)} listOpen={listOpen} toggleList={toggleList} /> :
          <div className="grid h-full place-items-center text-[14px] text-faint">Create a project to start.</div>}
      </div>
      <aside hidden={!showList} className="flex w-[240px] shrink-0 flex-col">
        <h1 className="pb-3 text-[22px] font-semibold">AI Workspace</h1>
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {(projects ?? []).length === 0 && <Empty>No projects yet.</Empty>}
          {(projects ?? []).map((p) => renaming === p.id ? (
            <RenameField key={p.id} project={p} onDone={() => setRenaming(null)} />
          ) : (
            <div key={p.id} className={cx("group flex items-center rounded-lg transition-colors duration-100",
              p.id === pid ? "bg-panel shadow-[0_1px_2px_rgba(0,0,0,0.06),0_0_0_1px_rgba(0,0,0,0.05)]" : "hover:bg-hover")}>
              <button type="button" onClick={() => setPid(p.id)} onDoubleClick={() => setRenaming(p.id)} title="Double-click to rename"
                className={cx("min-w-0 flex-1 truncate px-3 py-2 text-left text-[13.5px]", p.id === pid && "font-semibold")}>{p.title}</button>
              <button type="button" aria-label={`Rename ${p.title}`} title="Rename" onClick={() => setRenaming(p.id)}
                className={cx("mr-1 grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-ink",
                  p.id === pid ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}>
                <Pencil size={13} /></button>
            </div>
          ))}
        </div>
        <Button className="mt-3" icon={<Plus size={15} />} onClick={() => setCreating(true)}>New project</Button>
        <Dialog open={creating} onClose={() => setCreating(false)} title="New project" width={400}
          footer={<><Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" onClick={create}>Create</Button></>}>
          <Field label="Title" hint="Next you'll describe it in the Brief, so every model knows what it's about.">
            <input className={inputCls} value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void create(); }} placeholder="e.g. Budget tracker" /></Field>
        </Dialog>
      </aside>
    </div>
  );
}

function RenameField({ project, onDone }: { project: Project; onDone: () => void }) {
  const [title, setTitle] = useState(project.title);
  const save = async () => {
    if (title.trim() && title.trim() !== project.title) await attempt(() => api.updateProject(project.id, { title }));
    onDone();
  };
  return (
    <input autoFocus className={cx(inputCls, "h-[34px]")} value={title} maxLength={120} aria-label="Project name"
      onChange={(e) => setTitle(e.target.value)} onBlur={() => void save()}
      onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") onDone(); }} />
  );
}

function ProjectPane({ project, startOn, onDeleted, listOpen, toggleList }: {
  project: Project; startOn: Tab; onDeleted: () => void; listOpen: boolean; toggleList: () => void;
}) {
  const [tab, setTab] = useState<Tab>(startOn);
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex items-end gap-1 border-b border-line px-4 pt-2">
        {([["chat", "Chat"], ["brief", "Brief"], ["team", "Team plan"], ["files", "Files"]] as [Tab, string][]).map(([t, label]) => (
          <button key={t} type="button" onClick={() => setTab(t)} aria-selected={tab === t} role="tab"
            className={cx("relative h-10 px-3 text-[13.5px] transition-colors duration-100", tab === t ? "font-semibold text-ink" : "text-muted hover:text-ink")}>
            {label}
            <span className={cx("absolute inset-x-2 -bottom-px h-[2px] rounded-full", tab === t ? "bg-accent" : "bg-transparent")} />
          </button>
        ))}
        {tab !== "brief" && (
          <Button size="sm" variant="ghost" className="mb-1.5 ml-auto" icon={<Pencil size={13} />} onClick={() => setTab("brief")}>
            Edit project</Button>
        )}
        <IconButton label={listOpen ? "Hide projects list" : "Show projects list"} className={cx("mb-1 size-8", tab === "brief" && "ml-auto")}
          onClick={toggleList}>{listOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}</IconButton>
      </div>
      {tab === "chat" && <div className="min-h-0 flex-1"><ChatTab project={project} onShowFiles={() => setTab("files")}
        onEditBrief={() => setTab("brief")} /></div>}
      <div className="min-h-0 flex-1 overflow-y-auto p-5" hidden={tab === "chat"}>
        <div hidden={tab !== "brief"}><BriefTab project={project} onDeleted={onDeleted} onPlan={() => setTab("team")} /></div>
        <div hidden={tab !== "team"}><TeamTab project={project} /></div>
        {tab === "files" && <FilesTab project={project} />}
      </div>
    </div>
  );
}

function BriefTab({ project, onDeleted, onPlan }: { project: Project; onDeleted: () => void; onPlan: () => void }) {
  const [title, setTitle] = useState(project.title);
  const [brief, setBrief] = useState(project.brief);
  const [notes, setNotes] = useState(project.notes);
  const dirty = title !== project.title || brief !== project.brief || notes !== project.notes;
  const save = () => attempt(() => api.updateProject(project.id, { title, brief, notes })).then((ok) => ok && toast.info("Project saved."));
  const remove = async () => {
    if (!confirm(`Delete project "${project.title}"? Its files on disk are kept.`)) return;
    if (await attempt(() => api.deleteProject(project.id))) onDeleted();
  };
  return (
    <div className="flex max-w-[860px] flex-col gap-4" onKeyDown={(e) => { if (e.ctrlKey && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); } }}>
      <div className="rounded-xl bg-[#fbfbfa] px-4 py-3 text-[13px] leading-relaxed text-muted">
        <b className="font-semibold text-ink">Project details.</b> Rename the project and describe what you want. Every model in
        Chat and Team plan reads this brief, so a clear one gets better results. Save, then use <b className="font-medium text-ink">Chat</b> for
        quick requests or <b className="font-medium text-ink">Team plan</b> to have ChatGPT plan the whole build.
      </div>
      <Field label="Project name"><input className={inputCls} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label="Brief — what should be built" hint={`${brief.length} / 12000`}>
        <textarea className={textareaCls} rows={9} maxLength={12000} value={brief} onChange={(e) => setBrief(e.target.value)}
          placeholder="Describe the goal, who it's for, what done looks like." />
      </Field>
      <Field label="Notes" hint="Constraints, preferences, links.">
        <textarea className={textareaCls} rows={4} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={!dirty} onClick={save}>Save  (Ctrl+S)</Button>
        <Button variant="ghost" disabled={!dirty} onClick={() => { setTitle(project.title); setBrief(project.brief); setNotes(project.notes); }}>Discard</Button>
        <Button className="ml-auto" icon={<Sparkles size={15} />} disabled={dirty || !brief.trim()} onClick={onPlan}>Go to team plan</Button>
        <Button variant="danger" icon={<Trash2 size={14} />} onClick={remove}>Delete</Button>
      </div>
      <p className="text-[12.5px] leading-relaxed text-muted">The brief and notes go to ChatGPT only when you press Plan or Review, after you have seen the exact text;
        local workers keep everything on this PC. Your calendar and checklist are never included.</p>
    </div>
  );
}

const ASSIGN_OPTIONS: WorkerId[] = ["qwen-coder", "qwen", "qwen-fast", "gpt-oss", "codex", "claude", "claude-chat"];

type Ask = { kind: "plan" | "review" | "claude"; title: string; text: string; go: () => Promise<unknown> };

function TeamTab({ project }: { project: Project }) {
  const [steps] = useData(() => api.listSteps(project.id), [project.id], ["steps"]);
  const [busy, setBusy] = useState<"" | "plan" | "review">("");
  const [ask, setAsk] = useState<Ask | null>(null);
  const list = steps ?? [];
  const work = list.filter((s) => s.agent !== "chatgpt");
  const runningCount = list.filter((s) => s.status === "running").length;
  const queuedCount = list.filter((s) => s.status === "queued").length;
  const open = work.filter((s) => s.status === "todo" || s.status === "failed");
  const level = useMemo(() => waves(work), [work]);
  const groups = useMemo(() => {
    const g = new Map<number, Step[]>();
    for (const s of work) g.set(level.get(s.id) ?? 0, [...(g.get(level.get(s.id) ?? 0) ?? []), s]);
    return [...g.entries()].sort((a, b) => a[0] - b[0]);
  }, [work, level]);
  const reviews = list.filter((s) => s.agent === "chatgpt" || s.title.startsWith("Review:"));
  const names = new Map(list.map((s) => [s.id, s.title]));

  const confirmCloud = async (kind: "plan" | "review") => {
    try {
      const text = kind === "plan" ? await api.previewPlan(project.id) : await api.previewReview(project.id);
      setAsk({ kind, title: kind === "plan" ? "Send the brief to ChatGPT for planning?" : "Send the results to ChatGPT for review?", text,
        go: async () => {
          setBusy(kind);
          try {
            const r = kind === "plan" ? await api.planSteps(project.id) : await api.reviewProject(project.id);
            toast.info(r.note);
          } finally {
            setBusy("");
          }
        } });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const runAll = () => {
    const cloud = open.filter((s) => isCloud(s.agent) && !s.chatMsg);
    const go = async () => { const n = await api.runAll(project.id); toast.info(`${n} task${n === 1 ? "" : "s"} queued. Independent tasks run at the same time.`); };
    if (!cloud.length) return void attempt(go);
    setAsk({ kind: "claude", title: "Some tasks go to Claude (cloud)", go,
      text: `These tasks will be sent to a cloud model (ChatGPT/Codex or Claude) with the brief and their inputs:\n\n${cloud.map((s) => `• ${s.title}`).join("\n")}\n\nEverything else runs locally.` });
  };
  const runOne = async (s: Step) => {
    if (!isCloud(s.agent)) return void attempt(() => api.runStep(s.id));
    try {
      const text = await api.previewStep(s.id);
      setAsk({ kind: "claude", title: `Send this task to ${AGENT_LABEL[s.agent]} (cloud)?`, text, go: () => api.runStep(s.id) });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="flex max-w-[1100px] flex-col gap-4">
      <div className="rounded-xl border border-line bg-[#fbfbfa] p-4">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-[280px] flex-1">
            <h3 className="text-[15px] font-semibold">ChatGPT plans · your local models build</h3>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">ChatGPT only plans and reviews. The work runs on this PC:
              <b className="font-semibold text-qwen"> Qwen Coder</b> edits files, <b className="font-semibold text-qwen">Qwen</b> writes and reasons,
              <b className="font-semibold text-[#2a5ea8]"> GPT-OSS</b> double-checks. Tasks that don't depend on each other run at the same time.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!!busy || runningCount > 0 || !project.brief.trim()} onClick={() => confirmCloud("plan")}
              icon={busy === "plan" ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}>
              {work.length ? "Re-plan" : "Plan with ChatGPT"}</Button>
            {queuedCount > 0 || runningCount > 0 ? (
              <Button variant="secondary" icon={<Square size={13} />} disabled={!queuedCount} onClick={() => attempt(() => api.stopQueue(project.id))}>
                Stop queue</Button>
            ) : (
              <Button variant="primary" icon={<Play size={14} />} disabled={!open.length || !!busy} onClick={runAll}>Run all</Button>
            )}
            <Button disabled={!!busy || runningCount + queuedCount > 0 || !work.some((s) => s.status === "done")}
              onClick={() => confirmCloud("review")}
              icon={busy === "review" ? <Loader2 size={15} className="animate-spin" /> : <ClipboardCheck size={15} />}>Review with ChatGPT</Button>
          </div>
        </div>
        {!project.brief.trim() && <p className="mt-2 text-[12.5px] text-warn">Write and save a brief first.</p>}
        {work.length > 0 && <TeamStrip steps={work} />}
      </div>

      {reviews.filter((r) => r.output).slice(-1).map((r) => (
        <div key={r.id} className={cx("rounded-xl border px-4 py-3", r.title.includes("satisfied") ? "border-[#bfe0c9] bg-[#f0f8f2]" : "border-[#f3c9a3] bg-accent-soft")}>
          <div className="flex items-center gap-2 text-[13.5px] font-semibold"><AgentBadge agent={r.agent} /> {r.title}</div>
          <p data-selectable className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed">{r.output}</p>
        </div>
      ))}

      {work.length === 0 && !busy && <Empty>No tasks yet. Write a brief, then press “Plan with ChatGPT”.</Empty>}
      {groups.map(([lvl, items]) => (
        <section key={lvl}>
          <h4 className="pb-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-faint">
            Wave {lvl + 1}{items.length > 1 ? ` · ${items.length} tasks run in parallel` : ""}</h4>
          <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(330px,1fr))]">
            {items.map((s) => <TaskCard key={s.id} step={s} after={s.deps.map((d) => names.get(d) ?? "?")} onRun={() => runOne(s)} />)}
          </div>
        </section>
      ))}

      <Dialog open={!!ask} onClose={() => setAsk(null)} width={720} title={ask?.title ?? ""}
        footer={<>
          <Button variant="ghost" onClick={() => setAsk(null)}>Cancel</Button>
          <Button variant="primary" data-autofocus icon={<Play size={14} />} onClick={async () => {
            const a = ask!;
            setAsk(null);
            await attempt(a.go);
          }}>Send</Button>
        </>}>
        <p className="pb-2 text-[13px] text-muted">{ask?.kind === "claude" ? "This uses your ChatGPT or Claude plan allowance." :
          "This exact text goes to ChatGPT through your signed-in Codex app and uses your ChatGPT plan. ChatGPT only reads; it changes nothing."}</p>
        <pre data-selectable className="max-h-[52vh] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-[#fafaf8] p-3 font-mono text-[12px] leading-relaxed">{ask?.text}</pre>
      </Dialog>
    </div>
  );
}

/** Live view of which workers are busy: makes "several models at once" visible. */
function TeamStrip({ steps }: { steps: Step[] }) {
  const ids = [...new Set(steps.map((s) => s.agent))];
  return (
    <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
      {ids.map((w) => {
        const mine = steps.filter((s) => s.agent === w);
        const run = mine.filter((s) => s.status === "running").length;
        const done = mine.filter((s) => s.status === "done").length;
        return (
          <span key={w} className={cx("inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[12.5px]",
            run ? "border-accent bg-panel" : "border-line bg-panel")}>
            <span className={cx("size-2 rounded-full", run ? "bg-accent animate-pulse" : done === mine.length ? "bg-ok" : "bg-line-strong")} />
            <span className="font-medium">{AGENT_LABEL[w]}</span>
            <span className="text-muted">{run ? "working" : `${done}/${mine.length} done`}</span>
          </span>
        );
      })}
    </div>
  );
}

const STATUS: Record<Step["status"], string> = { todo: "To do", queued: "Waiting", running: "Working…", done: "Done", failed: "Failed" };

function TaskCard({ step, after, onRun }: { step: Step; after: string[]; onRun: () => void }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState(step.prompt);
  useEffect(() => setPrompt(step.prompt), [step.prompt]);
  const active = step.status === "running" || step.status === "queued";
  return (
    <div className={cx("flex flex-col rounded-xl border bg-panel transition-[border-color,box-shadow] duration-150",
      step.status === "running" ? "border-accent shadow-[0_0_0_3px_rgba(245,134,42,0.12)]" : "border-line")}>
      <div className="flex items-start gap-2.5 px-3.5 pt-3">
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(!open)}>
          <span className="block text-[14px] font-medium leading-snug">{step.title}</span>
          {step.why && <span className="mt-0.5 block text-[12px] text-muted">{step.why}</span>}
          {after.length > 0 && <span className="mt-0.5 block truncate text-[11.5px] text-faint">After: {after.join(", ")}</span>}
        </button>
        <AgentBadge agent={step.agent} />
      </div>
      <div className="mt-auto flex items-center gap-2 px-3.5 pt-2.5 pb-3">
        <select aria-label="Worker" value={step.agent} disabled={active}
          onChange={(e) => void attempt(() => api.updateStep(step.id, { agent: e.target.value as WorkerId }))}
          className="h-7 rounded-md border border-line bg-panel px-1.5 text-[12.5px]">
          {ASSIGN_OPTIONS.map((a) => <option key={a} value={a}>{AGENT_LABEL[a]}</option>)}
        </select>
        <span className={cx("ml-auto text-[12.5px]", step.status === "done" ? "text-ok" : step.status === "failed" ? "text-danger" : "text-muted")}>
          {active && <Loader2 size={13} className={cx("mr-1 inline", step.status === "running" && "animate-spin")} />}{STATUS[step.status]}</span>
        <Button size="sm" variant={step.status === "done" ? "ghost" : "secondary"} disabled={active} icon={<Play size={13} />} onClick={onRun}>
          {step.status === "done" || step.status === "failed" ? "Again" : "Run"}</Button>
      </div>
      {open && (
        <div className="flex flex-col gap-3 border-t border-line px-3.5 py-3">
          <Field label="Instructions">
            <textarea className={textareaCls} rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)}
              onBlur={() => prompt !== step.prompt && void attempt(() => api.updateStep(step.id, { prompt }))} />
          </Field>
          {step.output && (
            <pre data-selectable className={cx("max-h-[320px] overflow-auto whitespace-pre-wrap rounded-lg border p-3 font-mono text-[12px] leading-relaxed",
              step.status === "failed" ? "border-[#efc3bf] bg-danger-soft text-danger" : "border-line bg-[#fafaf8]")}>{step.output}</pre>
          )}
          <div><Button size="sm" variant="ghost" icon={<Trash2 size={13} />} disabled={active}
            onClick={() => void attempt(() => api.deleteStep(step.id))}>Remove</Button></div>
        </div>
      )}
    </div>
  );
}

function FilesTab({ project }: { project: Project }) {
  const [files] = useData(() => api.listFiles(project.id), [project.id], ["steps"]);
  const [sel, setSel] = useState<string | null>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    if (sel) api.readFile(project.id, sel).then(setText, (e) => setText(String(e.message)));
  }, [sel, project.id]);
  return (
    <div className="flex h-[calc(100vh-190px)] gap-4">
      <div className="flex w-[260px] shrink-0 flex-col">
        <Button size="sm" icon={<FolderOpen size={14} />} className="mb-2 self-start"
          onClick={async () => attempt(async () => api.openPath(await api.projectFolder(project.id)))}>Open folder</Button>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-line">
          {(files ?? []).length === 0 && <p className="p-3 text-[13px] text-faint">No files yet. Claude writes here when it runs a step.</p>}
          {(files ?? []).map((f) => (
            <button key={f.path} type="button" onClick={() => setSel(f.path)}
              className={cx("block w-full truncate px-3 py-1.5 text-left font-mono text-[12px]", sel === f.path ? "bg-accent-soft text-accent-ink" : "hover:bg-[#f5f5f2]")}>
              {f.path}</button>
          ))}
        </div>
      </div>
      <pre data-selectable className="min-w-0 flex-1 overflow-auto whitespace-pre rounded-lg border border-line bg-[#fafaf8] p-3 font-mono text-[12px] leading-relaxed">
        {sel ? text : "Select a file to preview it (read-only; the app never runs generated code)."}</pre>
    </div>
  );
}
