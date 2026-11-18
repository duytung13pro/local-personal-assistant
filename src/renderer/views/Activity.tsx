import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, cx, useData } from "../lib";
import { AgentBadge, Empty } from "../ui";

export function ActivityView({ active }: { active: boolean }) {
  const [jobs, reload] = useData(() => api.listJobs(100), [], ["jobs", "steps"]);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { if (active) reload(); }, [active, reload]);
  return (
    <div className="flex h-full flex-col px-6 pt-4 pb-4">
      <h1 className="pb-4 text-[22px] font-semibold">Activity</h1>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-line bg-panel">
        {(jobs ?? []).length === 0 && <div className="p-6"><Empty>No agent runs yet. Runs from the AI Workspace appear here.</Empty></div>}
        {(jobs ?? []).map((j) => (
          <div key={j.id} className="border-b border-line last:border-b-0">
            <button type="button" onClick={() => setOpen(open === j.id ? null : j.id)}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-[#fafaf8]">
              <AgentBadge agent={j.agent} />
              <span className="min-w-0 flex-1 truncate text-[13.5px]">{j.title}</span>
              <span className={cx("text-[12.5px]", j.status === "done" ? "text-ok" : j.status === "failed" ? "text-danger" : "text-muted")}>
                {j.status === "running" && <Loader2 size={13} className="mr-1 inline animate-spin" />}{j.status}</span>
              <span className="w-[150px] text-right text-[12px] text-muted">{new Date(j.started).toLocaleString()}</span>
            </button>
            {open === j.id && (
              <pre data-selectable className="mx-4 mb-3 max-h-[320px] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-[#fafaf8] p-3 font-mono text-[12px]">
                {j.error || j.output || "(no output yet)"}</pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
