// Chat with the head chef (local Qwen 30B), which routes each message to the model that fits it best.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUp, ChefHat, FolderOpen, Loader2, Lock, RotateCcw, Square, X } from "lucide-react";
import type { ChatMessage, Project, Step, WorkerId } from "../../shared/types";
import { CHAT_ROUTABLE, WORKERS, isCloud } from "../../shared/workers";
import { api, attempt, cx, toast, useData } from "../lib";
import { AGENT_LABEL, AgentBadge, Button, Dialog } from "../ui";

const ACTIVE = new Set(["thinking", "waiting", "working"]);
const MODE_LABEL = { self: "answered itself", planner: "used your planner (local)", single: "handed it to", split: "split the work" };

export function ChatTab({ project, onShowFiles }: { project: Project; onShowFiles: () => void }) {
  const [messages] = useData(() => api.listChat(project.id), [project.id], ["chat", "steps"]);
  const [steps] = useData(() => api.listSteps(project.id), [project.id], ["steps", "chat"]);
  const [usage] = useData(() => api.chatUsage(), [], ["chat", "steps", "jobs"]);
  const [live, setLive] = useState<Record<string, string>>({});
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [confirm, setConfirm] = useState<{ step: Step; text: string } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const atBottom = useRef(true);

  useEffect(() => api.onChatDelta((id, t) => setLive((m) => ({ ...m, [id]: t }))), []);
  const byMsg = useMemo(() => {
    const m = new Map<string, Step[]>();
    for (const s of steps ?? []) if (s.chatMsg) m.set(s.chatMsg, [...(m.get(s.chatMsg) ?? []), s]);
    return m;
  }, [steps]);
  const msgs = messages ?? [];
  const active = [...msgs].reverse().find((m) => m.role === "assistant" && ACTIVE.has(m.status));

  // Follow new output only when the user is already at the bottom (don't yank them while reading).
  useLayoutEffect(() => {
    const el = list.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [msgs.length, live, steps]);
  // The chat may first render while its view is hidden (zero height); jump to the latest message once it shows.
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (atBottom.current) el.scrollTop = el.scrollHeight; });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      await api.sendChat(project.id, t);
      setText("");
      atBottom.current = true;
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
      input.current?.focus();
    }
  };
  const review = async (s: Step) => {
    try { setConfirm({ step: s, text: await api.previewStep(s.id) }); } catch (e) { toast.error((e as Error).message); }
  };
  const cloudToday = Object.entries(usage?.today ?? {}).filter(([, n]) => n > 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-5 py-2 text-[12.5px] text-muted">
        <ChefHat size={15} className="text-accent-ink" />
        <span>Head chef: <b className="font-medium text-ink">Qwen</b> (local) routes each message</span>
        <span className="ml-auto">Cloud calls today:</span>
        {cloudToday.length === 0 ? <span className="text-faint">none</span> : cloudToday.map(([w, n]) => (
          <span key={w} className="rounded-full bg-[#f0f0ed] px-2 py-0.5 font-medium text-ink">{AGENT_LABEL[w as WorkerId] ?? w} {n}</span>
        ))}
      </div>

      <div ref={list} onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
        className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto flex max-w-[820px] flex-col gap-4">
          {msgs.length === 0 && <Welcome onPick={(t) => { setText(t); input.current?.focus(); }} />}
          {msgs.map((m) => m.role === "user"
            ? <UserBubble key={m.id} m={m} />
            : <Ticket key={m.id} m={m} steps={byMsg.get(m.id) ?? []} live={live[m.id]} onReview={review} onShowFiles={onShowFiles} />)}
        </div>
      </div>

      <div className="border-t border-line px-5 pt-3 pb-4">
        <div className="mx-auto max-w-[820px]">
          <div className="flex flex-wrap gap-1.5 pb-2">
            {CHAT_ROUTABLE.map((w) => (
              <button key={w} type="button" onClick={() => { setText((t) => `@${WORKERS[w].mention} ${t.replace(/^@[a-z-]+\s*/i, "")}`); input.current?.focus(); }}
                className="rounded-full border border-line px-2 py-0.5 text-[11.5px] text-muted transition-colors duration-100 hover:border-line-strong hover:text-ink">
                @{WORKERS[w].mention}</button>
            ))}
          </div>
          <div className="flex items-end gap-2 rounded-2xl border border-line-strong bg-panel p-2 transition-[border-color,box-shadow] duration-100 focus-within:border-accent-ink focus-within:shadow-[0_0_0_3px_rgba(245,134,42,0.15)]">
            <textarea ref={input} value={text} rows={1} maxLength={12000} placeholder="Ask the team… (Ctrl+Enter to send · @codex, @claude… to pick a model)"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); void send(); } }}
              onInput={(e) => { const el = e.currentTarget; el.style.height = "auto"; el.style.height = `${Math.min(220, el.scrollHeight)}px`; }}
              className="max-h-[220px] min-h-[36px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[14px] leading-relaxed outline-none placeholder:text-faint" />
            {active ? (
              <Button variant="secondary" icon={<Square size={13} />} onClick={() => attempt(() => api.stopChat(active.id))}>Stop</Button>
            ) : (
              <button type="button" aria-label="Send" disabled={!text.trim() || sending} onClick={() => void send()}
                className="grid size-9 place-items-center rounded-xl bg-accent text-[#2a1606] transition-[background-color,transform,opacity] duration-100 hover:bg-accent-hover active:scale-[0.94] disabled:opacity-40">
                {sending ? <Loader2 size={16} className="animate-spin" /> : <ArrowUp size={17} />}
              </button>
            )}
          </div>
        </div>
      </div>

      <Dialog open={!!confirm} onClose={() => setConfirm(null)} width={720}
        title={confirm ? `Send to ${WORKERS[confirm.step.agent].name}?` : ""}
        footer={<>
          <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
          <Button variant="danger" onClick={async () => { const s = confirm!.step; setConfirm(null); await attempt(() => api.declineStep(s.id)); }}>Decline</Button>
          <Button variant="primary" data-autofocus onClick={async () => { const s = confirm!.step; setConfirm(null); await attempt(() => api.runStep(s.id)); }}>Send</Button>
        </>}>
        <p className="pb-2 text-[13px] text-muted">
          {confirm && (WORKERS[confirm.step.agent].writes ? "It may create and edit files in this project's folder (nothing outside it). " : "It only answers; no file access. ")}
          This uses your {confirm && (confirm.step.agent === "chatgpt" || confirm.step.agent === "codex" ? "ChatGPT" : "Claude")} plan. Your planner data is never included.</p>
        <pre data-selectable className="max-h-[52vh] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-[#fafaf8] p-3 font-mono text-[12px] leading-relaxed">{confirm?.text}</pre>
      </Dialog>
    </div>
  );
}

