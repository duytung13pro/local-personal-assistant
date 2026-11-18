import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Api } from "../shared/types";

declare global {
  interface Window { pa: Api; __pa?: { show: (view: string) => void } }
}

export const api = window.pa;

/** Load data, and reload it whenever the main process reports a change to one of `topics`. */
export function useData<T>(load: () => Promise<T>, deps: unknown[], topics: string[]): [T | undefined, () => void] {
  const [data, setData] = useState<T>();
  const loadRef = useRef(load);
  loadRef.current = load;
  const seq = useRef(0);
  const reload = useCallback(() => {
    const mine = ++seq.current;
    loadRef.current().then((v) => { if (mine === seq.current) setData(v); }, (e) => toast.error(String(e.message ?? e)));
  }, []);
  useEffect(reload, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => api.onChanged((what) => {
    if (what === "all" || topics.includes(what)) reload();
  }), [reload, topics.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  return [data, reload];
}

// ---- toasts (tiny external store) -------------------------------------------------------------
export interface Toast { id: number; text: string; kind: "info" | "error"; action?: { label: string; run: () => void } }
let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function push(t: Omit<Toast, "id">, ms: number) {
  const id = nextId++;
  toasts = [...toasts.slice(-2), { ...t, id }];
  emit();
  setTimeout(() => dismiss(id), ms);
}
export function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}
export const toast = {
  info: (text: string, action?: Toast["action"]) => push({ text, kind: "info", action }, action ? 6000 : 3500),
  error: (text: string) => push({ text: text.replace(/^Error: /, ""), kind: "error" }, 7000),
};
export function useToasts(): Toast[] {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => toasts);
}

/** Run an action; show its error as a toast instead of throwing. Returns true on success. */
export async function attempt(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    toast.error(String((e as Error).message ?? e));
    return false;
  }
}

export async function undoLast() {
  await attempt(async () => {
    const label = await api.undo();
    toast.info(label ? `Undone: ${label}` : "Nothing to undo.");
  });
}

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
