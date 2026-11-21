import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Activity as ActivityIcon, Bot, CalendarDays, ChevronLeft, ChevronRight, LayoutGrid, ListChecks, NotebookPen, PanelLeftClose, PanelLeftOpen, PlugZap, Undo2, X } from "lucide-react";
import { MONTHS, monthGrid, shiftMonth, today as todayIso } from "../shared/dates";
import { api, cx, dismiss, undoLast, useData, useToasts, useToggle } from "./lib";
import { IconButton } from "./ui";
import { EventEditor, TaskEditor, type EventDraft, type TaskDraft } from "./editors";
import { Planner } from "./views/Planner";
import { CalendarView } from "./views/Calendar";
import { Checklist } from "./views/Checklist";
import { Notes } from "./views/Notes";
import { AIWorkspace } from "./views/AIWorkspace";
import { ActivityView } from "./views/Activity";
import { Connections } from "./views/Connections";

export type View = "planner" | "calendar" | "checklist" | "notes" | "ai" | "activity" | "connections";

const NAV: { group: string; items: { id: View; label: string; icon: ReactNode }[] }[] = [
  { group: "Planning", items: [
    { id: "planner", label: "Planner", icon: <LayoutGrid size={16} /> },
    { id: "calendar", label: "Calendar", icon: <CalendarDays size={16} /> },
    { id: "checklist", label: "Checklist", icon: <ListChecks size={16} /> },
    { id: "notes", label: "Notes", icon: <NotebookPen size={16} /> },
  ] },
  { group: "Assistant", items: [
    { id: "ai", label: "AI Workspace", icon: <Bot size={16} /> },
    { id: "activity", label: "Activity", icon: <ActivityIcon size={16} /> },
    { id: "connections", label: "Connections", icon: <PlugZap size={16} /> },
  ] },
];

/** Shared state the views use to open editors and jump around. */
export interface Ctx {
  today: string;
  focusDate: string;
  setFocusDate: (d: string) => void;
  editTask: (d: TaskDraft) => void;
  editEvent: (d: EventDraft) => void;
  go: (v: View) => void;
  searchSignal: number;
}

