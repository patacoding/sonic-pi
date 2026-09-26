// SPDX-License-Identifier: AGPL-3.0-or-later
// The editing surface of the shader pane. This is the one part of the gfx layer that
// has to be bundled: CodeMirror 6 is written in bare module specifiers, which a
// browser cannot resolve on its own, so this file is esbuild's entry
// (scripts/build-gfx-editor.mjs) and its output beside it -- web/gfx-editor/editor.js,
// gitignored, built before serving or packaging -- is what the page imports. The page
// imports it lazily, the first time the shader pane is opened, so a performance that
// never opens the editor never downloads CodeMirror.
//
// Everything around the text -- the tabs, the channel pickers, the compile report,
// the documents -- is plain JavaScript in web/gfx-editor.js and never sees CodeMirror.
// The split is also why this file is worth bundling alone: it is the only code with
// dependencies, and the only code that would have to change if CodeMirror were
// replaced (web/xterm, say) for the editing surface.
//
// Colours are the app's own: the highlighter is app/src/highlight.js's, emitting the
// same sp-* classes the Ruby editor emits, so the theme's syntax colours (and the
// opacity fade over them) apply here without a second source of truth. That is a
// build-time dependency on an upstream internal, and a deliberate one: a rename there
// fails this build loudly rather than letting the two drift apart silently.
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars, rectangularSelection, crosshairCursor, dropCursor, gutter, GutterMarker, Decoration, tooltips } from "@codemirror/view";
import { EditorState, StateEffect, StateField, RangeSet, Transaction } from "@codemirror/state";
import { StreamLanguage, syntaxHighlighting, bracketMatching, indentUnit, HighlightStyle } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap, completionKeymap, autocompletion } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { spHighlighter } from "../../app/src/highlight.js";

// ── GLSL ──────────────────────────────────────────────────────────────────
// CodeMirror has no GLSL mode, and GLSL is close enough to C that its C mode gets
// most of it right except the words that matter here: the types (vec3, mat4), the
// Shadertoy uniforms, and the built-ins a shader is mostly written out of. So a
// stream parser of our own, which is also the smallest thing that can be correct:
// highlighting a shader is word-level, not parse-level.

const TYPES = new Set("void bool int uint float double vec2 vec3 vec4 bvec2 bvec3 bvec4 ivec2 ivec3 ivec4 uvec2 uvec3 uvec4 mat2 mat3 mat4 mat2x2 mat2x3 mat2x4 mat3x2 mat3x3 mat3x4 mat4x2 mat4x3 mat4x4 sampler1D sampler2D sampler3D samplerCube sampler2DArray sampler2DShadow samplerCubeShadow isampler2D isampler3D isamplerCube usampler2D usampler3D usamplerCube image2D atomic_uint".split(" "));

const KEYWORDS = new Set("attribute const uniform varying buffer shared coherent volatile restrict readonly writeonly layout centroid flat smooth noperspective patch sample break continue do for while switch case default if else in out inout struct discard return precision highp mediump lowp invariant precise true false".split(" "));

// the functions and variables a shader gets for free, painted apart from the uniforms
// the player names so that "is this mine or the language's?" is answerable at a glance
const BUILTINS = new Set("radians degrees sin cos tan asin acos atan sinh cosh tanh asinh acosh atanh pow exp log exp2 log2 sqrt inversesqrt abs sign floor trunc round roundEven ceil fract mod modf min max clamp mix step smoothstep isnan isinf floatBitsToInt floatBitsToUint intBitsToFloat uintBitsToFloat fma frexp ldexp packSnorm2x16 unpackSnorm2x16 packUnorm2x16 unpackUnorm2x16 packHalf2x16 unpackHalf2x16 length distance dot cross normalize faceforward reflect refract matrixCompMult outerProduct transpose determinant inverse lessThan lessThanEqual greaterThan greaterThanEqual equal notEqual any all not texture textureProj textureLod textureOffset texelFetch texelFetchOffset textureProjOffset textureLodOffset textureProjLod textureGrad textureProjGrad textureSize textureQueryLod textureQueryLevels textureSamples texture2D textureCube texture2DLod textureCubeLod dFdx dFdy fwidth noise1 noise2 noise3 noise4 EmitVertex EndPrimitive barrier memoryBarrier groupMemoryBarrier".split(" "));

// the prelude gfx-program.js puts in front of every pass: these are the names a
// shader is written against, and they are nobody's variables but the frame's
const UNIFORMS = new Set("iTime iTimeDelta iFrame iResolution iMouse iDate iSampleRate iChannel0 iChannel1 iChannel2 iChannel3 iChannelResolution iChannelTime iFrameRate gl_FragColor gl_FragCoord gl_FrontFacing gl_PointCoord gl_VertexID gl_InstanceID gl_Position gl_PointSize".split(" "));

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/;
const NUMBER = /0[xX][0-9a-fA-F]+[uU]?|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fFuU]?/;

