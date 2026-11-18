import { useEffect, useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import type { CalEvent, Priority, Task } from "../shared/types";
import { api, attempt, toast, undoLast } from "./lib";
import { Button, Dialog, Field, inputCls, textareaCls } from "./ui";

export type TaskDraft = { task?: Task; due?: string } | null;
export type EventDraft = { event?: CalEvent; date?: string } | null;

export function TaskEditor({ draft, onClose }: { draft: TaskDraft; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState<Priority>("normal");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!draft) return;
    setTitle(draft.task?.title ?? "");
    setDue(draft.task?.due ?? draft.due ?? "");
    setPriority(draft.task?.priority ?? "normal");
    setNotes(draft.task?.notes ?? "");
    setError("");
  }, [draft]);
  const editing = !!draft?.task;

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    try {
      if (editing) await api.updateTask(draft!.task!.id, { title, due, priority, notes });
      else await api.addTask({ title, due, priority, notes });
      toast.info(editing ? "Task saved." : "Task added.");
      onClose();
    } catch (err) {
      setError(String((err as Error).message));
    }
  };
  const remove = async () => {
    if (await attempt(() => api.deleteTask(draft!.task!.id))) {
      toast.info(`Deleted "${draft!.task!.title}".`, { label: "Undo", run: undoLast });
      onClose();
    }
  };

  return (
    <Dialog open={!!draft} onClose={onClose} title={editing ? "Edit task" : "New task"}
      footer={<>
        {editing && <Button variant="danger" className="mr-auto" icon={<Trash2 size={14} />} onClick={remove}>Delete</Button>}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => save()}>{editing ? "Save" : "Add task"}</Button>
      </>}>
      <form className="flex flex-col gap-3.5" onSubmit={save} onKeyDown={(e) => { if (e.key === "Enter" && e.ctrlKey) save(); }}>
        <Field label="Title" error={error}>
          <input className={inputCls} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Due date" hint="Optional">
            <input type="date" className={inputCls} value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>
          <Field label="Priority">
            <select className={inputCls} value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              <option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option>
            </select>
          </Field>
        </div>
        <Field label="Notes">
          <textarea className={textareaCls} rows={4} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export function EventEditor({ draft, onClose }: { draft: EventDraft; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!draft) return;
    setTitle(draft.event?.title ?? "");
    setDate(draft.event?.date ?? draft.date ?? "");
    setStart(draft.event?.start ?? "");
    setEnd(draft.event?.end ?? "");
    setNotes(draft.event?.notes ?? "");
    setError("");
  }, [draft]);
  const editing = !!draft?.event;

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    try {
      const body = { title, date, start, end, notes };
      if (editing) await api.updateEvent(draft!.event!.id, body);
      else await api.addEvent(body);
      toast.info(editing ? "Event saved." : "Event added.");
      onClose();
    } catch (err) {
      setError(String((err as Error).message));
    }
  };
  const remove = async () => {
    if (await attempt(() => api.deleteEvent(draft!.event!.id))) {
      toast.info(`Deleted "${draft!.event!.title}".`, { label: "Undo", run: undoLast });
      onClose();
    }
  };

  return (
    <Dialog open={!!draft} onClose={onClose} title={editing ? "Edit event" : "New event"}
      footer={<>
        {editing && <Button variant="danger" className="mr-auto" icon={<Trash2 size={14} />} onClick={remove}>Delete</Button>}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => save()}>{editing ? "Save" : "Add event"}</Button>
      </>}>
      <form className="flex flex-col gap-3.5" onSubmit={save}>
        <Field label="Title" error={error}>
          <input className={inputCls} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Meeting, class, reminder…" />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Date"><input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Start" hint="Blank = all day"><input type="time" className={inputCls} value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="End"><input type="time" className={inputCls} value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
        </div>
        <Field label="Notes">
          <textarea className={textareaCls} rows={3} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
