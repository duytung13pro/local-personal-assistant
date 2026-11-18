import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Search } from "lucide-react";
import type { Task } from "../../shared/types";
import { fmtShort } from "../../shared/dates";
import { matches, type Due, type Status } from "../../shared/filters";
import { api, attempt, cx, toast, undoLast, useData } from "../lib";
import { Button, Checkbox, inputCls, selectCls } from "../ui";
import type { Ctx } from "../App";

export function Checklist({ ctx }: { ctx: Ctx }) {
  const [tasks] = useData(() => api.listTasks(), [], ["tasks"]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("open");
  const [priority, setPriority] = useState("all");
  const [due, setDue] = useState<Due>("any");
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ctx.searchSignal) { search.current?.focus(); search.current?.select(); } }, [ctx.searchSignal]);

  const shown = useMemo(() => (tasks ?? []).filter((t) => matches(t, query, status, priority, due, ctx.today)),
    [tasks, query, status, priority, due, ctx.today]);
  const filtered = query || status !== "open" || priority !== "all" || due !== "any";

  const toggle = async (t: Task, done: boolean) => {
    if (await attempt(() => api.setTaskDone(t.id, done)))
      toast.info(done ? `Completed "${t.title}".` : `Reopened "${t.title}".`, { label: "Undo", run: undoLast });
  };

  return (
    <div className="flex h-full flex-col px-6 pt-4 pb-4">
      <header className="flex items-center pb-4">
        <h1 className="text-[22px] font-semibold">Checklist</h1>
        <Button variant="primary" className="ml-auto" icon={<Plus size={15} />} onClick={() => ctx.editTask({})}>New task</Button>
      </header>
      <div className="flex flex-wrap items-center gap-2 pb-3">
        <div className="relative min-w-[260px] flex-1">
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
          <input ref={search} className={cx(inputCls, "pl-9")} placeholder="Search titles and notes  (Ctrl+F)" value={query}
            onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }} />
        </div>
        <Segmented value={status} onChange={setStatus} options={[["open", "Open"], ["done", "Done"], ["all", "All"]]} />
        <select aria-label="Priority" className={selectCls} value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="all">Any priority</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option>
        </select>
        <select aria-label="Due" className={selectCls} value={due} onChange={(e) => setDue(e.target.value as Due)}>
          <option value="any">Any date</option><option value="overdue">Overdue</option><option value="today">Today</option>
          <option value="upcoming">Upcoming</option><option value="none">No due date</option>
        </select>
        {filtered && <Button variant="ghost" size="sm" onClick={() => { setQuery(""); setStatus("open"); setPriority("all"); setDue("any"); }}>Reset</Button>}
      </div>
      <p className="pb-2 text-[12.5px] text-muted">Showing {shown.length} of {(tasks ?? []).length} tasks</p>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-line bg-panel">
        {shown.length === 0 && <p className="p-6 text-center text-[13.5px] text-faint">{(tasks ?? []).length ? "No tasks match these filters." : "No tasks yet. Press Ctrl+N to add one."}</p>}
        {shown.map((t) => {
          const overdue = !t.done && !!t.due && t.due < ctx.today;
          return (
            <div key={t.id} role="button" tabIndex={0} onClick={() => ctx.editTask({ task: t })}
              onKeyDown={(e) => { if (e.key === "Enter") ctx.editTask({ task: t }); if (e.key === " ") { e.preventDefault(); void toggle(t, !t.done); } }}
              className="flex cursor-pointer items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0 hover:bg-[#fafaf8] transition-colors duration-100">
              <Checkbox checked={t.done} onChange={(v) => void toggle(t, v)} label={`Complete ${t.title}`} />
              <span className="min-w-0 flex-1">
                <span className={cx("block truncate text-[14px]", t.done && "text-faint line-through")}>{t.title}</span>
                {t.notes.trim() && <span className="block truncate text-[12px] text-muted">{t.notes}</span>}
              </span>
              {t.priority !== "normal" && <span className={cx("rounded-full px-2 text-[11.5px] font-medium leading-5",
                t.priority === "high" ? "bg-accent-soft text-accent-ink" : "bg-[#efefec] text-muted")}>{t.priority}</span>}
              <span className={cx("w-[88px] text-right text-[12.5px]", overdue ? "font-medium text-warn" : "text-muted")}>
                {t.due ? fmtShort(t.due) : "—"}</span>
            </div>
          );
        })}
      </div>
      <p className="pt-2 text-[12px] text-faint">Click a task to edit · Space toggles done when a row is focused · Ctrl+Z undoes</p>
    </div>
  );
}

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div role="radiogroup" className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-[#f1f1ee] p-0.5">
      {options.map(([v, label]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}
          className={cx("h-full rounded-md px-3 text-[13px] transition-[background-color,color,box-shadow] duration-100",
            value === v ? "bg-panel font-semibold text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-muted hover:text-ink")}>{label}</button>
      ))}
    </div>
  );
}
