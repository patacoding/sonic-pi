// SPDX-License-Identifier: AGPL-3.0-or-later
// The extension panel: one place at the top for everything we add to the interface.
//
// Sonic Pi's own interface is upstream's and we do not edit it. What we add is injected: a button at
// the right-hand end of the toolbar, and a panel that slides in from the right of the screen. This
// file is the shell for that, and the only shell -- a feature does not draw its own furniture, it
// hands this file a section:
//
//     createPanel({ sections: [{ id, title, items: [...] }] })
//
// and an item is one of
//
//     { kind: "heading", text }
//     { kind: "slider",  label, min, max, step, value, format, onInput }
//     { kind: "switch",  label, value, onChange }
//     { kind: "button",  label, onClick, title }
//     { kind: "note",    text }
//     { kind: "list",    label, items }              // e.g. the shader's uniforms
//     { kind: "custom",  make: () => Node }
//
// WHY the markup is the app's own classes. `.pref-row`, `.switch`, `.seg` and `.sp-mini-btn` are
// global in style.css (the theme menu builds rows with them too), and every colour here comes from a
// theme variable -- so the panel is painted by whatever theme is showing, in the app's own idiom,
// without either of us knowing about the other. `rebuild()` re-renders from the same spec, which is
// how a section whose contents change (a list of uniforms) keeps up.
//
// The z-index is 96 on purpose. The app's scale, read off style.css: content 1–5, #info-card 90,
// the phone's page strip 95, the modal overlays (#about-overlay, #resume-overlay, #install-overlay)
// 100, the pop menus (#theme-menu, #share-menu, #sets-menu) 400, toasts above that. So 96 puts the
// panel over the app and over a site page, and still under anything modal -- a dialog should win.

const STYLE_ID = "gfx-ui-style";

const el = (tag, cls = "", text = null) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function style() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
/* the way in: the last control on the toolbar, so it sits at the top right of the controls */
#gfx-ext-btn { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 30px; height: 30px;
  padding: 0; border: none; border-radius: var(--r-s); background: none; color: var(--WindowForeground); cursor: pointer; }
#gfx-ext-btn:hover { color: var(--HoverButton); }
#gfx-ext-btn.on { color: var(--HighlightedBackground); }
#gfx-ext-btn svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

/* the panel itself. Its ground is --gfx-opaque-ground, not --pop-bg: --pop-bg resolves to
   --Background, and gfx.js fades that so the picture shows through the app. Our own furniture has to
   stay readable over the picture, so it keeps the ground's real colour (and falls back to --pop-bg
   when the canvas is off and nothing is being faded). */
#gfx-ext { position: fixed; top: 0; right: 0; height: 100dvh; width: min(340px, 92vw); z-index: 96;
  display: flex; flex-direction: column; box-sizing: border-box;
  background: var(--gfx-opaque-ground, var(--pop-bg)); border-left: var(--pop-border); box-shadow: var(--pop-shadow);
  color: var(--WindowForeground); font: var(--t-ui) var(--prose-font);
  transform: translateX(101%); transition: transform 0.18s ease; }
#gfx-ext.on { transform: none; }
body.reduce-motion #gfx-ext { transition: none; }

#gfx-ext-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px 8px 12px; border-bottom: 1px solid var(--WindowBorder); flex: none; }
#gfx-ext-head h2 { flex: 1; margin: 0; font-size: var(--t-label); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--mutedForeground); }
#gfx-ext-close { width: 24px; height: 24px; padding: 0; border: none; border-radius: var(--r-s); background: none; color: var(--faintText); cursor: pointer; font: inherit; line-height: 1; }
#gfx-ext-close:hover { color: var(--WindowForeground); background: var(--subtleFill); }