export default function App() {
  const [view, setView] = useState<View>("planner");
  const [today, setToday] = useState(todayIso());
  const [focusDate, setFocusDate] = useState(today);
  const [taskDraft, setTaskDraft] = useState<TaskDraft>(null);
  const [eventDraft, setEventDraft] = useState<EventDraft>(null);
  const [searchSignal, setSearchSignal] = useState(0);
  const [sidebar, toggleSidebar] = useToggle("ui:sidebar");
  const [undo] = useData(() => api.latestUndo(), [], ["tasks", "events", "all"]);

  useEffect(() => { // day rollover while the app stays open
    const t = setInterval(() => setToday((cur) => (todayIso() !== cur ? todayIso() : cur)), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { window.__pa = { show: (v) => setView(v as View) }; }, []);

  const go = useCallback((v: View) => setView(v), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest("input,textarea,select,[contenteditable]");
      if (!e.ctrlKey || e.altKey || e.defaultPrevented) return; // the notes editor handles its own Ctrl+F, Ctrl+Z…
      const k = e.key.toLowerCase();
      if (k === "\\") { e.preventDefault(); toggleSidebar(); }
      else if (k === "n") { e.preventDefault(); setTaskDraft({ due: view === "planner" || view === "calendar" ? focusDate : "" }); }
      else if (k === "f" && (e.target as HTMLElement).closest(".cm-editor")) return; // find inside the note
      else if (k === "f") { e.preventDefault(); setView("checklist"); setSearchSignal((n) => n + 1); }
      else if (k === "z" && !typing && !document.querySelector("[role=dialog]")) { e.preventDefault(); void undoLast(); }
      else if (/^[1-7]$/.test(k)) { e.preventDefault(); setView(NAV.flatMap((g) => g.items)[Number(k) - 1].id); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, focusDate, toggleSidebar]);

  const ctx: Ctx = { today, focusDate, setFocusDate, editTask: setTaskDraft, editEvent: setEventDraft, go, searchSignal };

  return (
    <div className={cx("grid h-full grid-rows-[1fr_auto]", sidebar ? "grid-cols-[232px_1fr]" : "grid-cols-[1fr]")}>
      <aside hidden={!sidebar} className="row-span-1 flex flex-col gap-1 border-r border-line bg-sidebar px-3 pt-4 pb-3 overflow-y-auto">
        <div className="px-2 pb-3 text-[15px] font-semibold tracking-[-0.01em]">Personal Assistant</div>
        <MiniMonth today={today} selected={focusDate} onPick={(d) => { setFocusDate(d); if (view !== "calendar") setView("planner"); }} />
        <nav className="mt-3 flex flex-col">
          {NAV.map((g) => (
            <div key={g.group} className="mt-3 first:mt-0">
              <div className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-faint">{g.group}</div>
              {g.items.map((it) => (
                <button key={it.id} type="button" onClick={() => setView(it.id)} aria-current={view === it.id ? "page" : undefined}
                  className={cx("group flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[14px]",
                    "transition-[background-color,color] duration-100",
                    view === it.id ? "bg-panel text-ink font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.06),0_0_0_1px_rgba(0,0,0,0.04)]"
                      : "text-[#3a3a37] hover:bg-hover")}>
                  <span className={cx(view === it.id ? "text-accent-ink" : "text-muted group-hover:text-ink")}>{it.icon}</span>
                  {it.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <p className="mt-auto px-2.5 pt-4 text-[11.5px] leading-snug text-faint">Tasks and calendar stay local.<br />Ctrl+1–7 switch views.</p>
      </aside>

      {/* Views stay mounted (hidden when inactive) so switching is instant and keeps scroll, drafts and search. */}
      <main className="relative min-w-0 overflow-hidden">
        <Pane on={view === "planner"}><Planner ctx={ctx} /></Pane>
        <Pane on={view === "calendar"}><CalendarView ctx={ctx} /></Pane>
        <Pane on={view === "checklist"}><Checklist ctx={ctx} /></Pane>
        <Pane on={view === "notes"}><Notes /></Pane>
        <Pane on={view === "ai"}><AIWorkspace /></Pane>
        <Pane on={view === "activity"}><ActivityView active={view === "activity"} /></Pane>
        <Pane on={view === "connections"}><Connections active={view === "connections"} /></Pane>
      </main>

      <footer className="col-span-2 flex h-9 items-center gap-3 border-t border-line bg-sidebar px-3 text-[12.5px] text-muted">
        <IconButton label={sidebar ? "Hide sidebar (Ctrl+\)" : "Show sidebar (Ctrl+\)"} className="size-7" onClick={toggleSidebar}>
          {sidebar ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}</IconButton>
        <button type="button" onClick={() => void undoLast()} disabled={!undo}
          className="inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-ink hover:bg-hover disabled:text-faint disabled:hover:bg-transparent active:scale-[0.97] transition-transform duration-100">
          <Undo2 size={13} /> {undo ? `Undo: ${undo.label}` : "Undo"}
        </button>
        <span className="ml-auto">Ctrl+N new task · Ctrl+F search · Ctrl+Z undo</span>
      </footer>

      <TaskEditor draft={taskDraft} onClose={() => setTaskDraft(null)} />
      <EventEditor draft={eventDraft} onClose={() => setEventDraft(null)} />
      <Toasts />
    </div>
  );
}

function Pane({ on, children }: { on: boolean; children: ReactNode }) {
  return <section hidden={!on} className="absolute inset-0 overflow-hidden">{children}</section>;
}

function MiniMonth({ today, selected, onPick }: { today: string; selected: string; onPick: (d: string) => void }) {
  const [ym, setYm] = useState<[number, number]>(() => [Number(selected.slice(0, 4)), Number(selected.slice(5, 7)) - 1]);
  useEffect(() => setYm([Number(selected.slice(0, 4)), Number(selected.slice(5, 7)) - 1]), [selected]);
  const days = monthGrid(ym[0], ym[1]);
  return (
    <div className="px-1">
      <div className="flex items-center justify-between pb-1">
        <IconButton label="Previous month" className="size-7" onClick={() => setYm(shiftMonth(ym[0], ym[1], -1))}><ChevronLeft size={15} /></IconButton>
        <span className="text-[13px] font-semibold">{MONTHS[ym[1]].slice(0, 3)} {ym[0]}</span>
        <IconButton label="Next month" className="size-7" onClick={() => setYm(shiftMonth(ym[0], ym[1], 1))}><ChevronRight size={15} /></IconButton>
      </div>
      <div className="grid grid-cols-7 text-center text-[11px] text-faint">{"SMTWTFS".split("").map((d, i) => <span key={i} className="py-1">{d}</span>)}</div>
      <div className="grid grid-cols-7 gap-y-0.5 text-center text-[12px]">
        {days.map((d) => {
          const inMonth = Number(d.slice(5, 7)) - 1 === ym[1];
          return (
            <button key={d} type="button" onClick={() => onPick(d)} aria-label={d}
              className={cx("mx-auto grid size-7 place-items-center rounded-full transition-colors duration-100",
                d === today ? "bg-accent font-semibold text-[#2a1606]" : d === selected ? "bg-accent-soft font-semibold text-accent-ink" : "hover:bg-hover",
                !inMonth && d !== today && "text-faint")}>
              {Number(d.slice(8))}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Toasts() {
  const list = useToasts();
  return (
    <div className="pointer-events-none fixed bottom-12 right-4 z-50 flex flex-col items-end gap-2">
      <AnimatePresence initial={false}>
        {list.map((t) => (
          <motion.div key={t.id} layout initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.12 } }} transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
            className={cx("pointer-events-auto flex max-w-[420px] items-center gap-3 rounded-xl px-3.5 py-2.5 text-[13px] shadow-[0_10px_30px_-10px_rgba(0,0,0,0.35)]",
              t.kind === "error" ? "bg-[#3b1210] text-[#ffe4e1]" : "bg-[#1f1f1d] text-[#f4f4f2]")}>
            <span className="min-w-0 flex-1">{t.text}</span>
            {t.action && <button type="button" className="font-semibold text-[#ffb27a] hover:text-[#ffc89f]"
              onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>}
            <button type="button" aria-label="Dismiss" className="text-[#a3a39d] hover:text-white" onClick={() => dismiss(t.id)}><X size={14} /></button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
