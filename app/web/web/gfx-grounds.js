// SPDX-License-Identifier: AGPL-3.0-or-later
// Fading the interface so the picture shows through -- at the level of the theme's own colours.
//
// ── Why it is done this way, and not with CSS selectors ─────────────────────────────────────────
//
// The first attempt wrote rules like `html.gfx-on #editor-column { background: color-mix(…) }`. It
// looked right and did almost nothing where it mattered, because the code -- the thing the player is
// staring at -- does not get its background from #editor-column. CodeMirror paints it itself, INLINE,
// from the theme's token:
//
//     editor.js:644   const v = (k) => `var(--${k})`
//     editor.js:646   "&": { color: v("DefaultForeground"), backgroundColor: v("Background"), … }
//     editor.js:654   ".cm-gutters": { backgroundColor: v("MarginBackground"), … }
//
// An inline style on .cm-editor beats any rule on an ancestor. So lowering the opacity faded the
// toolbar, the sidebar and the seams and left the editor opaque: a grey rim, which is exactly what
// the player reported seeing.
//
// The fix is to stop naming surfaces and fade the GROUND COLOURS they are all made of. `--Background`
// is what CodeMirror's inline style says; redefining the token reaches every user of it at once,
// inline styles included. And because only the ground tokens change, the text colours do not -- so
// the picture comes through the interface while the live code stays legible on top.
//
// ── What counts as a ground ─────────────────────────────────────────────────────────────────────
//
// Grounds, from the theme (web/theme/themes.json) and style.css's use of them:
//
//   --Background            the editor and #editor-column: the largest area there is
//   --WindowBackground      body, #toolbar, #site-nav
//   --PaneBackground        #sidebar, #info-card, .ic-body, the editor's own panels
//   --MarginBackground      the editor's gutters
//   --CaretLineBackground   the caret's line -- OPAQUE in the theme, so without it a fade leaves one
//                           solid stripe across the code, which reads as a rendering bug
//
// Marks, left alone on purpose: --HighlightedBackground (the accent -- buttons, the active tab,
// markers; 62 uses), --SelectionBackground, --subtleFill, --accentTint*, --surface*, --raisedSurface.
// Fading those would wash out the interface's signals rather than reveal anything.
//
// ── How the writing is done ─────────────────────────────────────────────────────────────────────
//
// On <html>, inline, because that is where the theme writes: theme.js does
// `root.setProperty(\`--${key}\`, …)` for every colour of the scheme. Our writes carry a signature
// (`color-mix(in srgb`), which is how `watch` tells its own writing from the theme's -- a theme
// switch rewrites the tokens inline, and the fade has to follow it or it is silently lost. The
// theme's own colours are kept in `colours`, so `clear()` can put them back exactly.

export const GROUNDS = ["Background", "WindowBackground", "PaneBackground", "MarginBackground", "CaretLineBackground"];

/** Our own signature in a value: tells our writing from the theme's. */
const OURS = "color-mix(in srgb";
const isOurs = (v) => v.trim().startsWith(OURS);

/**
 * @param {{doc?: Document, tokens?: string[]}} opts
 * @returns {{colours: Map<string,string>, capture(): void, apply(pct: number): void, clear(): void,
 *            watch(onChange: Function): void}}
 */
export function createGrounds({ doc = document, tokens = GROUNDS } = {}) {
  const html = doc.documentElement;
  const colours = new Map();          // token -> the colour the theme chose

  /**
   * Read the theme's own colours. The inline value wins when it is not ours -- after a theme switch
   * that is the theme's fresh colour; before we have written anything it is simply the theme's.
   */
  function capture() {
    const computed = doc.defaultView.getComputedStyle(html);
    for (const token of tokens) {
      const inline = html.style.getPropertyValue(`--${token}`);
      const value = inline && !isOurs(inline) ? inline.trim() : computed.getPropertyValue(`--${token}`).trim();
      if (value && !isOurs(value)) colours.set(token, value);
    }
    // the panel is our own furniture and has to stay readable over the picture, so it is told the
    // ground's real colour rather than reading a faded one
    const ground = colours.get("Background");
    if (ground) html.style.setProperty("--gfx-opaque-ground", ground);
  }

  /** `pct` is what stays: 100 is the theme as it is, 0 leaves none of the ground colour at all. */
  function apply(pct) {
    for (const [token, base] of colours) {
      html.style.setProperty(`--${token}`, `color-mix(in srgb, ${base} ${pct}%, transparent)`);
    }
  }

  /** Put the theme's colours back, unchanged. */
  function clear() {
    for (const [token, base] of colours) html.style.setProperty(`--${token}`, base);
  }

  /**
   * Follow the theme. It rewrites every token inline when it changes, and our own writes do too, so
   * the test is whether the tokens are still ours: if they are, this is either our own write or a
   * theme identical to the last one, and there is nothing to do.
   */
  function watch(onChange) {
    let queued = false;
    const observer = new doc.defaultView.MutationObserver(() => {
      if (queued) return;
      queued = true;
      doc.defaultView.requestAnimationFrame(() => {
        queued = false;
        if (tokens.every((t) => isOurs(html.style.getPropertyValue(`--${t}`)))) return;
        capture();
        onChange?.();
      });
    });
    observer.observe(html, { attributes: true, attributeFilter: ["style"] });
    return () => observer.disconnect();
  }

  return { colours, capture, apply, clear, watch };
}