#gfx-ext-body { flex: 1; min-height: 0; overflow: auto; padding: 10px 14px 16px; }
#gfx-ext-body h3 { margin: 14px 0 6px; font-size: var(--t-label); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--mutedForeground); }
#gfx-ext-body h3:first-child { margin-top: 2px; }
#gfx-ext-body .gfx-note { margin: 6px 0; color: var(--mutedForeground); font-size: var(--t-tiny); line-height: 1.5; }
#gfx-ext-body .gfx-list { margin: 4px 0 4px; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 4px; }
#gfx-ext-body .gfx-list li { padding: 1px 7px; border: 1px solid var(--WindowBorder); border-radius: var(--r-s); font: var(--t-tiny) var(--code-font); color: var(--softForeground); }
#gfx-ext-body .gfx-list:empty::after { content: "none"; color: var(--faintText); font-size: var(--t-tiny); }
#gfx-ext-body .gfx-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 2px; }
#gfx-ext-body .pref-row { margin: 6px 0; }
#gfx-ext-body .pref-row > span:first-child { flex-basis: 7em; }
`;
  document.head.appendChild(s);
}

/** The icon: three sliders, the same family as the app's own glyphs. */
function icon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of [
    "M4 8a2 2 0 1 0 4 0a2 2 0 0 0 -4 0", "M6 2v4", "M6 10v12",
    "M10 16a2 2 0 1 0 4 0a2 2 0 0 0 -4 0", "M12 2v12", "M12 18v4",
    "M16 6a2 2 0 1 0 4 0a2 2 0 0 0 -4 0", "M18 2v2", "M18 8v14",
  ]) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  return svg;
}

/** One item of a section, as the app's own control markup. */
function renderItem(item) {
  switch (item.kind) {
    case "heading":
      return el("h3", "", item.text);

    case "note":
      return el("p", "gfx-note", item.text);

    case "list": {
      const wrap = el("div");
      wrap.appendChild(el("p", "gfx-note", item.label));
      const ul = el("ul", "gfx-list");
      for (const one of item.items ?? []) ul.appendChild(el("li", "", one));
      wrap.appendChild(ul);
      return wrap;
    }

    case "slider": {
      // the preferences' own row (main.js os): label, range, value
      const row = el("label", "pref-row");
      if (item.title) row.title = item.title;
      const input = el("input");
      Object.assign(input, { type: "range", min: item.min, max: item.max, step: item.step ?? 1, value: item.value });
      input.setAttribute("aria-label", item.label);
      const show = item.format ?? ((v) => String(v));
      const value = el("span", "pref-val", show(Number(input.value)));
      input.addEventListener("input", () => {
        value.textContent = show(Number(input.value));
        item.onInput?.(Number(input.value));
      });
      row.append(el("span", "", item.label), input, value);
      return row;
    }

    case "switch": {
      // the preferences' own switch (main.js kt), including the role and aria-checked it uses
      const row = el("div", "pref-row");
      const button = el("button", `switch${item.value ? " on" : ""}`);
      button.type = "button";
      button.setAttribute("role", "switch");
      button.setAttribute("aria-checked", String(!!item.value));
      if (item.title) button.title = item.title;
      button.append(el("span", "track"), el("span", "", item.label));
      button.addEventListener("click", () => {
        const on = !button.classList.contains("on");
        button.classList.toggle("on", on);
        button.setAttribute("aria-checked", String(on));
        item.onChange?.(on);
      });
      row.appendChild(button);
      return row;
    }

    case "button": {
      const wrap = el("div", "gfx-actions");
      const button = el("button", "sp-mini-btn", item.label);
      button.type = "button";
      if (item.title) button.title = item.title;
      button.addEventListener("click", () => item.onClick?.(button));
      wrap.appendChild(button);
      return wrap;
    }

    case "custom":
      return item.make();

    default:
      return el("p", "gfx-note", `(unknown item kind: ${item.kind})`);
  }
}

/**
 * Build the panel and its way in.
 *
 * @param {{title?: string, sections?: Array, mount?: Element|null, onOpen?: Function, onClose?: Function}} opts
 * @returns {{el, button, open(), close(), toggle(), rebuild(sections?), isOpen}}
 */
export function createPanel({ title = "Extensions", sections = [], mount = null, onOpen, onClose } = {}) {
  style();

  const button = el("button");
  button.id = "gfx-ext-btn";
  button.type = "button";
  button.title = `${title} — our own controls`;
  button.setAttribute("aria-label", title);
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "gfx-ext");
  button.appendChild(icon());

  const panel = el("aside");
  panel.id = "gfx-ext";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", title);
  panel.hidden = true;                       // [hidden] { display: none !important } in style.css --
                                             // so this is what keeps it out of the tab order while shut
  const head = el("div");
  head.id = "gfx-ext-head";
  head.appendChild(el("h2", "", title));
  const close = el("button");
  close.id = "gfx-ext-close";
  close.type = "button";
  close.textContent = "×";
  close.title = "Close";
  close.setAttribute("aria-label", "Close");
  head.appendChild(close);
  const body = el("div");
  body.id = "gfx-ext-body";
  panel.append(head, body);

  let spec = sections;
  let isOpen = false;

  function draw() {
    body.replaceChildren();
    for (const section of spec) {
      if (section.title) body.appendChild(el("h3", "", section.title));
      for (const item of section.items ?? []) body.appendChild(renderItem(item));
    }
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    panel.hidden = false;
    // a frame between unhiding and the class, or the transition has nothing to move from. It has to
    // re-check: a close in the same frame would otherwise land the class on a shut panel.
    requestAnimationFrame(() => { if (isOpen) panel.classList.add("on"); });
    button.classList.add("on");
    button.setAttribute("aria-expanded", "true");
    onOpen?.();
    close.focus({ preventScroll: true });
  }

  function closePanel({ refocus = true } = {}) {
    if (!isOpen) return;
    isOpen = false;
    panel.classList.remove("on");
    button.classList.remove("on");
    button.setAttribute("aria-expanded", "false");
    onClose?.();
    if (refocus) button.focus({ preventScroll: true });
    // after the slide, so nothing is focusable in a panel that is no longer there
    setTimeout(() => { if (!isOpen) panel.hidden = true; }, 220);
  }

  const api = {
    el: panel,
    button,
    open,
    close: () => closePanel(),
    toggle: () => (isOpen ? closePanel() : open()),
    // `isOpen`, not `open`: a getter named `open` would replace the open() method above -- and did,
    // until a jsdom test called it. A state read and an action cannot share a name on one object.
    get isOpen() { return isOpen; },
    /** Re-render, from the given sections or from the ones this was built with. */
    rebuild(next = null) {
      if (next) spec = next;
      draw();
    },
  };

  button.addEventListener("click", () => api.toggle());
  close.addEventListener("click", () => closePanel());
  // Escape closes, as the app's menus do; outside clicks too, but not a click inside the panel
  panel.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); closePanel(); } });
  document.addEventListener("pointerdown", (e) => {
    if (!isOpen) return;
    if (panel.contains(e.target) || button.contains(e.target)) return;
    closePanel({ refocus: false });
  }, true);

  const where = mount ?? document.getElementById("toolbar") ?? document.body;
  where.appendChild(button);
  document.body.appendChild(panel);
  draw();

  return api;
}