function Welcome({ onPick }: { onPick: (t: string) => void }) {
  const ideas = ["What's on my plate this week?", "Add a task to call the bank on Friday, high priority",
    "Build a small HTML page that converts USD to VND", "@chatgpt Compare SQLite and Postgres for a personal app"];
  return (
    <div className="py-10 text-center">
      <ChefHat size={28} className="mx-auto text-accent-ink" />
      <h3 className="mt-2 text-[17px] font-semibold">Ask your kitchen</h3>
      <p className="mx-auto mt-1 max-w-[520px] text-[13px] leading-relaxed text-muted">Qwen reads your message and decides who cooks: it answers small things
        itself, manages your planner locally, and sends bigger jobs to Qwen Coder, GPT-OSS, ChatGPT, Codex or Claude, splitting them so models work at the same time.
        Cloud models always ask first.</p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {ideas.map((t) => <button key={t} type="button" onClick={() => onPick(t)}
          className="rounded-xl border border-line bg-panel px-3 py-2 text-left text-[13px] transition-colors duration-100 hover:border-line-strong">{t}</button>)}
      </div>
    </div>
  );
}

function UserBubble({ m }: { m: ChatMessage }) {
  return (
    <div className="flex justify-end">
      <div data-selectable className="max-w-[78%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent-soft px-3.5 py-2 text-[14px] leading-relaxed">{m.content}</div>
    </div>
  );
}

const DOT: Record<Step["status"], string> = {
  todo: "bg-line-strong", queued: "bg-[#c9c9c3] animate-pulse", running: "bg-accent animate-pulse", done: "bg-ok", failed: "bg-danger",
};
const STEP_STATUS: Record<Step["status"], string> = { todo: "needs your OK", queued: "waiting", running: "working…", done: "done", failed: "failed" };

