// Pure date helpers on local "YYYY-MM-DD" strings. No time zones: dates are wall-clock days.

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December"];

const pad = (n: number) => String(n).padStart(2, "0");

export function iso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parse(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`Not a date: ${s}`);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (iso(d) !== s) throw new Error(`Not a real date: ${s}`);
  return d;
}

export function isValidDate(s: string): boolean {
  try {
    parse(s);
    return true;
  } catch {
    return false;
  }
}

export function today(): string {
  return iso(new Date());
}

export function addDays(s: string, n: number): string {
  const d = parse(s);
  d.setDate(d.getDate() + n);
  return iso(d);
}

export function dayRange(start: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(start, i));
}

/** 6x7 grid of days (Sunday first) covering the month. */
export function monthGrid(year: number, month0: number): string[] {
  const first = new Date(year, month0, 1);
  const start = new Date(year, month0, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => iso(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)));
}

export function shiftMonth(year: number, month0: number, delta: number): [number, number] {
  const d = new Date(year, month0 + delta, 1);
  return [d.getFullYear(), d.getMonth()];
}

export function fmtShort(s: string): string {
  const d = parse(s);
  return `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
}

export function fmtLong(s: string): string {
  const d = parse(s);
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export function rangeLabel(days: string[]): string {
  if (!days.length) return "";
  const a = parse(days[0]);
  const b = parse(days[days.length - 1]);
  if (days.length === 1) return `${MONTHS[a.getMonth()].slice(0, 3)} ${a.getDate()}, ${a.getFullYear()}`;
  if (a.getFullYear() !== b.getFullYear())
    return `${fmtShort(days[0])}, ${a.getFullYear()} – ${fmtShort(days[days.length - 1])}, ${b.getFullYear()}`;
  if (a.getMonth() !== b.getMonth()) return `${fmtShort(days[0])} – ${fmtShort(days[days.length - 1])}, ${a.getFullYear()}`;
  return `${MONTHS[a.getMonth()].slice(0, 3)} ${a.getDate()} – ${b.getDate()}, ${a.getFullYear()}`;
}

export function isValidTime(s: string): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  return !!m && Number(m[1]) < 24 && Number(m[2]) < 60;
}

export function minutes(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

export interface Placed<T> {
  item: T;
  top: number; // minutes from midnight
  height: number; // minutes
  lane: number;
  lanes: number;
}

/** Lay out timed items side by side when they overlap (greedy lanes per overlap cluster). */
export function layoutTimed<T extends { start: string; end: string }>(items: T[], minHeight = 20): Placed<T>[] {
  const timed = items
    .filter((e) => isValidTime(e.start) && isValidTime(e.end))
    .map((item) => {
      const top = minutes(item.start);
      const end = Math.max(minutes(item.end), top + minHeight);
      return { item, top, end };
    })
    .sort((a, b) => a.top - b.top || b.end - a.end);
  const out: Placed<T>[] = [];
  let cluster: { p: Placed<T>; end: number }[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((c) => c.p.lane + 1));
    for (const c of cluster) c.p.lanes = lanes;
    cluster = [];
  };
  for (const t of timed) {
    if (t.top >= clusterEnd) {
      flush();
      clusterEnd = -1;
    }
    const used = new Set(cluster.filter((c) => c.end > t.top).map((c) => c.p.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    const p: Placed<T> = { item: t.item, top: t.top, height: t.end - t.top, lane, lanes: 1 };
    cluster.push({ p, end: t.end });
    out.push(p);
    clusterEnd = Math.max(clusterEnd, t.end);
  }
  flush();
  return out;
}
