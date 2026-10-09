// One editor document per channel, built ONCE and kept alive; switching only changes which one is displayed.
console.info("Synth build: editors.js b100a4");
//
// Why this exists: rebuilding their app per switch left the module-level knob registry holding dead canvases and leaked
// a WebGL context every time, until Chrome evicted the oldest one (the Shadertoy preview) and it went black. Repointing
// one view instead kept the canvases but left every widget that reads state once at build time showing the previous
// channel. A document per channel is the only arrangement where every widget is simply the selected channel's.
//
// Everything this needs (sizing, visibility, LRU eviction) it does itself with inline styles, so the window code only
// has to create it and call select() -- no existing code has to be rewritten.
const DESIGN_W = 1280;
const DESIGN_H = 1200;

export function createEditorPool({ host, frameUrl, cap = 2, onStatus }) {
  const entries = new Map();   // part -> { frame, engine, built }
  const order = [];            // least recently used first
  const say = (m) => { try { onStatus?.(m); } catch { /* status is cosmetic */ } };
  let apiRef = null;   // the frame's load handler runs later and still needs to sync its preset

  const active = () => { for (const [, ed] of entries) if (ed.frame.classList.contains("active")) return ed; return null; };

  function styleFrame(frame) {
    Object.assign(frame.style, {
      position: "absolute", left: "0px", top: "0px", border: "0",
      width: DESIGN_W + "px", height: DESIGN_H + "px",
      transformOrigin: "top left", display: "none", background: "transparent",
    });
  }

  /** Let the frame's own document scroll: their CSS hides overflow, which blocks the browser's gestures inside it. */
  function allowNativeScrolling(frame) {
    try {
      const doc = frame.contentDocument;
      if (!doc || doc.__sgrScroll) return;
      doc.__sgrScroll = true;
      doc.documentElement.style.setProperty("overflow", "auto", "important");
      doc.body.style.setProperty("overflow", "auto", "important");
    } catch { /* not ready */ }
  }

  function fit(ed) {
    if (!ed || !host) return null;
    const r = host.getBoundingClientRect();
    const fitScale = Math.max(0.2, Math.min((r.width || DESIGN_W) / DESIGN_W, (r.height || DESIGN_H) / DESIGN_H));
    ed.frame.style.transform = "scale(" + fitScale + ")";
    ed.frame.style.left = Math.max(0, (r.width - DESIGN_W * fitScale) / 2) + "px";
    ed.frame.style.top = Math.max(0, (r.height - DESIGN_H * fitScale) / 2) + "px";
    return fitScale;
  }

  function maybeMount(ed, part) {
    if (!ed || ed.built || !ed.engine) return false;
    const fw = ed.frame.contentWindow;
    if (!fw || typeof fw.__mount !== "function") return false;   // the load handler will try again
    ed.built = true;
    try { fw.__mount(ed.engine); say("view for " + part + " built"); return true; } catch (e) { ed.built = false; say("could not build " + part + ": " + (e?.message ?? e)); return false; }
  }

  function evictIfNeeded() {
    while (entries.size >= cap && order.length) {
      const victim = order.shift();
      const old = entries.get(victim);
      if (!old) continue;
      try { old.frame.remove(); } catch { /* already gone */ }   // removing the document releases its canvases and contexts
      entries.delete(victim);
      say("released the view for " + victim);
    }
  }

  function show(part) {
    for (const [p, ed] of entries) ed.frame.style.display = (p === part && ed.built) ? "block" : "none";
    const i = order.indexOf(part);
    if (i !== -1) order.splice(i, 1);
    order.push(part);
    fit(entries.get(part));
  }

  function ensure(part, engine) {
    let ed = entries.get(part);
    const stamp = engine?.__sgrPreset ?? null;      // their engine records the preset it is on; a change means redraw
    if (ed) {
      if (engine && (ed.engine !== engine || (stamp && ed.stamp !== stamp))) {
        // The engine changed AFTER this document was built. Their widgets (3D wavetable, MATRIX, ENV, FX) read state
        // once at build time and only the knobs listen for param changes, so repointing leaves the document showing the
        // old values -- which is exactly "the parameters never update". A fresh document is the only arrangement where
        // every widget is correct, and this happens once per preset change, not once per switch.
        say("rebuilding the view for " + part + " because its preset changed to " + String(stamp));
        try { ed.frame.remove(); } catch { /* already gone */ }
        entries.delete(part);
        // THROTTLE: only destroy here and let the next call (the paint loop runs every 500ms) create the replacement. A
        // burst of preset changes therefore rebuilds at most one document per tick, which keeps the number of live WebGL
        // contexts from spiking -- while the previous channel's view stays on screen, so nothing blanks in the meantime.
        order.splice(order.indexOf(part), 1);
        return null;
      } else {
        ed.stamp = stamp;
        maybeMount(ed, part);
        return ed;
      }
    }
    evictIfNeeded();
    const frame = document.createElement("iframe");
    frame.dataset.part = part;
    frame.title = "Soundgineer editor - " + part;
    styleFrame(frame);
    ed = { frame, engine, built: false, stamp };
    entries.set(part, ed);
    frame.addEventListener("load", () => { allowNativeScrolling(frame); maybeMount(ed, part); fit(ed); syncPreset(part, apiRef); });
    host.appendChild(frame);
    frame.src = frameUrl;
    return ed;
  }

  /** Display only: their dropdown does not know which preset its engine is on, so it is set to what we recorded. */
  function syncPreset(part, api) {
    const ed = entries.get(part);
    if (!ed) return;
    try {
      const want = (api ? api.state?.().parts?.[part]?.preset : lastNames.get(part)) ?? null;
      if (!want || !ed.frame.contentDocument) return;
      const selEl = ed.frame.contentDocument.querySelector("select.preset-select");
      if (!selEl || selEl.options.length === 0) return;
      const opt = [...selEl.options].find((o) => o.value === "factory:" + want || o.value.endsWith(":" + want) || o.textContent.trim() === want);
      if (!opt) return;
      // Set the dropdown AND let their own handler run. Restoring used to write engine.__sgrPreset only, which marks the
      // name but never loads the parameters: every restored channel then played the defaults, so all channels sounded
      // and displayed alike until localStorage was cleared and the presets were chosen by hand.
      const changed = selEl.value !== opt.value;
      selEl.value = opt.value;
      if (changed || ed.lastApplied !== want) {
        ed.lastApplied = want;
        selEl.dispatchEvent(new ed.frame.contentWindow.Event("change", { bubbles: true }));
      }
    } catch { /* mid-navigation */ }
  }
  const lastNames = new Map();

  /** THE SWITCH: the selected channel gets its view (built once) and only that view is displayed. */
  async function select(part, api) {
    apiRef = api ?? apiRef;
    let engine = api?.engineOf?.(part) ?? null;
    if (!engine) { try { await api?.ensurePart?.(part); } catch { /* no engine yet */ } engine = api?.engineOf?.(part) ?? null; }
    // ALWAYS show the selected channel's own view, even before its engine exists. Returning early here left the
    // previous channel's view on screen, which is exactly the player's "switching channels does not update the
    // parameters": the display never switched at all.
    const ed = ensure(part, engine);
    if (!engine) say(part + " has no engine yet -- its view is shown empty and will fill in when one exists");
    // a frame's load event can fire for the initial about:blank, before the module exists; retry EVERY frame here so one
    // that was created while the player switched away still gets built
    for (const [p, ed] of entries) maybeMount(ed, p);
    show(part);
    syncPreset(part, api);
    return engine;
  }

  /** Build every channel's view up front. Lazy creation left a window between the click and the new view being ready,
   *  during which nothing (or the previous channel) was on screen -- which is what "clicking a channel changes
   *  nothing" turned out to be. Prepared views switch instantly. */
  async function prepare(parts, api) {
    apiRef = api ?? apiRef;
    for (const part of parts ?? []) {
      if (entries.get(part)?.built) continue;
      let engine = api?.engineOf?.(part) ?? null;
      if (!engine) { try { await api?.ensurePart?.(part); } catch { /* no engine yet */ } engine = api?.engineOf?.(part) ?? null; }
      if (!engine) continue;
      const ed = ensure(part, engine);
      maybeMount(ed, part);
      // A restored channel is never the selected one, so without this its preset was never loaded into its engine: every
      // restored channel stayed on the defaults, and they all sounded and displayed alike.
      syncPreset(part, api);
    }
  }

  /** Throw away one channel's document so it is rebuilt (and so its preset dropdown re-reads the library) on the next
   *  tick. Needed after an import because the view only rebuilds on its own when the preset NAME changes: importing a
   *  name that is already current left the old option list on screen. */
  function reload(part) {
    const ed = entries.get(part);
    if (!ed) return false;
    try { ed.frame.remove(); } catch { /* already gone */ }
    entries.delete(part);
    const i = order.indexOf(part); if (i !== -1) order.splice(i, 1);
    return true;
  }

  return { ensure, reload, show, select, prepare, syncPreset, fit, active, list: () => [...entries.keys()], cap, count: () => entries.size };
}
