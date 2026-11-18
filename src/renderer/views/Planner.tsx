import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import type { CalEvent, Task } from "../../shared/types";
import { WEEKDAYS, addDays, dayRange, fmtShort, layoutTimed, parse, rangeLabel } from "../../shared/dates";
import { api, attempt, cx, toast, undoLast, useData } from "../lib";
import { Button, Checkbox, Empty, IconButton } from "../ui";
import type { Ctx } from "../App";

const HOUR = 56; // px per hour in the schedule
const MIN_COL = 230;

export function Planner({ ctx }: { ctx: Ctx }) {
  const { today, focusDate, setFocusDate } = ctx;
  const [start, setStart] = useState(focusDate);
  const [count, setCount] = useState(3);
  const board = useRef<HTMLDivElement>(null);
  const days = useMemo(() => dayRange(start, count), [start, count]);

  // Follow dates picked elsewhere (mini month, calendar) without jumping when the day is already visible.
  useEffect(() => { if (!days.includes(focusDate)) setStart(focusDate); }, [focusDate]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = board.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setCount(Math.max(1, Math.min(3, Math.floor(e.contentRect.width / MIN_COL)))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [tasks] = useData(() => api.listTasks(), [], ["tasks"]);
  const [events] = useData(() => api.listEvents(focusDate, focusDate), [focusDate], ["events"]);
  const undated = (tasks ?? []).filter((t) => !t.done && !t.due).length;

  const step = (n: number) => { const s = addDays(start, n * count); setStart(s); setFocusDate(s); };

  return (
    <div className="flex h-full flex-col px-5 pt-4 pb-3">
      <header className="flex items-center gap-1.5 pb-3">
        <IconButton label="Previous days" onClick={() => step(-1)}><ChevronLeft size={18} /></IconButton>
        <IconButton label="Next days" onClick={() => step(1)}><ChevronRight size={18} /></IconButton>
        <Button size="sm" className="ml-1" onClick={() => { setStart(today); setFocusDate(today); }}>Today</Button>
        <h1 className="ml-3 text-[22px] font-semibold">{rangeLabel(days)}</h1>
        <Button variant="primary" className="ml-auto" icon={<Plus size={15} />} onClick={() => ctx.editTask({ due: focusDate })}>New task</Button>
      </header>
      <div className="flex min-h-0 flex-1 gap-4">
        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={board} className="grid min-h-0 flex-1 gap-3" style={{ gridTemplateColumns: `repeat(${count}, minmax(0,1fr))` }}>
            {days.map((d) => (
              <DayColumn key={d} day={d} today={today} selected={d === focusDate} onSelect={() => setFocusDate(d)}
                tasks={(tasks ?? []).filter((t) => t.due === d || (d === today && !t.done && !!t.due && t.due < today))}
                onEdit={(t) => ctx.editTask({ task: t })} />
            ))}
          </div>
          <div className="flex items-center justify-between pt-3 text-[12.5px] text-muted">
            <span>{undated ? `Backlog: ${undated} undated open task${undated === 1 ? "" : "s"}` : "Backlog is empty."}</span>
            <Button size="sm" variant="ghost" onClick={() => ctx.go("checklist")}>Open Checklist</Button>
          </div>
        </div>
        <Schedule day={focusDate} today={today} events={events ?? []} onNew={() => ctx.editEvent({ date: focusDate })}
          onOpen={(e) => ctx.editEvent({ event: e })} />
      </div>
    </div>
  );
}

function DayColumn({ day, today, selected, tasks, onSelect, onEdit }: {
  day: string; today: string; selected: boolean; tasks: Task[]; onSelect: () => void; onEdit: (t: Task) => void;
}) {
  const [text, setText] = useState("");
  const open = tasks.filter((t) => !t.done).length;
  const isToday = day === today;
  const add = async () => {
    if (!text.trim()) return;
    if (await attempt(() => api.addTask({ title: text, due: day }))) setText("");
  };
  return (
    <div className={cx("flex min-h-0 flex-col rounded-xl border bg-[#fbfbfa] transition-colors duration-100",
      selected ? "border-[#f3c9a3] bg-[#fffaf5]" : "border-line")}>
      <button type="button" onClick={onSelect} className="flex items-start justify-between rounded-t-xl px-3.5 pt-3 pb-2 text-left">
        <span>
          <span className="block text-[15px] font-semibold">{WEEKDAYS[parse(day).getDay()]}</span>
          <span className="block text-[12.5px] text-muted">{fmtShort(day)}</span>
        </span>
        <span className="text-right">
          <span className="block text-[12px] text-muted">{open} open</span>
          {isToday && <span className="mt-0.5 inline-block rounded-full bg-accent px-2 text-[11px] font-semibold leading-[18px] text-[#2a1606]">Today</span>}
        </span>
      </button>
      <div className="px-2.5 pb-2">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
          placeholder="+ Add a task" aria-label={`Add a task for ${fmtShort(day)}`}
          className="h-8 w-full rounded-lg border border-transparent bg-transparent px-2 text-[13.5px] placeholder:text-faint hover:bg-panel hover:border-line focus:border-accent-ink focus:bg-panel focus:shadow-[0_0_0_3px_rgba(245,134,42,0.15)] transition-[background-color,border-color,box-shadow] duration-100" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-2.5 pb-3">
        {tasks.length === 0 && <Empty>No tasks for this day.</Empty>}
        {tasks.map((t) => <TaskCard key={t.id} task={t} today={today} onEdit={() => onEdit(t)} />)}
      </div>
    </div>
  );
}

export function TaskCard({ task, today, onEdit }: { task: Task; today: string; onEdit: () => void }) {
  const overdue = !task.done && !!task.due && task.due < today;
  const meta = [overdue && `Overdue · ${fmtShort(task.due)}`, task.priority !== "normal" && `${task.priority[0].toUpperCase()}${task.priority.slice(1)} priority`,
    task.notes.trim() && "Notes"].filter(Boolean);
  const toggle = async (done: boolean) => {
    if (await attempt(() => api.setTaskDone(task.id, done)))
      toast.info(done ? `Completed "${task.title}".` : `Reopened "${task.title}".`, { label: "Undo", run: undoLast });
  };
  return (
    <div onClick={onEdit} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") onEdit(); }}
      className={cx("group flex cursor-pointer gap-2.5 rounded-lg border px-2.5 py-2 transition-[border-color,box-shadow] duration-100",
        task.done ? "border-transparent bg-[#f1f1ee]" : "border-line bg-panel shadow-[0_1px_1px_rgba(0,0,0,0.03)] hover:border-line-strong")}>
      <span className="pt-[1px]"><Checkbox checked={task.done} onChange={toggle} label={`Complete ${task.title}`} /></span>
      <span className="min-w-0 flex-1">
        <span className={cx("block text-[13.5px] leading-snug break-words", task.done && "text-faint line-through")}>{task.title}</span>
        {meta.length > 0 && <span className={cx("mt-0.5 block text-[12px]", overdue ? "text-warn" : "text-muted")}>{meta.join("  ·  ")}</span>}
      </span>
      {task.priority === "high" && !task.done && <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />}
    </div>
  );
}

function Schedule({ day, today, events, onNew, onOpen }: {
  day: string; today: string; events: CalEvent[]; onNew: () => void; onOpen: (e: CalEvent) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const allDay = events.filter((e) => !e.start);
  const placed = layoutTimed(events.filter((e) => !!e.start), 30);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(t); }, []);
  useEffect(() => { // scroll to the first event, or 07:00
    const first = placed[0]?.top ?? 7 * 60;
    scroller.current?.scrollTo({ top: Math.max(0, (first / 60) * HOUR - 16) });
  }, [day]); // eslint-disable-line react-hooks/exhaustive-deps
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return (
    <aside className="flex w-[320px] shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-panel">
      <div className="px-4 pt-3.5 pb-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[18px] font-semibold">{WEEKDAYS[parse(day).getDay()]}{day === today && <span className="text-accent-ink"> · Today</span>}</h2>
          <Button size="sm" icon={<Plus size={14} />} onClick={onNew}>Event</Button>
        </div>
        <p className="text-[12.5px] text-muted">{fmtShort(day)}, {day.slice(0, 4)} · {events.length} event{events.length === 1 ? "" : "s"}</p>
        <div className="mt-2 flex flex-col gap-1">
          {allDay.map((e) => (
            <button key={e.id} type="button" onClick={() => onOpen(e)}
              className="truncate rounded-md bg-accent-soft px-2 py-1 text-left text-[12.5px] font-medium text-accent-ink hover:bg-[#ffe6d1]">{e.title}</button>
          ))}
        </div>
      </div>
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto border-t border-line">
        <div className="relative" style={{ height: HOUR * 24 + 16 }}>
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="absolute inset-x-0 flex" style={{ top: 8 + h * HOUR }}>
              <span className="w-12 -translate-y-2 pr-2 text-right text-[11px] text-faint">{String(h).padStart(2, "0")}:00</span>
              <span className="flex-1 border-t border-line" />
            </div>
          ))}
          {placed.map((p) => (
            <button key={p.item.id} type="button" onClick={() => onOpen(p.item)} title={`${p.item.start}–${p.item.end} ${p.item.title}`}
              className="absolute overflow-hidden rounded-md border-l-[3px] border-accent bg-accent-soft px-2 py-1 text-left text-[12px] leading-tight text-accent-ink hover:bg-[#ffe6d1]"
              style={{ top: 8 + (p.top / 60) * HOUR + 1, height: Math.max(22, (p.height / 60) * HOUR - 2),
                left: `calc(52px + (100% - 60px) * ${p.lane / p.lanes})`, width: `calc((100% - 60px) / ${p.lanes} - 3px)` }}>
              {(p.height / 60) * HOUR < 40 ? ( // short block: one readable line
                <span className="block truncate"><span className="font-semibold">{p.item.title}</span> <span className="opacity-80">{p.item.start}</span></span>
              ) : (<>
                <span className="block truncate font-semibold">{p.item.title}</span>
                <span className="block opacity-80">{p.item.start}–{p.item.end}</span>
              </>)}
            </button>
          ))}
          {day === today && (
            <div className="pointer-events-none absolute right-2 left-11 flex items-center" style={{ top: 8 + (nowMin / 60) * HOUR }}>
              <span className="size-2 -translate-x-1 rounded-full bg-accent" /><span className="h-[2px] flex-1 bg-accent" />
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
