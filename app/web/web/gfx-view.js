// How the rendered picture is shown: a small preview, the whole window, or not at all.
//
// One floating button, on top of everything, cycles the three states:
//
//   1. preview    bottom right, a quarter of the window in each direction (25vw x 25vh)
//   2. fullscreen the whole window
//   3. hidden     the renderer keeps running; nothing is on screen
//
// Deliberately NOT a page mode. An earlier mechanism switched the whole page between "audio" and "shadertoy",
// hiding Sonic Pi's interface to make room -- and when that mode was restored after a reload it looked exactly
// like the audio UI had been destroyed. Twice. So: this only ever touches the canvas and its own button. Not
// one element of the app's interface is named here, in any state, and the renderer itself never stops -- hiding
// it is a display state, not a shutdown, so switching back is instant and any capture a script asks for still
// works.
export const VIEW_KEY = "sp-gfx-view";
export const PREVIEW = "preview";
export const FULL = "fullscreen";
export const HIDDEN = "hidden";
const ORDER = [PREVIEW, FULL, HIDDEN];

const STYLE = `
  body[data-gfx-view="preview"] #gfx-canvas {
    position: fixed !important; inset: auto 8px 8px auto !important;
    width: 25vw !important; height: 25vh !important; z-index: 95;
    border: 1px solid var(--WindowBorder); border-radius: 8px; box-shadow: 0 6px 24px rgb(0 0 0 / 35%);
  }
  body[data-gfx-view="fullscreen"] #gfx-canvas {
    position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 95;
    border: 0; border-radius: 0;
  }
  body[data-gfx-view="hidden"] #gfx-canvas { display: none !important; }

  #gfx-view-btn {
    position: fixed; top: 6px; right: 108px; z-index: 99;   /* the tab button sits to its right */
    display: flex; align-items: center; gap: 6px; padding: 4px 10px; cursor: pointer;
    border: 1px solid var(--WindowBorder); border-radius: 999px;
    background: color-mix(in srgb, var(--WindowBackground) 92%, transparent);
    color: var(--WindowForeground); font: 12px/1 system-ui, sans-serif;
  }
  #gfx-view-btn:hover { background: color-mix(in srgb, var(--WindowBackground) 80%, transparent); }
  #gfx-view-btn .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: .35; }
  #gfx-view-btn[data-view="preview"] .dot { opacity: 1; }
  #gfx-view-btn[data-view="fullscreen"] .dot { opacity: 1; background: #f80; }
  #gfx-view-btn[data-view="hidden"] .dot { opacity: .25; }
`;

export function createViewSwitch({ store = globalThis.localStorage ?? null, onChange = null } = {}) {
  const read = () => {
    try { const v = store?.getItem(VIEW_KEY); return ORDER.includes(v) ? v : PREVIEW; } catch { return PREVIEW; }
  };
  let view = read();

  if (!document.getElementById("gfx-view-style")) {
    const style = document.createElement("style");
    style.id = "gfx-view-style";
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  let el = document.getElementById("gfx-view-btn");
  if (!el) {
    el = document.createElement("button");
    el.id = "gfx-view-btn";
    el.type = "button";
    el.innerHTML = '<span class="dot"></span><span class="label">Graphics</span>';
    el.addEventListener("click", () => set(ORDER[(ORDER.indexOf(view) + 1) % ORDER.length]));
    document.body.appendChild(el);
  }
  const LABEL = { [PREVIEW]: "Graphics · preview", [FULL]: "Graphics · fullscreen", [HIDDEN]: "Graphics · hidden" };
  const TITLE = {
    [PREVIEW]: "the rendered picture, bottom right at a quarter of the window — click for fullscreen",
    [FULL]: "the rendered picture, whole window — click to hide it",
    [HIDDEN]: "the renderer is still running, nothing is shown — click for the small preview",
  };

  function paint() {
    document.body.dataset.gfxView = view;
    el.dataset.view = view;
    el.querySelector(".label").textContent = LABEL[view];
    el.title = TITLE[view];
    el.setAttribute("aria-label", `${LABEL[view]} (click to change)`);
  }
  function set(next) {
    if (!ORDER.includes(next)) return false;
    const changed = next !== view;
    view = next;
    try { store?.setItem(VIEW_KEY, view); } catch {}
    paint();
    if (changed) onChange?.(view);
    return true;
  }

  paint();
  return { el, view: () => view, set, next: () => set(ORDER[(ORDER.indexOf(view) + 1) % ORDER.length]), is: (v) => view === v };
}