const glslMode = {
  name: "glsl",
  startState: () => ({ inComment: false }),
  token(stream, state) {
    // a block comment need not close on the line it opens: the state carries it, so the
    // lines inside it are not read as code
    if (state.inComment) {
      if (!stream.skipTo("*/")) stream.skipToEnd();
      else { stream.match("*/"); state.inComment = false; }
      return "comment";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("//")) { stream.skipToEnd(); return "comment"; }
    if (stream.match("/*")) { state.inComment = true; return "comment"; }
    // a preprocessor directive's name, but not its arguments, which are ordinary code
    if (stream.match(/#\s*[A-Za-z_][A-Za-z0-9_]*/)) return "meta";
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(NUMBER)) return "number";
    if (stream.match(IDENT)) {
      const word = stream.current();
      if (KEYWORDS.has(word)) return "keyword";
      if (TYPES.has(word)) return "typeName";
      if (UNIFORMS.has(word)) return "variableName.special";
      if (BUILTINS.has(word)) return "variableName.standard";
      return "variableName";
    }
    if (stream.match(/^[{}()[\];,.]/)) return "punctuation";
    stream.next();
    return "operator";
  },
};

const glslLanguage = StreamLanguage.define(glslMode);

// The app's highlight style leaves some of what a shader is made of unstyled -- its
// built-in functions, the preprocessor, the booleans -- so those are added here rather
// than by copying that style: two highlighters compose, and the one that has nothing to
// say about a tag cannot disagree about it.
const glslExtras = HighlightStyle.define([
  { tag: t.standard(t.variableName), class: "sp-symbol" },     // sin, texture, normalize
  { tag: t.definition(t.variableName), class: "sp-def" },      // a function the shader defines
  { tag: t.meta, class: "sp-keyword" },                        // #define and friends
  { tag: t.bool, class: "sp-keyword" },
]);

const highlighting = [glslLanguage, syntaxHighlighting(spHighlighter), syntaxHighlighting(glslExtras)];

// ── Completion ────────────────────────────────────────────────────────────
// The vocabulary above, plus the uniform names the shader actually has (which the
// pane hands in from glGetActiveUniform, so the completion cannot offer a name the
// compiled program does not declare).

const VOCAB = [
  ...[...KEYWORDS].map((label) => ({ label, type: "keyword" })),
  ...[...TYPES].map((label) => ({ label, type: "type" })),
  ...[...UNIFORMS].map((label) => ({ label, type: "variable" })),
  ...[...BUILTINS].map((label) => ({ label, type: "function" })),
];
let uniformSuggestions = [];

const completions = (ctx) => {
  const word = ctx.matchBefore(IDENT);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  const options = [...uniformSuggestions, ...VOCAB];
  options.sort((a, b) => a.label.localeCompare(b.label));
  return { from: word.from, options, validFor: IDENT };
};

// ── Diagnostics ───────────────────────────────────────────────────────────
// A pass that does not compile is reported by the driver as a line number; that line
// is marked in the gutter and tinted, and the message itself is listed by the pane,
// which is what can offer "Common, line 12" as somewhere to go.

class SeverityMarker extends GutterMarker {
  constructor(severity) { super(); this.severity = severity; }
  eq(other) { return other.severity === this.severity; }
  toDOM() {
    const dot = document.createElement("span");
    dot.className = `cm-gfx-dot cm-gfx-dot-${this.severity}`;
    dot.textContent = "●";
    return dot;
  }
}
const MARKERS = { error: new SeverityMarker("error"), warning: new SeverityMarker("warning") };
// the gutter dot is the whole mark for a warning: the schemes have one "wrong" colour and
// no separate "careful" one, and inventing a second would not survive a theme change
const LINE_CLASS = { error: "cm-gfx-line-error" };

const setDiagnostics = StateEffect.define();

const diagnose = (doc, list) => {
  const lines = [], marks = [];
  // the driver reports top to bottom, but a range set has to be built in position order
  const sorted = [...list]
    .filter((d) => Number.isInteger(d.line) && d.line >= 1 && d.line <= doc.lines)
    .sort((a, b) => a.line - b.line);
  for (const d of sorted) {
    const severity = d.severity === "warning" ? "warning" : "error";
    const at = doc.line(d.line).from;
    if (LINE_CLASS[severity]) lines.push(Decoration.line({ class: LINE_CLASS[severity] }).range(at));
    marks.push(MARKERS[severity].range(at));
  }
  return { lines: Decoration.set(lines, true), marks: RangeSet.of(marks, true), list: sorted };
};

const EMPTY = { lines: Decoration.none, marks: RangeSet.empty, list: [] };

const diagnosticsField = StateField.define({
  create: () => EMPTY,
  update(value, tr) {
    // a decoration set survives edits by mapping through them, so a mark follows the
    // line it was put on while the player types, until the next compile replaces it
    let next = { lines: value.lines.map(tr.changes), marks: value.marks.map(tr.changes), list: value.list };
    for (const effect of tr.effects) if (effect.is(setDiagnostics)) next = diagnose(tr.state.doc, effect.value);
    return next;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.lines),
});

const severityGutter = gutter({
  class: "cm-gfx-gutter",
  markers: (view) => view.state.field(diagnosticsField).marks,
  initialSpacer: () => MARKERS.error,
});

// ── Theme ─────────────────────────────────────────────────────────────────
// The app's editor theme (app/src/editor.js), for the reasons its comments give:
// every colour is a theme key, so a scheme change and the opacity fade take the
// shader pane with them. The sizes differ -- a shader pane is a strip, not the page's
// main editor -- and follow the pane's own variables.

const v = (k) => `var(--${k})`;
const editorTheme = EditorView.theme({
  "&": { color: v("DefaultForeground"), backgroundColor: v("Background"), height: "100%", fontSize: "var(--gfx-editor-font-size, 14px)" },
  ".cm-scroller": { fontFamily: "var(--code-font)", lineHeight: "1.5" },
  ".cm-content": { caretColor: v("CaretForeground"), padding: "6px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeft: `2px solid ${v("CaretForeground")}` },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: v("selectionWash") },
  ".cm-activeLine": { backgroundColor: v("CaretLineBackground") },
  ".cm-gutters": { backgroundColor: v("MarginBackground"), color: v("gutterText"), border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 0.5em 0 1em", fontStyle: "italic" },
  ".cm-activeLineGutter": { backgroundColor: v("CaretLineBackground"), color: v("WindowForeground") },
  "&.cm-focused .cm-matchingBracket": { color: v("MatchedBraceForeground"), backgroundColor: v("MatchedBraceBackground") },
  ".cm-gfx-gutter": { width: "0.9em" },
  ".cm-gfx-dot": { fontSize: "0.8em", lineHeight: "1.6" },
  // ErrorBackground is the app's own "this is wrong" colour (the score clash marks); the
  // line is tinted with it rather than filled, the way those are, so the text stays legible
  // at any opacity. Cards and the score use mixed colours here, so color-mix is the idiom.
  ".cm-gfx-dot-error": { color: v("ErrorBackground") },
  ".cm-gfx-dot-warning": { color: v("mutedForeground") },
  ".cm-gfx-line-error": { backgroundColor: `color-mix(in srgb, ${v("ErrorBackground")} 16%, transparent)` },
  // a completion popup is a card of the app's, not CodeMirror's: theme.js keeps raisedSurface for exactly this
  ".cm-tooltip": { backgroundColor: v("raisedSurface"), border: `1px solid ${v("WindowBorder")}`, color: v("WindowForeground") },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: v("HighlightedBackground"), color: v("accentContrastText") },
  ".cm-panels": { backgroundColor: v("PaneBackground"), color: v("WindowForeground") },
});

// ── The editor ────────────────────────────────────────────────────────────

const PASS_EXTENSIONS = [
  lineNumbers(), severityGutter, highlightActiveLineGutter(), highlightSpecialChars(),
  history(), drawSelection(), dropCursor(), EditorState.allowMultipleSelections.of(true),
  EditorView.lineWrapping, bracketMatching(), closeBrackets(), rectangularSelection(), crosshairCursor(),
  highlightActiveLine(), highlightSelectionMatches(), autocompletion({ override: [completions], activateOnTyping: true }),
  indentUnit.of("  "), EditorState.tabSize.of(2), tooltips({ position: "absolute" }),
];

/**
 * The editor, over a set of named passes. One CodeMirror view, one *state* per pass:
 * swapping states is what keeps each pass's undo history, selection and diagnostics
 * its own, the way the app's own editor keeps a state per buffer.
 *
 * @param {{parent: Element, onCompile?: () => void, onDirty?: (pass: string, dirty: boolean) => void}} init
 */
export function createShaderEditor({ parent, onCompile, onDirty }) {
  const states = new Map();     // pass name → EditorState (its undo with it)
  const scrolls = new Map();    // pass name → scrollTop, so a tab switch comes back where it was
  const dirty = new Set();
  let shown = null;

  const extensions = [
    ...PASS_EXTENSIONS, editorTheme, highlighting,
    keymap.of([
      ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap,
      indentWithTab,
      // Compile. NOT Alt-Enter, which is the shader toy convention: in THIS app Alt-Enter and
      // Ctrl-Enter are both Run, and the app's dispatcher listens on document in the CAPTURE phase and
      // stops the event there -- so a shader editor bound to either of them would run the player's
      // Sonic Pi code instead of compiling, and never see the key at all. Measured, not guessed:
      // node -e "...shortcuts.js..." says Run owns Alt-Enter and Ctrl-Enter in all three keymaps.
      // Shift-Ctrl-Enter (Shift-Mod-Enter on a Mac) is free in all three and no browser wants it.
      { key: "Shift-Ctrl-Enter", run: () => (onCompile?.(), true) },
      { key: "Shift-Mod-Enter", run: () => (onCompile?.(), true) },
    ]),
    diagnosticsField,
    EditorView.updateListener.of((u) => {
      if (u.docChanged && shown) {
        const was = dirty.has(shown);
        dirty.add(shown);
        if (!was) onDirty?.(shown, true);
      }
    }),
  ];

  const makeState = (doc) => EditorState.create({ doc, extensions });

  const view = new EditorView({ parent, state: makeState("") });

  /** Put what is on screen away, under the name it is filed as. */
  const keep = () => {
    if (!shown) return;
    states.set(shown, view.state);
    scrolls.set(shown, view.scrollDOM.scrollTop);
  };

  // Every pass has a state whether or not its tab has been opened: a compile report can
  // name a pass the player has never looked at, and the pane hands every pass's text over
  // when a document is loaded. Asking for one that was never made makes it empty.
  const ensure = (name) => {
    let state = states.get(name);
    if (state) return { state, created: false };
    state = makeState("");
    states.set(name, state);
    return { state, created: true };
  };

  // The shown pass's state is the view's, and the one filed under its name is only what it was
  // when the pass was last put away. Reading the file rather than the view would answer with the
  // text and the diagnostics of some earlier keystroke -- and, if the file were empty, writing
  // to it would throw the player's text away.
  const at = (name) => (name === shown ? view.state : states.get(name)) ?? null;

  const replace = (name, next) => { if (name === shown) view.setState(next); else states.set(name, next); };

  // every pass there is, the one on screen included: it is not in the file while it is being edited
  const names = () => new Set([...states.keys(), ...(shown ? [shown] : [])]);

  const editor = {
    /** Show a pass. `seed` is its text the first time it is shown, and no other time: a pass
     *  the player has emptied stays empty, however it comes to be shown again. */
    show(name, seed) {
      if (name === shown) return;
      keep();
      const { state, created } = ensure(name);
      const next = created && seed !== undefined ? makeState(seed) : state;
      shown = name;
      states.set(name, next);
      view.setState(next);
      view.scrollDOM.scrollTop = scrolls.get(name) ?? 0;
    },

    /** A pass's text, wherever it is. */
    code: (name) => at(name)?.doc.toString() ?? "",

    /** Replace a pass's text wholesale (a file imported, an example loaded). Out of
     *  history: undo should step back over edits, not over a whole file. */
    setCode(name, text) {
      const base = name === shown ? view.state : ensure(name).state;
      replace(name, base.update({ changes: { from: 0, to: base.doc.length, insert: text }, annotations: Transaction.addToHistory.of(false) }).state);
    },

    /** Drop a pass entirely (a document that no longer has a Common block). Forgetting the pass
     *  on screen leaves the editor empty, rather than showing text that is nobody's any more. */
    forget(name) {
      states.delete(name);
      scrolls.delete(name);
      dirty.delete(name);
      if (name === shown) { shown = null; view.setState(makeState("")); }
    },

    isDirty: (name) => dirty.has(name),
    markClean(name) { if (dirty.delete(name)) onDirty?.(name, false); },
    markAllClean() { for (const name of [...dirty]) editor.markClean(name); },
    dirtyPasses: () => [...dirty],

    /** A pass's diagnostics: [{line, message, severity}], lines relative to its own first. */
    report(name, list) {
      const base = name === shown ? view.state : ensure(name).state;
      replace(name, base.update({ effects: setDiagnostics.of(list ?? []) }).state);
    },

    readReport: (name) => at(name)?.field(diagnosticsField).list ?? [],

    clearReports() { for (const name of names()) editor.report(name, []); },

    /** Go to a line of a pass, and put the caret on it. */
    jumpTo(name, line) {
      editor.show(name);
      const state = view.state;
      const at_ = state.doc.line(Math.min(Math.max(line, 1), state.doc.lines));
      view.dispatch({ selection: { anchor: at_.from }, effects: EditorView.scrollIntoView(at_.from, { y: "center" }), scrollIntoView: false });
      view.focus();
    },

    setUniformNames(names) { uniformSuggestions = [...new Set(names)].map((label) => ({ label, type: "variable", detail: "uniform" })); },
    focus: () => view.focus(),
    /** The pane was hidden and shown again: CodeMirror measures what it could not see. */
    refresh: () => view.requestMeasure(),
    element: view.dom,
    destroy() { view.destroy(); states.clear(); },
  };

  return editor;
}
