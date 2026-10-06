// Only the shader editor, back on its own -- no canvas, no render controls, nothing else of the layer.
//
// The render half of the layer is off (web/gfx.js: GFX_ENABLED = false) and this file does not import it: the
// editor is created on its own, with a compile that says the renderer is not there yet, so the code, the
// documents and the tabs can be worked on without the picture. That is deliberate -- the canvas comes back as
// its own piece, later.
//
// One button, floating above everything, at the right edge and halfway down. Click: the editor, full window.
// Click again, or Escape: gone, and the audio page is exactly as it was. Nothing is persisted, so a reload
// always lands on the audio page.
import { createShaderPane } from "./graphics/gfx-editor.js";

const STYLE = `
  #gfx-editor-btn {
    position: fixed; right: 0; top: 50%; transform: translateY(-50%); z-index: 99;
    writing-mode: vertical-rl; padding: 12px 6px; cursor: pointer;
    border: 1px solid var(--WindowBorder); border-right: 0; border-radius: 8px 0 0 8px;
    background: color-mix(in srgb, var(--WindowBackground) 92%, transparent);
    color: var(--WindowForeground); font: 12px/1 system-ui, sans-serif; letter-spacing: .04em;
  }
  #gfx-editor-btn:hover { background: color-mix(in srgb, var(--WindowBackground) 78%, transparent); }

  #gfx-editor-tab { position: fixed; inset: 0; z-index: 98; display: none; flex-direction: column;
    background: color-mix(in srgb, var(--WindowBackground) 96%, transparent); }
  body[data-gfx-editor="open"] #gfx-editor-tab { display: flex; }
  #gfx-editor-tab-head { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 6px 10px;
    border-bottom: 1px solid var(--WindowBorder); font: 13px/1.2 system-ui, sans-serif; color: var(--WindowForeground); }
  #gfx-editor-tab-head .name { font-weight: 600; }
  #gfx-editor-tab-head .hint { opacity: .65; font-size: 12px; }
  #gfx-editor-tab-head .spacer { flex: 1 1 auto; }
  #gfx-editor-tab-close { font: 12px/1 system-ui, sans-serif; color: var(--WindowForeground); cursor: pointer;
    background: color-mix(in srgb, var(--WindowBackground) 92%, transparent); border: 1px solid var(--WindowBorder);
    border-radius: 999px; padding: 4px 10px; }
  #gfx-editor-tab-body { flex: 1 1 auto; min-height: 0; display: flex; }
  #gfx-editor-tab-body > .gfx-ed { position: static !important; inset: auto !important; flex: 1 1 auto;
    margin: 8px; border-radius: 8px; }

  /* the editor is never on the audio page: hidden by rule while the tab is shut, and detached by script too */
  body:not([data-gfx-editor="open"]) #gfx-editor-tab { display: none !important; }
`;

export function createEditorTab({ log = null } = {}) {
  let pane = null, held = null, open = false;

  if (!document.getElementById("gfx-editor-style")) {
    const style = document.createElement("style");
    style.id = "gfx-editor-style";
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  const btn = document.createElement("button");
  btn.id = "gfx-editor-btn";
  btn.type = "button";
  btn.textContent = "Shadertoy";
  btn.title = "the shader editor (Ctrl/Cmd+Alt+S) — the picture is not wired up yet";
  btn.addEventListener("click", () => set(!open));
  document.body.appendChild(btn);

  const tab = document.createElement("div");
  tab.id = "gfx-editor-tab";
  tab.setAttribute("role", "dialog");
  tab.setAttribute("aria-label", "Shadertoy editor");
  tab.innerHTML = `<div id="gfx-editor-tab-head"><span class="name">Shadertoy</span>
    <span class="hint">the editor only — the render canvas is not wired up yet</span>
    <span class="spacer"></span><button id="gfx-editor-tab-close" type="button">Back to audio</button></div>
    <div id="gfx-editor-tab-body"></div>`;
  document.body.appendChild(tab);
  tab.querySelector("#gfx-editor-tab-close").addEventListener("click", () => set(false));
  const body = tab.querySelector("#gfx-editor-tab-body");

  function build() {
    if (pane) return pane;
    try {
      pane = createShaderPane({
        // no renderer in this piece: compiling says so instead of failing silently
        compile: async () => {
          const message = "the render canvas is not wired up yet — the code is safe, nothing was drawn";
          log?.(message);
          return { ok: false, error: message };
        },
        canvas: () => null,
        starter: "// Shadertoy-style shader\n// the editor works now; the picture comes back as its own piece\nvoid mainImage(out vec4 c, in vec2 p) {\n    c = vec4(p.x, p.y, 0.5, 1.0);\n}\n",
      });
      held = pane.el ?? pane.el_ ?? document.getElementById("gfx-shader-pane");
      if (held) { held.remove(); body.appendChild(held); }        // ours, in our tab, not in the app's drawer
      for (const sel of ['#drawer-rail [data-drawer="gfx-shader"]']) document.querySelector(sel)?.remove();
    } catch (e) {
      log?.(`the editor could not be built: ${e?.message ?? e}`);
    }
    return pane;
  }

  function set(next) {
    if (next === open) return false;
    open = next;
    document.body.dataset.gfxEditor = open ? "open" : "closed";
    if (open) build();
    else if (held?.parentElement) held.remove();                  // out of the document, not into the drawer
    return true;
  }

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === "s" || e.key === "S")) {
      e.preventDefault(); e.stopPropagation(); set(!open);
    } else if (open && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); set(false); }
  }, true);

  document.body.dataset.gfxEditor = "closed";
  return { button: btn, el: tab, open: () => open, set, toggle: () => set(!open) };
}
