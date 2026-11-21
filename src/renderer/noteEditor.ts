// CodeMirror 6 editor for Markdown + LaTeX notes: Markdown highlighting, tinted math, LaTeX command completion
// with tab stops, and formatting shortcuts (Ctrl+B, Ctrl+I, Ctrl+M, Ctrl+Shift+M).
import { EditorSelection, EditorState, Prec, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, drawSelection, highlightActiveLine, keymap, placeholder,
  type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, snippetCompletion,
  type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";

// ---- LaTeX completion -------------------------------------------------------------------------------
const SNIPPETS: [string, string, string?][] = [ // label, template (${} = tab stop), detail
  ["\\frac", "\\frac{${num}}{${den}}", "fraction"], ["\\dfrac", "\\dfrac{${num}}{${den}}"], ["\\sqrt", "\\sqrt{${x}}"],
  ["\\sqrt[n]", "\\sqrt[${n}]{${x}}"], ["\\sum", "\\sum_{${i=1}}^{${n}}"], ["\\prod", "\\prod_{${i=1}}^{${n}}"],
  ["\\int", "\\int_{${a}}^{${b}} ${f(x)} \\,d${x}"], ["\\iint", "\\iint_{${D}}"], ["\\oint", "\\oint_{${C}}"],
  ["\\lim", "\\lim_{${x \\to \\infty}}"], ["\\binom", "\\binom{${n}}{${k}}"], ["\\vec", "\\vec{${v}}"],
  ["\\hat", "\\hat{${x}}"], ["\\bar", "\\bar{${x}}"], ["\\overline", "\\overline{${x}}"], ["\\dot", "\\dot{${x}}"],
  ["\\tilde", "\\tilde{${x}}"], ["\\mathbb", "\\mathbb{${R}}"], ["\\mathcal", "\\mathcal{${L}}"], ["\\mathrm", "\\mathrm{${d}}"],
  ["\\mathbf", "\\mathbf{${x}}"], ["\\boldsymbol", "\\boldsymbol{${x}}"], ["\\text", "\\text{${text}}"],
  ["\\operatorname", "\\operatorname{${name}}"], ["\\left(", "\\left( ${} \\right)"], ["\\left[", "\\left[ ${} \\right]"],
  ["\\left\\{", "\\left\\{ ${} \\right\\}"], ["\\partial", "\\frac{\\partial ${f}}{\\partial ${x}}", "partial derivative"],
  ["\\deriv", "\\frac{d${y}}{d${x}}", "derivative"], ["\\underbrace", "\\underbrace{${x}}_{${label}}"],
  ["\\overbrace", "\\overbrace{${x}}^{${label}}"], ["\\xrightarrow", "\\xrightarrow{${f}}"], ["\\tag", "\\tag{${1}}"],
  ["\\label", "\\label{${eq:name}}"], ["\\eqref", "\\eqref{${eq:name}}"], ["\\ref", "\\ref{${eq:name}}"],
  ["\\newcommand", "\\newcommand{\\${name}}{${definition}}"], ["\\ce", "\\ce{${H2O}}", "chemistry"],
  ["\\begin{align}", "\\begin{align}\n${a} &= ${b} \\\\\n\\end{align}", "numbered"],
  ["\\begin{align*}", "\\begin{align*}\n${a} &= ${b} \\\\\n\\end{align*}"],
  ["\\begin{equation}", "\\begin{equation}\n${}\n\\end{equation}", "numbered"],
  ["\\begin{gather}", "\\begin{gather}\n${}\n\\end{gather}"], ["\\begin{cases}", "\\begin{cases}\n${a} & ${x > 0} \\\\\n${b} & ${x \\le 0}\n\\end{cases}"],
  ["\\begin{pmatrix}", "\\begin{pmatrix}\n${a} & ${b} \\\\\n${c} & ${d}\n\\end{pmatrix}"],
  ["\\begin{bmatrix}", "\\begin{bmatrix}\n${a} & ${b} \\\\\n${c} & ${d}\n\\end{bmatrix}"],
  ["\\begin{vmatrix}", "\\begin{vmatrix}\n${a} & ${b} \\\\\n${c} & ${d}\n\\end{vmatrix}"],
  ["\\begin{array}", "\\begin{array}{${cc}}\n${a} & ${b}\n\\end{array}"], ["\\begin{CD}", "\\begin{CD}\n${A} @>${f}>> ${B}\n\\end{CD}"],
];
const SYMBOLS = ("alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho " +
  "sigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Phi Psi Omega infty nabla partial forall " +
  "exists nexists emptyset in notin subset subseteq supset supseteq cup cap setminus times cdot div pm mp leq geq neq approx " +
  "equiv sim simeq cong propto to rightarrow leftarrow Rightarrow Leftarrow iff implies mapsto ldots cdots vdots ddots quad " +
  "qquad langle rangle lfloor rfloor lceil rceil land lor neg oplus otimes perp parallel angle circ star dagger hbar ell Re Im " +
  "aleph sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh log ln exp det dim ker max min sup inf arg deg gcd Pr " +
  "displaystyle textstyle mid nmid top bot vee wedge bigcup bigcap bigoplus bigotimes coprod hline cdotp").split(" ");
const OPTIONS = [
  ...SNIPPETS.map(([label, tpl, detail]) => snippetCompletion(tpl, { label, detail, type: "function" })),
  ...SYMBOLS.map((s) => ({ label: `\\${s}`, type: "constant" })),
];

function latexComplete(ctx: CompletionContext): CompletionResult | null {
  const word = ctx.matchBefore(/\\[a-zA-Z]*(\{[a-zA-Z*]*)?/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  return { from: word.from, options: OPTIONS, validFor: /^\\[a-zA-Z]*(\{[a-zA-Z*]*)?$/ };
}

// ---- tint math regions ---------------------------------------------------------------------------
const MATH = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\begin\{([a-zA-Z]+\*?)\}[\s\S]+?\\end\{\1\}|\\\([^\n]+?\\\)|(?<![\\$])\$(?=[^\s$])[^$\n]*?[^\s\\$]?\$(?!\d)/g;
const mathMark = Decoration.mark({ class: "cm-math" });
function mathDecos(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const text = view.state.doc.toString();
  if (text.length > 400_000) return b.finish(); // keep typing fast in huge notes
  for (const m of text.matchAll(MATH)) if (m[0].length > 1) b.add(m.index!, m.index! + m[0].length, mathMark);
  return b.finish();
}
const mathTint = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = mathDecos(view); }
  update(u: ViewUpdate) { if (u.docChanged) this.decorations = mathDecos(u.view); }
}, { decorations: (v) => v.decorations });

// ---- formatting commands -------------------------------------------------------------------------
/** Wrap each selection in before/after; an empty selection gets `fill` selected so you can type over it. */
export function wrap(view: EditorView, before: string, after: string, fill = "") {
  const tr = view.state.changeByRange((r) => {
    const sel = view.state.sliceDoc(r.from, r.to);
    const inner = sel || fill;
    return {
      changes: { from: r.from, to: r.to, insert: before + inner + after },
      range: EditorSelection.range(r.from + before.length, r.from + before.length + inner.length),
    };
  });
  view.dispatch(tr, { scrollIntoView: true, userEvent: "input" });
  view.focus();
  return true;
}
/** Insert a block on its own lines (math blocks, tables, code fences). */
export function block(view: EditorView, before: string, after: string, fill = "") {
  const r = view.state.selection.main;
  const line = view.state.doc.lineAt(r.from);
  const pre = r.from === line.from ? (line.number > 1 && view.state.doc.line(line.number - 1).text.trim() ? "\n" : "") : "\n\n";
  return wrap(view, pre + before, after + "\n", fill);
}
/** Toggle a line prefix ("# ", "- ", "- [ ] ", "> ") on every selected line. */
export function prefix(view: EditorView, mark: string) {
  const { state } = view;
  const lines = new Set<number>();
  for (const r of state.selection.ranges) for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) lines.add(n);
  const all = [...lines].map((n) => state.doc.line(n));
  const on = all.every((l) => l.text.startsWith(mark));
  view.dispatch({ changes: all.map((l) => {
    if (on) return { from: l.from, to: l.from + mark.length, insert: "" };
    const old = /^(#{1,6} |- \[[ xX]\] |[-*+] |\d+\. |> )/.exec(l.text);
    return { from: l.from, to: l.from + (old && mark !== "> " ? old[0].length : 0), insert: mark };
  }), userEvent: "input" });
  view.focus();
  return true;
}

const formatKeys = Prec.high(keymap.of([
  { key: "Mod-b", run: (v) => wrap(v, "**", "**", "bold") },
  { key: "Mod-i", run: (v) => wrap(v, "*", "*", "italic") },
  { key: "Mod-m", run: (v) => wrap(v, "$", "$", "x") },
  { key: "Mod-Shift-m", run: (v) => block(v, "$$\n", "\n$$", "x") },
  { key: "Mod-k", run: (v) => wrap(v, "[", "](https://)", "link") },
]));

// ---- look ----------------------------------------------------------------------------------------
const highlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: "700", fontSize: "1.3em" },
  { tag: t.heading2, fontWeight: "700", fontSize: "1.15em" },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "#9a470a" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", color: "#0f766e" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: "#9b9b95" },
  { tag: t.quote, color: "#4a4a46", fontStyle: "italic" },
  { tag: t.list, color: "#9a470a" },
]);
const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "14.5px", backgroundColor: "transparent" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.65", padding: "18px 0 40vh" },
  ".cm-content": { padding: "0 24px", caretColor: "#1d1d1b", maxWidth: "860px" },
  ".cm-line": { padding: "0" },
  "&.cm-focused": { outline: "none" },
  ".cm-activeLine": { backgroundColor: "#f7f6f2" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "#ffe2c8 !important" },
  ".cm-math": { color: "#6d4bd8", backgroundColor: "#f6f3fe", borderRadius: "3px" },
  ".cm-placeholder": { color: "#9b9b95" },
  ".cm-tooltip.cm-tooltip-autocomplete": { border: "1px solid #e5e5e0", borderRadius: "8px", overflow: "hidden",
    boxShadow: "0 10px 30px -10px rgba(0,0,0,0.25)", backgroundColor: "#fff" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "2px 10px !important", fontFamily: "var(--font-mono)", fontSize: "13px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "#fff0e3", color: "#1d1d1b" },
  ".cm-completionDetail": { color: "#9b9b95", fontStyle: "normal", marginLeft: "8px" },
  ".cm-panels": { backgroundColor: "#f6f6f4", borderColor: "#e5e5e0" },
  ".cm-searchMatch": { backgroundColor: "#fff0c2" },
});

/** 0-based number of the first source line visible at the top of the editor. */
export function topLine(view: EditorView): number {
  const y = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
  return view.state.doc.lineAt(view.lineBlockAtHeight(Math.max(0, y)).from).number - 1;
}

export function noteExtensions(onChange: (doc: string) => void): Extension[] {
  return [
    history(), drawSelection(), highlightActiveLine(), indentOnInput(), bracketMatching(), closeBrackets(),
    highlightSelectionMatches(), search({ top: true }), EditorView.lineWrapping, EditorState.allowMultipleSelections.of(true),
    markdown({ base: markdownLanguage }), syntaxHighlighting(highlight), mathTint, theme,
    autocompletion({ override: [latexComplete], icons: false, activateOnTyping: true }),
    placeholder("Start writing… Markdown with $inline$ and $$display$$ math. Type \\ for LaTeX commands."),
    formatKeys,
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
    EditorView.updateListener.of((u) => { if (u.docChanged) onChange(u.state.doc.toString()); }),
  ];
}
