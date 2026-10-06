// The top-level switch: Sonic Pi and the graphics side, one or the other.
//
// The two halves of this app are separate things that happen to live in one page. Sonic Pi's chrome is a
// language, an editor, a mixer and a transport; ours is a picture with a shader behind it. Until now they were
// stacked on top of each other -- our canvas behind the interface, our panes in the app's drawer, our panel
// beside the app's -- which means neither could be arranged without disturbing the other.
//
// This is the first step of pulling them apart: a global switch, at the top, that puts the page in one mode at
// a time. `body[data-ui-mode="graphics"]` hides Sonic Pi's chrome and lets the picture be the whole window;
// `body[data-ui-mode="sonicpi"]` hides every piece of our UI. The switch itself is always there -- it is the
// way back -- and it stays out of the way in the opposite corner from the app's own controls.
//
// It is ours alone: no upstream file is touched to do any of this (the whole intrusion is still the two lines
// that load our layer). Everything here is a `data-` attribute, a style block and a button.
export const MODE_KEY = "sp-ui-mode";
export const SONIC_PI = "sonicpi";
export const GRAPHICS = "graphics";

/** Sonic Pi's own furniture: the parts that are not ours and that graphics mode puts away. */
const APP_CHROME = [
  "#toolbar", "#site-nav", "#main", "#statusbar", "#info-card", "#documentation",
  "#drawer", "#drawer-rail", "#drawer-panes", "#about-overlay", "#theme-menu",
];

/** Ours: everything graphics mode shows and Sonic Pi mode puts away. */
const OUR_UI = ["#gfx-hud", "#gfx-shader-pane", "#gfx-panel", "#gfx-testcard", "#gfx-say", "#gfx-install-error"];

const STYLE = `
  #gfx-mode-switch {
    position: fixed; top: 6px; left: 50%; transform: translateX(-50%); z-index: 99;
    display: flex; gap: 0; border: 1px solid var(--WindowBorder); border-radius: 999px; overflow: hidden;
    background: color-mix(in srgb, var(--WindowBackground) 92%, transparent);
    font: 12px/1 system-ui, sans-serif; pointer-events: auto;
  }
  #gfx-mode-switch button {
    border: 0; background: transparent; color: var(--WindowForeground); opacity: .65;
    padding: 5px 12px; cursor: pointer; font: inherit;
  }
  #gfx-mode-switch button[aria-pressed="true"] { opacity: 1; background: var(--HighlightBackground, #d53); color: #fff; }

  /* graphics: the picture is the window, and none of Sonic Pi's furniture is in it */
  body[data-ui-mode="graphics"] ${APP_CHROME.join(", body[data-ui-mode=\"graphics\"] ")} { display: none !important; }
  body[data-ui-mode="graphics"] #gfx-canvas { inset: 0 !important; width: 100vw !important; height: 100vh !important; }
  body[data-ui-mode="graphics"] #gfx-hud { display: block; }

  /* sonic pi: our canvas stays (it is the background), but every control of ours goes */
  body[data-ui-mode="sonicpi"] ${OUR_UI.filter((s) => s !== "#gfx-install-error").join(", body[data-ui-mode=\"sonicpi\"] ")} { display: none !important; }
`;

export function createModeSwitch({ store = globalThis.localStorage ?? null, onChange = null } = {}) {
  const read = () => {
    try { const v = store?.getItem(MODE_KEY); return v === GRAPHICS || v === SONIC_PI ? v : SONIC_PI; } catch { return SONIC_PI; }
  };
  let mode = read();

  if (!document.getElementById("gfx-mode-style")) {
    const style = document.createElement("style");
    style.id = "gfx-mode-style";
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  let el = document.getElementById("gfx-mode-switch");
  if (!el) {
    el = document.createElement("div");
    el.id = "gfx-mode-switch";
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", "Which half of the page to work in");
    for (const [value, label, title] of [
      [SONIC_PI, "Sonic Pi", "the language, the editor, the transport — our UI is out of the way"],
      [GRAPHICS, "Graphics", "the picture and the shader — Sonic Pi's furniture is out of the way"],
    ]) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.mode = value;
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", () => set(value));
      el.appendChild(b);
    }
    document.body.appendChild(el);
  }

  function paint() {
    document.body.dataset.uiMode = mode;
    for (const b of el.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  }
  function set(next) {
    if (next !== SONIC_PI && next !== GRAPHICS) return false;
    const changed = next !== mode;
    mode = next;
    try { store?.setItem(MODE_KEY, mode); } catch {}
    paint();
    if (changed) onChange?.(mode);
    return true;
  }

  paint();
  return { el, mode: () => mode, set, is: (m) => mode === m, toggle: () => set(mode === GRAPHICS ? SONIC_PI : GRAPHICS) };
}
