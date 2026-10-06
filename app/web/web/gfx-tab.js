// The Shadertoy tab: our editor and its UI, on a surface of our own, over the audio page rather than instead
// of it.
//
// A button switches between the two. The tab is a full-window overlay WE own -- the editor pane, the settings
// panel and the picture all live inside it -- and Sonic Pi's interface is COVERED, never hidden: not one element
// of the app is named in any rule here, in either state. That distinction is the whole lesson of the two earlier
// attempts: a mechanism that hides the app's own interface can leave a page that looks destroyed, and if it is
// restored after a reload there is no way back. Covering cannot do that -- close the tab, or reload, and the
// audio page is exactly as it was.
//
// Entering the tab puts the render in fullscreen behind the editor (it is a preview, that is the point); leaving
// restores whatever display state the render was in before.
import { createViewSwitch, FULL } from "./gfx-view.js";

const STYLE = `
  #gfx-tab { position: fixed; inset: 0; z-index: 98; display: none; flex-direction: column;
    background: color-mix(in srgb, var(--WindowBackground) 92%, transparent); backdrop-filter: blur(3px); }
  body[data-gfx-tab="open"] #gfx-tab { display: flex; }
  body[data-gfx-tab="open"] #gfx-canvas { z-index: 97; }

  #gfx-tab-head { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 6px 10px;
    border-bottom: 1px solid var(--WindowBorder); font: 13px/1.2 system-ui, sans-serif; color: var(--WindowForeground); }
  #gfx-tab-head .name { font-weight: 600; }
  #gfx-tab-head .hint { opacity: .65; font-size: 12px; }
  #gfx-tab-head .spacer { flex: 1 1 auto; }
  #gfx-tab-close, #gfx-tab-btn { font: 12px/1 system-ui, sans-serif; color: var(--WindowForeground);
    background: color-mix(in srgb, var(--WindowBackground) 92%, transparent); border: 1px solid var(--WindowBorder);
    border-radius: 999px; padding: 4px 10px; cursor: pointer; }
  #gfx-tab-body { flex: 1 1 auto; min-height: 0; display: flex; }
  #gfx-tab-body > #gfx-shader-pane { position: static !important; inset: auto !important; width: min(52vw, 860px) !important;
    height: auto !important; margin: 8px; border-radius: 8px; }
  #gfx-tab-body > #gfx-ext { position: static !important; inset: auto !important; width: min(30vw, 420px) !important;
    height: auto !important; margin: 8px 0 8px 8px; border-radius: 8px; }
  #gfx-tab-btn { position: fixed; top: 6px; right: 6px; z-index: 99; }
  body[data-gfx-tab="open"] #gfx-tab-btn { position: static; }
`;

export function createShadertoyTab({ store = globalThis.localStorage ?? null, viewSwitch = null, onChange = null } = {}) {
  if (!document.getElementById("gfx-tab-style")) {
    const style = document.createElement("style");
    style.id = "gfx-tab-style";
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  const home = { pane: null, ext: null, view: null };
  let open = false;

  // the toggle that lives on the audio page
  let btn = document.getElementById("gfx-tab-btn");
  if (!btn) {
    btn = document.createElement("button");
    btn.id = "gfx-tab-btn";
    btn.type = "button";
    btn.textContent = "Shadertoy";
    btn.title = "the shader editor, in a tab of its own (Ctrl/Cmd+Alt+S)";
    btn.addEventListener("click", () => set(!open));
    document.body.appendChild(btn);
  }

  let tab = document.getElementById("gfx-tab");
  if (!tab) {
    tab = document.createElement("div");
    tab.id = "gfx-tab";
    tab.setAttribute("role", "dialog");
    tab.setAttribute("aria-label", "Shadertoy editor");
    tab.innerHTML = `<div id="gfx-tab-head"><span class="name">Shadertoy</span>
      <span class="hint">the shader editor and its settings; the picture runs fullscreen behind this</span>
      <span class="spacer"></span><button id="gfx-tab-close" type="button">Back to audio</button></div>
      <div id="gfx-tab-body"></div>`;
    document.body.appendChild(tab);
    tab.querySelector("#gfx-tab-close").addEventListener("click", () => set(false));
  }
  const body = tab.querySelector("#gfx-tab-body");

  /** Give an element to the tab, remembering where it came from so it can go home. */
  function take(sel, key) {
    const el = document.querySelector(sel);
    if (!el) return;
    if (el.parentElement !== body) {
      if (!home[key]) home[key] = { parent: el.parentElement, next: el.nextSibling };
      body.appendChild(el);
    }
  }
  function give(key) {
    const el = key === "pane" ? document.getElementById("gfx-shader-pane") : document.getElementById("gfx-ext");
    const h = home[key];
    if (!el || !h?.parent) return;
    if (el.parentElement === h.parent) return;
    h.parent.insertBefore(el, h.next?.parentElement === h.parent ? h.next : null);
    home[key] = null;
  }

  function paint() {
    document.body.dataset.gfxTab = open ? "open" : "closed";
    btn.textContent = open ? "Audio" : "Shadertoy";
    btn.title = open ? "back to the audio page (Ctrl/Cmd+Alt+S)" : "the shader editor, in a tab of its own (Ctrl/Cmd+Alt+S)";
    if (open) {
      take("#gfx-shader-pane", "pane");
      take("#gfx-ext", "ext");
      viewSwitch?.set?.(FULL);                       // the picture fills the window behind the editor
    } else {
      give("pane");
      give("ext");
      if (home.view) { viewSwitch?.set?.(home.view); home.view = null; }
    }
  }

  function set(next) {
    if (next === open) return false;
    if (next) home.view = viewSwitch?.view?.() ?? null;
    open = next;
    paint();
    onChange?.(open);
    return true;
  }

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === "s" || e.key === "S")) {
      e.preventDefault(); e.stopPropagation(); set(!open);
    } else if (open && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); set(false); }
  }, true);

  paint();
  return { el: tab, button: btn, open: () => open, set, toggle: () => set(!open) };
}
