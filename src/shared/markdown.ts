// Markdown + LaTeX for Notes. markdown-it (CommonMark + tables) with KaTeX math, used by the preview and PDF export.
// Math syntax, as in Pandoc/Obsidian/Overleaf habits:
//   inline  $x^2$  \(x^2\)            display  $$...$$  \[...\]   (one line or many)
//   bare environments at the start of a line: \begin{align} ... \end{align} (equation, gather, alignat, CD...)
// Numbered environments (equation, align, gather, alignat) count (1), (2)... across the whole note, and
// \label{key} + \eqref{key} / \ref{key} work in math and in text. \newcommand / \def carry to later formulas.
import MarkdownItFactory, { type MarkdownIt, type StateBlock, type StateCore, type StateInline, type Token } from "markdown-it";
import katex from "katex";
import "katex/contrib/mhchem"; // \ce{H2O} and \pu{} for chemistry

interface Env { labels: Map<string, number>; count: number; macros: Record<string, string>; [key: PropertyKey]: unknown }

const ENV = String.raw`(equation|align|gather|alignat|flalign|multline|CD|split|aligned|gathered|eqnarray)\*?`;
const BEGIN = new RegExp(String.raw`^\\begin\{(${ENV})\}`);
const NUMBERED = /^\\begin\{(equation|align|gather|alignat)\}(\{\d+\})?/;
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const escaped = (s: string, i: number) => { let n = 0; while (i - 1 - n >= 0 && s[i - 1 - n] === "\\") n++; return n % 2 === 1; };

/** Split an environment body on top-level \\ (not inside braces or nested environments). */
function rows(body: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\" && body[i + 1] === "\\" && depth === 0) { out.push(body.slice(start, i)); start = i + 2; i++; continue; }
    if (c === "\\") { // skip escaped chars, track \begin / \end
      if (body.startsWith("\\begin", i)) depth++;
      else if (body.startsWith("\\end", i)) depth--;
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  out.push(body.slice(start));
  return out;
}

/** Give numbered environments note-wide numbers (KaTeX alone restarts at (1) in every formula). */
export function numberMath(tex: string, env: Env): string {
  const t = tex.trim();
  const m = NUMBERED.exec(t);
  if (!m) return tex;
  const name = m[1];
  const endTag = `\\end{${name}}`;
  if (!t.endsWith(endTag)) return tex;
  const body = t.slice(m[0].length, t.length - endTag.length);
  const tag = (row: string, single: boolean) => {
    const label = /\\label\{([^}]*)\}/.exec(row);
    let r = row.replace(/\\label\{[^}]*\}/g, "");
    if (/\\(notag|nonumber)\b/.test(r)) return r.replace(/\\(notag|nonumber)\b/g, "");
    if (/\\tag\*?\{/.test(r)) return r;
    if (!single && !r.trim()) return r; // empty last row after a trailing \\
    const n = ++env.count;
    if (label) env.labels.set(label[1], n);
    return `${r}\\tag{${n}}`;
  };
  const star = `${name}*`;
  if (name === "equation") return `\\begin{${star}}${tag(body, true)}\\end{${star}}`;
  return `\\begin{${star}}${m[2] ?? ""}${rows(body).map((r) => tag(r, false)).join("\\\\")}\\end{${star}}`;
}

const refs = (s: string, env: Env, math: boolean) =>
  s.replace(/\\(eq)?ref\{([^}]*)\}/g, (_all, eq: string | undefined, key: string) => {
    const n = env.labels.get(key);
    const txt = n === undefined ? "??" : String(n);
    if (math) return eq ? `\\text{(${txt})}` : `\\text{${txt}}`;
    return eq ? `(${txt})` : txt;
  });

function renderMath(tex: string, display: boolean, env: Env): string {
  try {
    return katex.renderToString(refs(tex, env, true), {
      displayMode: display, throwOnError: true, macros: env.macros, globalGroup: true, strict: "ignore", trust: false,
      output: "htmlAndMathml",
    });
  } catch (e) {
    const msg = String((e as Error).message ?? e).replace(/^KaTeX parse error: /, "");
    const tag = display ? "div" : "span";
    return `<${tag} class="math-error" title="${escapeHtml(msg)}"><code>${escapeHtml(tex)}</code>` +
      (display ? `<small>${escapeHtml(msg)}</small>` : "") + `</${tag}>`;
  }
}

