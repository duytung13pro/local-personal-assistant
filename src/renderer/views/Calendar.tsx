import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { MONTHS, fmtLong, monthGrid, shiftMonth } from "../../shared/dates";
import { api, cx, useData } from "../lib";
import { Button, Empty, IconButton } from "../ui";
import { TaskCard } from "./Planner";
import type { Ctx } from "../App";

export function CalendarView({ ctx }: { ctx: Ctx }) {
  const { today, focusDate: sel, setFocusDate } = ctx;
  const [ym, setYm] = useState<[number, number]>([Number(sel.slice(0, 4)), Number(sel.slice(5, 7)) - 1]);
  useEffect(() => setYm([Number(sel.slice(0, 4)), Number(sel.slice(5, 7)) - 1]), [sel]);
  const days = useMemo(() => monthGrid(ym[0], ym[1]), [ym]);
  const [events] = useData(() => api.listEvents(days[0], days[41]), [days[0]], ["events"]);
  const [tasks] = useData(() => api.listTasks(), [], ["tasks"]);
  const dayEvents = (events ?? []).filter((e) => e.date === sel);
  const dayTasks = (tasks ?? []).filter((t) => t.due === sel);

  return (
    <div className="flex h-full gap-5 px-5 pt-4 pb-4">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-1.5 pb-3">
          <IconButton label="Previous month" onClick={() => setYm(shiftMonth(ym[0], ym[1], -1))}><ChevronLeft size={18} /></IconButton>
          <IconButton label="Next month" onClick={() => setYm(shiftMonth(ym[0], ym[1], 1))}><ChevronRight size={18} /></IconButton>
          <Button size="sm" className="ml-1" onClick={() => setFocusDate(today)}>Today</Button>
          <h1 className="ml-3 text-[22px] font-semibold">{MONTHS[ym[1]]} {ym[0]}</h1>
        </header>
        <div className="grid grid-cols-7 pb-1.5 text-[12px] font-medium text-muted">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => <span key={d} className="px-2">{d}</span>)}
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6 overflow-hidden rounded-xl border border-line bg-line gap-px">
          {days.map((d) => {
            const inMonth = Number(d.slice(5, 7)) - 1 === ym[1];
            const ev = (events ?? []).filter((e) => e.date === d);
            const openTasks = (tasks ?? []).filter((t) => t.due === d && !t.done).length;
            return (
              <button key={d} type="button" onClick={() => setFocusDate(d)} onDoubleClick={() => ctx.editEvent({ date: d })}
                className={cx("flex min-h-0 flex-col items-start gap-1 overflow-hidden p-1.5 text-left transition-colors duration-100",
                  d === sel ? "bg-accent-soft" : inMonth ? "bg-panel hover:bg-[#fafaf8]" : "bg-[#f7f7f5] hover:bg-[#f2f2ef]")}>
                <span className={cx("grid size-6 place-items-center rounded-full text-[12.5px]",
                  d === today ? "bg-accent font-semibold text-[#2a1606]" : inMonth ? "text-ink" : "text-faint")}>{Number(d.slice(8))}</span>
                {ev.slice(0, 2).map((e) => (
                  <span key={e.id} className="w-full truncate rounded px-1 text-[11.5px] leading-[17px] bg-[#fff1e5] text-accent-ink">
                    {e.start && <span className="opacity-75">{e.start} </span>}{e.title}</span>
                ))}
                {ev.length > 2 && <span className="px-1 text-[11px] text-muted">+{ev.length - 2} more</span>}
                {openTasks > 0 && <span className="mt-auto px-1 text-[11px] text-muted">{openTasks} task{openTasks === 1 ? "" : "s"}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <aside className="flex w-[340px] shrink-0 flex-col gap-4 overflow-y-auto">
        <h2 className="pt-1 text-[17px] font-semibold">{fmtLong(sel)}</h2>
        <section>
          <div className="flex items-center justify-between pb-2">
            <h3 className="text-[13px] font-semibold text-muted">Events</h3>
            <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => ctx.editEvent({ date: sel })}>New event</Button>
          </div>
          <div className="flex flex-col gap-1.5">
            {dayEvents.length === 0 && <Empty>No events this day.</Empty>}
            {dayEvents.map((e) => (
              <button key={e.id} type="button" onClick={() => ctx.editEvent({ event: e })}
                className="rounded-lg border border-line bg-panel px-3 py-2 text-left hover:border-line-strong transition-colors duration-100">
                <span className="block text-[13.5px] font-medium">{e.title}</span>
                <span className="block text-[12px] text-muted">{e.start ? `${e.start}–${e.end}` : "All day"}{e.notes ? " · Notes" : ""}</span>
              </button>
            ))}
          </div>
        </section>
        <section>
          <div className="flex items-center justify-between pb-2">
            <h3 className="text-[13px] font-semibold text-muted">Tasks due</h3>
            <Button size="sm" icon={<Plus size={14} />} onClick={() => ctx.editTask({ due: sel })}>New task</Button>
          </div>
          <div className="flex flex-col gap-1.5">
            {dayTasks.length === 0 && <Empty>No tasks due this day.</Empty>}
            {dayTasks.map((t) => <TaskCard key={t.id} task={t} today={today} onEdit={() => ctx.editTask({ task: t })} />)}
          </div>
        </section>
        <p className="mt-auto text-[12px] text-faint">Times are local wall-clock times as typed. Double-click a day to add an event.</p>
      </aside>
    </div>
  );
}
