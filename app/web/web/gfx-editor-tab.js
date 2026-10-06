// The Shadertoy tab: the ORIGINAL pane, in a tab of its own, on our canvas.
//
// The document mechanism is not reimplemented here. It is graphics/gfx-document.js and graphics/gfx-editor.js --
// passes, Common as the document's own field, four channels per document, the version-1-to-2 migration, images
// that are asked for again rather than kept in storage, the set serialisation and the import/export format. That
// all exists and works; this file is only the shell the player asked for: a button at the right edge, halfway
// down, and a full-window tab holding that pane, wired to the render canvas:
//
//   compile(document) -> canvasView.setPasses(...)   and back: { ok, failures, compiled }
//   canvas            -> the canvas view itself (its `usable` is the uniform names the pane offers)
//
// Nothing else of ours is on the audio page: the button.
import { createShaderPane } from "./graphics/gfx-editor.js";

const STYLE = `
  #gfx-editor-btn { position: fixed; right: 0; top: 50%; transform: translateY(-50%); z-index: 101;
    writing-mode: vertical-rl; padding: 12px 6px; cursor: pointer; font: 12px/1 system-ui, sans-serif;
    letter-spacing: .04em; color: var(--WindowForeground); border: 1px solid var(--WindowBorder); border-right: 0;
    border-radius: 8px 0 0 8px; background: color-mix(in srgb, var(--WindowBackground) 92%, transparent); }
  #gfx-editor-btn:hover { background: color-mix(in srgb, var(--WindowBackground) 78%, transparent); }

  #gfx-editor-tab { position: fixed; inset: 0; z-index: 99; display: none; flex-direction: column;
    background: var(--WindowBackground); color: var(--WindowForeground); }
  body[data-gfx-editor="open"] #gfx-editor-tab { display: flex; }
  #gfx-editor-tab-head { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 6px 10px;
    border-bottom: 1px solid var(--WindowBorder); font: 13px/1.2 system-ui, sans-serif; }
  #gfx-editor-tab-head .name { font-weight: 600; }
  #gfx-editor-tab-head .hint { opacity: .6; font-size: 12px; }
  #gfx-editor-tab-head .spacer { flex: 1 1 auto; }
  #gfx-editor-tab-close { font: 12px/1 system-ui, sans-serif; color: var(--WindowForeground); cursor: pointer;
    background: color-mix(in srgb, var(--WindowBackground) 92%, transparent); border: 1px solid var(--WindowBorder);
    border-radius: 999px; padding: 4px 10px; }
  #gfx-editor-tab-body { flex: 1 1 auto; min-height: 0; display: flex; }
  /* it is a DRAWER pane, so the drawer's rules hide it (measured: display none, 0x0, inside our tab) -- here it
     is the tab's whole body, and it has to lay itself out at full height */
  body[data-gfx-editor="open"] #gfx-editor-tab-body > #gfx-shader-pane {
    display: flex !important; flex: 1 1 auto; height: 100% !important; min-height: 0;
    position: static !important; inset: auto !important; width: auto !important; margin: 0; border-radius: 0;
    border: 0;
  }
  body[data-gfx-editor="open"] #gfx-editor-tab-body > #gfx-shader-pane > * { min-height: 0; }
  body:not([data-gfx-editor="open"]) #gfx-editor-tab { display: none !important; }
`;

export function createEditorTab({ canvasView = null, log = null } = {}) {
  if (!document.getElementById("gfx-editor-tab-style")) {
    const style = document.createElement("style");
    style.id = "gfx-editor-tab-style";
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  const btn = document.createElement("button");
  btn.id = "gfx-editor-btn";
  btn.type = "button";
  btn.textContent = "Shadertoy";
  btn.title = "the shader editor (Ctrl/Cmd+Alt+S)";
  btn.addEventListener("click", () => set(!open));
  document.body.appendChild(btn);

  const tab = document.createElement("div");
  tab.id = "gfx-editor-tab";
  tab.setAttribute("role", "dialog");
  tab.setAttribute("aria-label", "Shadertoy editor");
  tab.innerHTML = `<div id="gfx-editor-tab-head"><span class="name">Shadertoy</span>
    <span class="hint">documents, passes and channels — the picture is on the canvas, above</span>
    <span class="spacer"></span><button id="gfx-editor-tab-close" type="button">Back to audio</button></div>
    <div id="gfx-editor-tab-body"></div>`;
  document.body.appendChild(tab);
  tab.querySelector("#gfx-editor-tab-close").addEventListener("click", () => set(false));
  const body = tab.querySelector("#gfx-editor-tab-body");

  let pane = null;
  function build() {
    if (pane) return pane;
    try {
      pane = createShaderPane({
        // the pane hands us the document it has; the canvas wants passes and channels
        compile: (doc) => {
          const r = canvasView?.setPasses?.({ Common: doc?.common ?? "", ...(doc?.passes ?? {}) }, doc?.channels ?? [])
            ?? { ok: [], failed: [] };
          return { ok: r.failed.length === 0 && r.ok.length > 0, failures: r.failed, compiled: r.ok };
        },
        canvas: () => canvasView,
        log: (t) => log?.(t),
        onCompiled: () => { try { pane?.uniformsChanged?.(); } catch {} },
      });
      const el = pane?.el ?? document.querySelector(".gfx-ed");
      if (el) { el.remove(); body.appendChild(el); }        // ours, in our tab -- not in the app's drawer
      for (const sel of ['#drawer-rail [data-drawer="gfx-shader"]']) document.querySelector(sel)?.remove();
    } catch (e) {
      log?.(`the editor could not be built: ${e?.stack ?? e}`);
      console.error(`Shadertoy — the editor could not be built: ${e?.stack ?? e}`);
    }
    return pane;
  }

  let open = false;
  function set(next) {
    if (next === open) return false;
    open = next;
    document.body.dataset.gfxEditor = open ? "open" : "closed";
    if (open) { build(); pane?.refresh?.(); }
    else pane?.el?.remove();                                // out of the document, never into the drawer
    return true;
  }
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === "s" || e.key === "S")) { e.preventDefault(); e.stopPropagation(); set(!open); }
    else if (open && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); set(false); }
  }, true);

  document.body.dataset.gfxEditor = "closed";
  return { el: tab, button: btn, open: () => open, set, toggle: () => set(!open), pane: () => pane };
}
