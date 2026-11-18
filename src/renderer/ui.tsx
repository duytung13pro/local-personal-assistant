// Small design system. Motion rules (Emil Kowalski): buttons respond on press with scale(0.97) in 100 ms;
// dialogs enter with ease-out from scale(0.96) + fade in 180 ms and leave faster; nothing that is used
// dozens of times a day (view switches, hovers, list changes) is animated beyond a quick colour change.
import { AnimatePresence, motion } from "motion/react";
import { forwardRef, useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { X } from "lucide-react";
import type { AgentId } from "../shared/types";
import { cx } from "./lib";

type Variant = "primary" | "secondary" | "ghost" | "danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-[#2a1606] font-semibold border border-accent-hover hover:bg-accent-hover active:bg-accent-press shadow-[0_1px_0_rgba(0,0,0,0.04)]",
  secondary: "bg-panel text-ink border border-line-strong hover:bg-[#f5f5f2] active:bg-hover shadow-[0_1px_0_rgba(0,0,0,0.03)]",
  ghost: "bg-transparent text-ink border border-transparent hover:bg-hover active:bg-line",
  danger: "bg-panel text-danger border border-[#efc3bf] hover:bg-danger-soft active:bg-[#f9dad7]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant; size?: "sm" | "md"; icon?: ReactNode;
}>(function Button({ variant = "secondary", size = "md", icon, className, children, ...rest }, ref) {
  return (
    <button ref={ref} type="button" {...rest}
      className={cx("inline-flex items-center justify-center gap-1.5 rounded-lg whitespace-nowrap select-none",
        "transition-[background-color,border-color,transform] duration-100 ease-[var(--ease-out)] active:scale-[0.97]",
        "disabled:opacity-45 disabled:pointer-events-none",
        size === "sm" ? "h-7 px-2.5 text-[13px]" : "h-8 px-3.5 text-[13.5px]", VARIANTS[variant], className)}>
      {icon}
      {children}
    </button>
  );
});

export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" aria-label={label} title={label} {...rest}
      className={cx("inline-grid place-items-center size-8 rounded-lg text-muted hover:text-ink hover:bg-hover",
        "active:scale-[0.94] transition-[background-color,color,transform] duration-100 ease-[var(--ease-out)]",
        "disabled:opacity-40 disabled:pointer-events-none", className)}>
      {children}
    </button>
  );
}

export function Field({ label, error, children, hint }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-medium text-muted">{label}</span>
      {children}
      {error ? <span className="text-[12.5px] text-danger">{error}</span> : hint ? <span className="text-[12px] text-faint">{hint}</span> : null}
    </label>
  );
}

const fieldBase = cx("h-9 rounded-lg border border-line-strong bg-panel px-3 text-[14px] text-ink",
  "placeholder:text-faint transition-[border-color,box-shadow] duration-100",
  "focus:border-accent-ink focus:shadow-[0_0_0_3px_rgba(245,134,42,0.18)]");
export const inputCls = cx(fieldBase, "w-full");
/** Compact select that sizes to its content (for filter bars and toolbars). */
export const selectCls = cx(fieldBase, "w-auto pr-8");

export const textareaCls = cx(inputCls, "h-auto py-2 leading-relaxed resize-none");

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={label}
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
      className={cx("grid place-items-center size-[18px] shrink-0 rounded-[5px] border transition-[background-color,border-color,transform]",
        "duration-150 ease-[var(--ease-out)] active:scale-[0.9]",
        checked ? "bg-accent border-accent-hover" : "bg-panel border-line-strong hover:border-muted")}>
      <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
        <motion.path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="#2a1606" strokeWidth={1.8} strokeLinecap="round"
          strokeLinejoin="round" initial={false} animate={{ pathLength: checked ? 1 : 0, opacity: checked ? 1 : 0 }}
          transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }} />
      </svg>
    </button>
  );
}

const AGENT_STYLE: Record<AgentId, string> = {
  chatgpt: "bg-[#e5f4f2] text-codex",
  codex: "bg-[#dff0ed] text-[#0b5f58]",
  "claude-chat": "bg-[#fdf1ea] text-[#b5521f]",
  "qwen-coder": "bg-[#ece7fd] text-qwen",
  qwen: "bg-[#f1ecfd] text-qwen",
  "qwen-fast": "bg-[#f4f1fd] text-[#7c64c9]",
  "gpt-oss": "bg-[#eaf1fb] text-[#2a5ea8]",
  claude: "bg-[#fdeee4] text-claude",
};
export const AGENT_LABEL: Record<AgentId, string> = {
  chatgpt: "ChatGPT", codex: "Codex", "claude-chat": "Claude", "qwen-coder": "Qwen Coder", qwen: "Qwen", "qwen-fast": "Qwen Fast", "gpt-oss": "GPT-OSS", claude: "Claude Code",
};

export function AgentBadge({ agent }: { agent: AgentId }) {
  return <span className={cx("inline-flex items-center h-5 px-2 rounded-full text-[11.5px] font-semibold", AGENT_STYLE[agent])}>
    {AGENT_LABEL[agent]}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-[13px] text-faint py-2">{children}</p>;
}

/** Modal dialog: focus moves in, Escape/backdrop close, focus returns to the opener afterwards. */
export function Dialog({ open, onClose, title, children, footer, width = 460 }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; width?: number;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    const t = setTimeout(() => box.current?.querySelector<HTMLElement>("input,textarea,select,button[data-autofocus]")?.focus(), 30);
    return () => {
      clearTimeout(t);
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [open]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-40 grid place-items-center bg-black/25 p-6"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.12 } }}
          transition={{ duration: 0.18 }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
          <motion.div ref={box} role="dialog" aria-modal aria-labelledby={id} style={{ width }}
            className="max-w-full max-h-full overflow-auto rounded-2xl bg-panel shadow-[0_24px_60px_-12px_rgba(0,0,0,0.28),0_0_0_1px_rgba(0,0,0,0.06)]"
            initial={{ opacity: 0, scale: 0.96, y: 6 }} animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.12, ease: [0.23, 1, 0.32, 1] } }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}>
            <div className="flex items-center justify-between px-5 pt-4 pb-2">
              <h2 id={id} className="text-[17px] font-semibold">{title}</h2>
              <IconButton label="Close" onClick={onClose}><X size={16} /></IconButton>
            </div>
            <div className="px-5 pb-4">{children}</div>
            {footer && <div className="flex justify-end gap-2 px-5 py-3 border-t border-line bg-[#fafaf8] rounded-b-2xl">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