function Ticket({ m, steps, live, onReview, onShowFiles }: {
  m: ChatMessage; steps: Step[]; live?: string; onReview: (s: Step) => void; onShowFiles: () => void;
}) {
  const [rerun, setRerun] = useState(false);
  const text = ACTIVE.has(m.status) && live !== undefined ? live : m.content;
  const wrote = steps.some((s) => WORKERS[s.agent].writes && s.status === "done");
  const header: ReactNode = m.status === "thinking" ? "Head chef is reading your message…"
    : m.mode === "single" && steps[0] ? <>Head chef {MODE_LABEL.single} <AgentBadge agent={steps[0].agent} /></>
    : m.mode ? `Head chef ${MODE_LABEL[m.mode]}` : "Head chef";
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-xl border border-line bg-panel">
        <div className="flex items-center gap-2 px-3.5 py-2 text-[12.5px] text-muted">
          {m.status === "thinking" ? <Loader2 size={13} className="animate-spin text-accent-ink" /> : <ChefHat size={14} className="text-accent-ink" />}
          <span className="flex items-center gap-1.5">{header}</span>
          {m.private && <span className="ml-auto inline-flex items-center gap-1 text-faint"><Lock size={11} /> stays on this PC</span>}
        </div>
        {m.reason && m.status !== "thinking" && <p className="px-3.5 pb-2 text-[12.5px] italic text-muted">“{m.reason}”</p>}
        {steps.length > 0 && (m.mode === "split" || steps.some((s) => s.status === "todo")) && (
          <div className="border-t border-line">
            {steps.map((s) => (
              <div key={s.id} className="flex items-center gap-2.5 px-3.5 py-2 text-[13px] [&+&]:border-t [&+&]:border-line">
                <span className={cx("size-2 shrink-0 rounded-full", DOT[s.status])} />
                <AgentBadge agent={s.agent} />
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                {s.status === "todo" && isCloud(s.agent) && m.status !== "stopped" ? (<>
                  <Button size="sm" variant="primary" onClick={() => onReview(s)}>Review & send</Button>
                  <button type="button" aria-label="Decline" title="Decline" onClick={() => attempt(() => api.declineStep(s.id))}
                    className="grid size-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-ink"><X size={14} /></button>
                </>) : <span className={cx("text-[12px]", s.status === "failed" ? "text-danger" : "text-muted")}>
                  {s.status === "todo" && !isCloud(s.agent) ? "not started" : STEP_STATUS[s.status]}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {(text || m.status === "working") && (
        <div className="pl-1">
          {m.author !== "chef" && m.mode !== "split" && WORKERS[m.author as WorkerId] && (
            <div className="pb-1 text-[12px] font-medium text-muted">{WORKERS[m.author as WorkerId].name}</div>
          )}
          <div data-selectable className={cx("text-[14px] leading-relaxed", m.status === "failed" && "text-danger")}><Rich text={text} /></div>
          {m.status === "working" && !text && <span className="inline-flex items-center gap-1.5 text-[13px] text-muted"><Loader2 size={13} className="animate-spin" /> working…</span>}
        </div>
      )}
      {m.status === "stopped" && <p className="pl-1 text-[12.5px] text-faint">Stopped.</p>}

      {!ACTIVE.has(m.status) && m.mode !== "planner" && m.replyTo && (
        <div className="flex items-center gap-1 pl-0.5">
          <div className="relative">
            <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={() => setRerun((v) => !v)}>Try with…</Button>
            {rerun && (
              <div className="absolute bottom-full left-0 z-10 mb-1 w-44 overflow-hidden rounded-xl border border-line bg-panel py-1 shadow-[0_12px_30px_-10px_rgba(0,0,0,0.3)]">
                {CHAT_ROUTABLE.map((w) => (
                  <button key={w} type="button" className="flex w-full items-center justify-between px-3 py-1.5 text-left text-[13px] hover:bg-hover"
                    onClick={() => { setRerun(false); void attempt(() => api.rerunChat(m.id, w)); }}>
                    {WORKERS[w].name}<span className="text-[11px] text-faint">{isCloud(w) ? "cloud" : "local"}</span></button>
                ))}
              </div>
            )}
          </div>
          {wrote && <Button size="sm" variant="ghost" icon={<FolderOpen size={13} />} onClick={onShowFiles}>Show files</Button>}
        </div>
      )}
    </div>
  );
}

/** Minimal Markdown: fenced code blocks, inline code, **bold**, headings and bullet lines. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/```[a-zA-Z0-9-]*\n?/);
  return <>{parts.map((p, i) => i % 2 === 1
    ? <pre key={i} className="my-2 overflow-x-auto rounded-lg border border-line bg-[#fafaf8] p-3 font-mono text-[12.5px]">{p.replace(/\n$/, "")}</pre>
    : <div key={i} className="whitespace-pre-wrap">{p.split("\n").map((line, j) => <Line key={j} line={line} />)}</div>)}</>;
}

function Line({ line }: { line: string }) {
  const h = /^(#{1,3})\s+(.*)$/.exec(line);
  if (h) return <div className="mt-2 mb-1 font-semibold">{inline(h[2])}</div>;
  const b = /^\s*[-*]\s+(.*)$/.exec(line);
  if (b) return <div className="flex gap-2 pl-1"><span className="text-faint">•</span><span>{inline(b[1])}</span></div>;
  return <div className={line.trim() ? "" : "h-2"}>{inline(line)}</div>;
}

function inline(s: string): ReactNode[] {
  return s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((t, i) =>
    t.startsWith("`") && t.endsWith("`") && t.length > 1 ? <code key={i} className="rounded bg-[#f0f0ed] px-1 font-mono text-[12.5px]">{t.slice(1, -1)}</code>
      : t.startsWith("**") && t.endsWith("**") && t.length > 4 ? <b key={i} className="font-semibold">{t.slice(2, -2)}</b> : t);
}