function mathPlugin(md: MarkdownIt) {
  // ---- inline: $...$, $$...$$, \(...\), \[...\] ----
  md.inline.ruler.before("escape", "math_inline", (state: StateInline, silent: boolean) => {
    const src = state.src, pos = state.pos;
    let open = "", close = "";
    if (src.startsWith("\\(", pos)) { open = "\\("; close = "\\)"; }
    else if (src.startsWith("\\[", pos)) { open = "\\["; close = "\\]"; }
    else if (src.startsWith("$$", pos)) { open = close = "$$"; }
    else if (src[pos] === "$") { open = close = "$"; }
    else return false;
    const single = open === "$";
    if (single && /\s/.test(src[pos + 1] ?? " ")) return false; // "$ 5" is money, not math
    let end = pos + open.length;
    for (;;) {
      end = src.indexOf(close, end);
      if (end < 0) return false;
      if (close[0] === "$" && escaped(src, end)) { end++; continue; }
      if (single && (/\s/.test(src[end - 1]) || /\d/.test(src[end + 1] ?? ""))) { end++; continue; } // "$5 and $10"
      break;
    }
    const content = src.slice(pos + open.length, end);
    if (!content.trim()) return false;
    // "$5 and $10" or a $ that would swallow a `code span` is text: inline math holds no bare $ and no backtick.
    if (single && (/(^|[^\\])\$/.test(content) || content.includes("`"))) return false;
    if (!silent) {
      const tok = state.push("math", "math", 0);
      tok.content = content;
      tok.markup = open;
      tok.meta = { display: open === "$$" || open === "\\[" };
    }
    state.pos = end + close.length;
    return true;
  });

  // ---- block: $$ / \[ on their own lines, or a bare \begin{env} ----
  md.block.ruler.before("fence", "math_block", (state: StateBlock, startLine: number, endLine: number, silent: boolean) => {
    const lineText = (l: number) => state.src.slice(state.bMarks[l] + state.tShift[l], state.eMarks[l]);
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const first = lineText(startLine);
    let open: string, close: string, keep = false;
    const env = BEGIN.exec(first);
    if (first.startsWith("$$")) { open = "$$"; close = "$$"; }
    else if (first.startsWith("\\[")) { open = "\\["; close = "\\]"; }
    else if (env) { open = ""; close = `\\end{${env[1]}}`; keep = true; }
    else return false;

    let content = "";
    let last = startLine;
    const rest = first.slice(open.length);
    const sameLine = keep ? first.indexOf(close) : rest.indexOf(close);
    if (sameLine >= 0) { // opened and closed on one line
      const after = keep ? first.slice(sameLine + close.length) : rest.slice(sameLine + close.length);
      if (after.trim()) return false; // text after the formula: let the inline rule handle it
      content = keep ? first : rest.slice(0, sameLine);
    } else {
      const lines = [keep ? first : rest];
      let found = false;
      for (let l = startLine + 1; l < endLine; l++) {
        const t = lineText(l);
        if (state.sCount[l] < state.blkIndent && t.trim()) break; // left the enclosing block
        const at = t.indexOf(close);
        if (at >= 0 && !t.slice(at + close.length).trim()) {
          lines.push(keep ? t : t.slice(0, at));
          last = l;
          found = true;
          break;
        }
        lines.push(t);
      }
      if (!found) return false;
      content = lines.join("\n");
    }
    if (!content.trim()) return false;
    if (silent) return true;
    const tok = state.push("math_block", "math", 0);
    tok.block = true;
    tok.content = content;
    tok.map = [startLine, last + 1];
    tok.markup = open || "\\begin";
    state.line = last + 1;
    return true;
  }, { alt: ["paragraph", "reference", "blockquote", "list"] }); // a $$ line may follow text directly

  // ---- number equations and collect \label keys before rendering, then resolve \ref in text ----
  md.core.ruler.push("math_numbers", (state: StateCore) => {
    const env = state.env as unknown as Env;
    const visit = (toks: Token[]) => {
      for (const t of toks) {
        if (t.type === "math_block" || (t.type === "math" && t.meta?.display)) t.content = numberMath(t.content, env);
        if (t.children) visit(t.children);
      }
    };
    visit(state.tokens);
    const texts = (toks: Token[]) => {
      for (const t of toks) {
        if (t.type === "text" && /\\(eq)?ref\{/.test(t.content)) t.content = refs(t.content, env, false);
        if (t.children) texts(t.children);
      }
    };
    texts(state.tokens);
  });

  md.renderer.rules.math = (toks, i, _o, env) => renderMath(toks[i].content, !!toks[i].meta?.display, env as unknown as Env);
  md.renderer.rules.math_block = (toks, i, _o, env) => {
    const t = toks[i];
    const line = t.map ? ` data-line="${t.map[0]}"` : "";
    return `<div class="math-block"${line}>${renderMath(t.content, true, env as unknown as Env)}</div>\n`;
  };
}

/** "- [ ] item" / "- [x] item" become (read-only) checkboxes. */
function taskLists(md: MarkdownIt) {
  md.core.ruler.after("inline", "task_lists", (state: StateCore) => {
    const toks = state.tokens;
    for (let i = 2; i < toks.length; i++) {
      const inline = toks[i];
      if (inline.type !== "inline" || toks[i - 1].type !== "paragraph_open" || toks[i - 2].type !== "list_item_open") continue;
      const m = /^\[([ xX])\]\s/.exec(inline.content);
      const first = inline.children?.[0];
      if (!m || !first || first.type !== "text") continue;
      first.content = first.content.replace(/^\[[ xX]\]\s/, "");
      const box = new state.Token("html_inline", "", 0);
      box.content = `<input type="checkbox" disabled${m[1] === " " ? "" : " checked"}> `;
      inline.children!.unshift(box);
      toks[i - 2].attrJoin("class", "task");
    }
  });
}

/** Source line numbers on top-level blocks, so the preview can follow the editor's scroll position. */
function lineAttrs(md: MarkdownIt) {
  md.core.ruler.push("line_attrs", (state: StateCore) => {
    for (const t of state.tokens) if (t.map && t.nesting === 1 && t.level === 0) t.attrSet("data-line", String(t.map[0]));
  });
}

const md = MarkdownItFactory({ html: false, linkify: true, typographer: false, breaks: false })
  .use(mathPlugin).use(taskLists).use(lineAttrs);

/** Render a note to HTML. Raw HTML in the note is shown as text (never executed). */
export function renderNote(src: string): string {
  const env: Env = { labels: new Map(), count: 0, macros: {} };
  return md.render(src, env);
}

/** Title shown in the list: the first heading or first non-empty line. */
export function noteTitle(body: string): string {
  const line = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^(\$\$|\\\[|```|---)/.test(l)) ?? "";
  const t = line.replace(/^#{1,6}\s+/, "").replace(/[*_`~]/g, "").replace(/\$([^$]*)\$/g, "$1").trim();
  return (t || "Untitled").slice(0, 120);
}
