import { useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, Download, Flame, Loader2, RefreshCw } from "lucide-react";
import type { ConnectionsReport } from "../../shared/types";
import { WORKERS } from "../../shared/workers";
import { api, attempt, cx, toast } from "../lib";
import { Button, selectCls } from "../ui";

export function Connections({ active }: { active: boolean }) {
  const [report, setReport] = useState<ConnectionsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = async () => {
    setLoading(true);
    try { setReport(await api.connections()); } catch (e) { toast.error((e as Error).message); } finally { setLoading(false); }
  };
  useEffect(() => { if (active) void refresh(); }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-full flex-col overflow-y-auto px-6 pt-4 pb-6">
      <header className="flex items-center pb-1">
        <h1 className="text-[22px] font-semibold">Connections</h1>
        <Button className="ml-auto mr-2" variant="ghost" icon={<Flame size={14} />}
          onClick={() => attempt(async () => toast.info(await api.warmUp()))}>Warm up models</Button>
        <Button disabled={loading} onClick={refresh}
          icon={loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}>Refresh</Button>
      </header>
      <p className="max-w-[900px] pb-4 text-[13px] text-muted">ChatGPT plans and reviews; the local models do the work, up to {report?.maxParallel ?? 3} at
        the same time{report?.loadedModels.length ? ` (in memory now: ${report.loadedModels.join(", ")})` : ""}. A model's first
        use loads it from disk, which can take a few minutes; it then stays ready for 30 minutes.</p>
      <div className="grid max-w-[900px] gap-2.5">
        {(report?.agents ?? []).map((a) => (
          <div key={a.id} className={cx("flex items-start gap-3 rounded-xl border border-line bg-panel px-4 py-3", !a.enabled && "opacity-60")}>
            {a.available ? <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-ok" /> : <CircleAlert size={18} className="mt-0.5 shrink-0 text-warn" />}
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-semibold">{a.name}</div>
              <div className="text-[12.5px] text-muted">{WORKERS[a.id].role}</div>
              <div className="mt-0.5 text-[12px] text-faint">{a.detail} · {a.cloud ? "cloud, sends only what you approve" : "runs on this PC"}</div>
              {!a.available && <div data-selectable className="mt-1 font-mono text-[12px] text-warn">{a.hint}</div>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {!a.cloud && report && report.ollamaModels.length > 0 && (
                <select aria-label={`${a.name} model`} className={cx(selectCls, "h-8")} value={a.model}
                  onChange={(e) => attempt(async () => { await api.setWorkerModel(a.id, e.target.value); await refresh(); })}>
                  {[...new Set([a.model, ...report.ollamaModels])].map((m) => <option key={m}>{m}</option>)}
                </select>
              )}
              {a.id !== "chatgpt" && (
                <label className="flex cursor-pointer items-center gap-1.5 text-[12.5px] text-muted">
                  <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={a.enabled}
                    onChange={(e) => attempt(async () => { await api.setWorkerEnabled(a.id, e.target.checked); await refresh(); })} />
                  Use
                </label>
              )}
            </div>
          </div>
        ))}
        {!report && loading && <p className="text-[13px] text-muted">Checking agents…</p>}
      </div>

      <section className="mt-6 max-w-[900px] rounded-xl border border-line bg-panel px-4 py-3">
        <h2 className="text-[14px] font-semibold">Data</h2>
        <p data-selectable className="mt-1 text-[12.5px] text-muted">Stored in {report?.dataDir ?? "…"}</p>
        {report?.oldDbFound && (
          <div className="mt-3 flex items-center gap-3">
            <p className="flex-1 text-[12.5px] text-muted">Copy tasks, events and projects from the old tkinter app. The old database is opened read-only
              and is not changed; items already copied are skipped.</p>
            <Button icon={<Download size={14} />} onClick={() => attempt(async () => {
              const r = await api.importOld();
              toast.info(`Imported ${r.tasks} tasks, ${r.events} events, ${r.projects} projects (${r.skipped} already here).`);
            })}>Import from old app</Button>
          </div>
        )}
      </section>
    </div>
  );
}
