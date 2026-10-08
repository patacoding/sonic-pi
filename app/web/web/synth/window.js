// Our window: the channel table, the numbering guide, the MIDI echo, and -- when Soundgineer is enabled -- their own
// editor. Nothing of Sonic Pi's UI is touched: this element covers the page, it never rearranges it, and no state of
// ours is persisted.
const STYLE = `
  #synth-btn { position: fixed; right: 0; top: calc(50% + 6.3em); z-index: 101; writing-mode: vertical-rl; height: 5.4em;
    overflow: hidden; padding: 10px 6px; cursor: pointer; font: 12px/1.1 system-ui, sans-serif; letter-spacing: .04em;
    text-align: center; color: var(--WindowForeground); border: 1px solid var(--WindowBorder); border-right: 0;
    border-radius: 8px 0 0 8px; background: color-mix(in srgb, var(--WindowBackground) 92%, transparent); }
  #synth-btn:hover { background: color-mix(in srgb, var(--WindowBackground) 78%, transparent); }
  #synth-btn[aria-pressed="true"] { border-color: #5a8; color: #5a8; }
  #synth-window { position: fixed; z-index: 97; display: none; flex-direction: column; gap: 6px; padding: 8px;
    background: var(--WindowBackground); color: var(--WindowForeground); border: 1px solid var(--WindowBorder);
    border-radius: 10px; font: 12px/1.45 system-ui, sans-serif; box-shadow: 0 8px 40px rgba(0,0,0,.45); }
  body[data-synth="open"] #synth-window { display: flex; }
  #synth-window h4 { margin: 0; font: 600 12px/1 system-ui, sans-serif; opacity: .8; }
  #synth-bar { display: flex; align-items: center; gap: 8px; cursor: move; user-select: none; }
  #synth-bar button { cursor: pointer; }
  #synth-bar .spacer { flex: 1 1 auto; }
  #synth-bar button, #synth-reader { font: 11px/1 system-ui, sans-serif; color: var(--WindowForeground); cursor: pointer;
    background: color-mix(in srgb, var(--WindowBackground) 92%, transparent); border: 1px solid var(--WindowBorder);
    border-radius: 6px; padding: 3px 8px; }
  #synth-bar button[data-role="enable"] { border-color: #5a8; color: #5a8; }
  #synth-main { flex: 1 1 auto; min-height: 0; display: flex; gap: 8px; }
  #synth-channels { flex: 0 0 190px; overflow: auto; border: 1px solid var(--WindowBorder); border-radius: 8px; }
  #synth-channels table { width: 100%; border-collapse: collapse; font: 11px/1.5 ui-monospace, monospace; }
  #synth-channels th, #synth-channels td { text-align: left; padding: 2px 5px; border-bottom: 1px solid color-mix(in srgb, var(--WindowBorder) 50%, transparent); }
  #synth-channels tr.on { background: color-mix(in srgb, #5a8 25%, transparent); }
  #synth-channels tr.clickable { cursor: pointer; }
  #synth-stage { flex: 1 1 auto; min-width: 0; border: 1px solid var(--WindowBorder); border-radius: 8px;
    display: flex; flex-direction: column; }
  #synth-gate { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 8px; padding: 16px; text-align: center; }
  /* the stage clips: the editor may be zoomed past it, but nothing of it ever leaves the window */
  #synth-sgr-host { flex: 1 1 auto; min-height: 0; position: relative; overflow: hidden; display: none; }
  #synth-pan-overlay { position: absolute; inset: 0; pointer-events: none; cursor: grab; }
  #synth-sgr-host[data-pan="on"] #synth-pan-overlay { pointer-events: auto; }
  #synth-sgr-host[data-pan="on"] { outline: 1px dashed var(--WindowBorder); }
  #synth-zoom-val { font: 11px/1 ui-monospace, monospace; min-width: 3.2em; text-align: center; opacity: .8; }
  #synth-frame { position: absolute; left: 0; top: 0; width: 1280px; height: 1200px; border: 0; transform-origin: top left; }
  /* collapsed by default: these are notes and a diagnostic, and collapsed they give the editor their room */
  #synth-help { flex: 0 0 auto; border: 1px solid var(--WindowBorder); border-radius: 8px; padding: 4px 6px; }
  #synth-help > summary { cursor: pointer; font: 11px/1.6 system-ui, sans-serif; opacity: .75; }
  #synth-help:not([open]) > *:not(summary) { display: none; }
  #synth-guide { white-space: pre-wrap; font: 11px/1.4 ui-monospace, monospace; opacity: .85; max-height: 7em; overflow: auto; }
  #synth-midi { font: 11px/1.4 ui-monospace, monospace; opacity: .7; max-height: 4em; overflow: auto; }
`;

export function createSynthWindow(api) {
  if (!document.getElementById("synth-style")) {
    const s = document.createElement("style"); s.id = "synth-style"; s.textContent = STYLE; document.head.appendChild(s);
  }
  let selected = "main", open = false, lastBuilt = null, mountError = null, mounting = false;
  let pos = null;            // where the player put the window, for this session only: never persisted
  let zoom = 1;              // 1 = fitted to the stage; larger is allowed and simply clipped
  let pan = { x: 0, y: 0 };
  let panMode = false;

  const btn = document.createElement("button");
  btn.id = "synth-btn"; btn.type = "button"; btn.textContent = "Synth"; btn.title = "the synth (Ctrl/Cmd+Alt+N)";
  btn.addEventListener("click", () => set(!open));
  document.body.appendChild(btn);

  const win = document.createElement("div");
  win.id = "synth-window"; win.setAttribute("role", "dialog"); win.setAttribute("aria-label", "Synth");
  win.innerHTML = `<div id="synth-bar"><h4>Synth</h4><span id="synth-status"></span><span class="spacer"></span>
      <button id="synth-zoom-out" title="smaller">−</button><span id="synth-zoom-val">100%</span><button id="synth-zoom-in" title="bigger">+</button><button id="synth-pan" title="drag the editor around inside this window">pan</button><button id="synth-fit" title="fit and re-centre">fit</button>
      <button id="synth-reader">start a reader</button><button id="synth-panic">all notes off</button>
      <button id="synth-close">close</button></div>
    <div id="synth-main"><div id="synth-channels"></div>
      <div id="synth-stage">
        <div id="synth-gate"><strong>Soundgineer is off</strong>
          <div id="synth-gate-why">Enabling runs nothing. It waits for the app's engine and attaches the instruments to it the moment it exists — press <strong>Run</strong> when you are ready, and your music starts as it always does.</div>
          <button id="synth-enable-2" data-role="enable">Enable Soundgineer</button></div>
        <div id="synth-sgr-host"><iframe id="synth-frame" title="Soundgineer editor"></iframe><div id="synth-pan-overlay" title="drag to move the editor"></div></div>
      </div></div>
    <details id="synth-help"><summary>how the music addresses it · recent MIDI</summary>
      <h4>how the music addresses it</h4><div id="synth-guide"></div>
      <h4>recent MIDI</h4><div id="synth-midi"></div>
    </details>`;
  document.body.appendChild(win);

  const status = (t, bad = false) => { const el = win.querySelector("#synth-status"); el.textContent = t ?? ""; el.style.color = bad ? "#f66" : ""; };
  win.querySelector("#synth-close").addEventListener("click", () => set(false));
  const setZoom = (z) => { zoom = Math.max(0.5, Math.min(2, z)); placeFrame(); };
  win.querySelector("#synth-zoom-in").addEventListener("click", () => setZoom(zoom * 1.25));
  win.querySelector("#synth-zoom-out").addEventListener("click", () => setZoom(zoom / 1.25));
  win.querySelector("#synth-fit").addEventListener("click", () => { zoom = 1; pan = { x: 0, y: 0 }; placeFrame(); });
  win.querySelector("#synth-pan").addEventListener("click", (e) => {
    panMode = !panMode;
    win.querySelector("#synth-sgr-host").dataset.pan = panMode ? "on" : "off";
    e.currentTarget.setAttribute("aria-pressed", String(panMode));
  });
  {
    const overlay = win.querySelector("#synth-pan-overlay");
    overlay.addEventListener("pointerdown", (e) => {
      const x0 = e.clientX, y0 = e.clientY, p0 = { ...pan };
      overlay.setPointerCapture?.(e.pointerId);
      const move = (ev) => { pan = { x: p0.x + (ev.clientX - x0), y: p0.y + (ev.clientY - y0) }; placeFrame(); };
      const up = (ev) => { overlay.removeEventListener("pointermove", move); overlay.removeEventListener("pointerup", up); try { overlay.releasePointerCapture(ev.pointerId) } catch {} };
      overlay.addEventListener("pointermove", move);
      overlay.addEventListener("pointerup", up);
      e.preventDefault();
    });
  }
  win.querySelector("#synth-reader").addEventListener("click", async () => {
    const ok = await api.startReader?.();
    status(ok ? "reader running" : "the reader did not start", !ok);
  });
  win.querySelector("#synth-panic").addEventListener("click", () => {
    api.panic?.("manual");
    status("all notes off");
  });
  win.querySelector("#synth-enable-2").addEventListener("click", async () => {
    status("arming — this runs nothing");
    const ok = await api.enable?.();
    status(ok ? "enabled" : `waiting: ${api.link?.().state ?? "unknown"}`, !ok);
    paint(); mountEditor();
  });

  function paintTable() {
    const st = api.state?.() ?? { parts: {} };
    const rows = [];
    for (let ch = 0; ch < 16; ch++) {
      const part = ch === 0 ? "main" : `ch${ch}`;
      const p = st.parts?.[part];
      rows.push(`<tr class="${part === selected ? "on" : ""} clickable" data-part="${part}"><td>${ch}</td><td>${part}</td>
        <td>${p?.preset ?? "—"}</td><td>${p?.voices ?? "—"}</td><td>${p ? (p.peak ?? 0).toFixed(2) : "—"}</td></tr>`);
    }
    win.querySelector("#synth-channels").innerHTML =
      `<table><thead><tr><th>ch</th><th>part</th><th>preset</th><th>voi</th><th>peak</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
    for (const tr of win.querySelectorAll("#synth-channels tr.clickable")) {
      tr.addEventListener("click", () => { selected = tr.dataset.part; lastBuilt = null; mountError = null; paint(); });
    }
  }
  function paint() {
    paintTable();
    win.querySelector("#synth-guide").textContent = api.guide?.() ?? "";
    win.querySelector("#synth-midi").textContent = (api.midiTrace?.() ?? []).slice(-6)
      .map((e) => `${e.path} ch${e.channel} ${JSON.stringify(e.mapped)}`).join("\n");
    // Keep the editor's own dropdown in step with what we recorded for this channel. Doing it only at mount time lost
    // the race against their refresh(), which fills the list a moment later -- and the dropdown then read Init again.
    syncEditorPreset();
    const link = api.link?.() ?? { state: "?" };
    status(`link: ${link.state}${link.reason ? ` (${link.reason})` : ""} · ${link.instruments?.length ?? 0} instr · out: ${link.out}${mountError ? ` · editor: ${mountError}` : ""}`, !!mountError);
    const gate = win.querySelector("#synth-gate"), host = win.querySelector("#synth-sgr-host");
    const on = !!link.enabled;
    gate.style.display = on ? "none" : "flex";
    host.style.display = on ? "block" : "none";
    if (on && open && !mounting && lastBuilt !== selected) { mounting = true; mountEditor().finally(() => { mounting = false; }); }
  }

  /** Never let the window be dragged somewhere it cannot be grabbed back from. */
  function clampPos(p) {
    const w = win.offsetWidth || 600, h = win.offsetHeight || 400;
    const keepX = Math.min(140, w), keepY = 32;
    const left = Math.max(keepX - w, Math.min(p.left, innerWidth - keepX));
    const top = Math.max(0, Math.min(p.top, innerHeight - keepY));
    return { left: Math.round(left), top: Math.round(top) };
  }

  function startDrag(bar) {
    bar.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;                  // buttons keep working
      const r = win.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = (ev) => {
        pos = clampPos({ left: ev.clientX - dx, top: ev.clientY - dy });
        win.style.left = pos.left + "px"; win.style.top = pos.top + "px";
      };
      const up = (ev) => {
        bar.removeEventListener("pointermove", move);
        bar.removeEventListener("pointerup", up);
        bar.removeEventListener("pointercancel", up);
        try { bar.releasePointerCapture(ev.pointerId) } catch { /* nothing captured */ }
      };
      try { bar.setPointerCapture(e.pointerId) } catch { /* a synthetic pointer may refuse; the drag still works */ }
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up);
      bar.addEventListener("pointercancel", up);
      e.preventDefault();
    });
  }

  function syncEditorPreset() {
    try {
      const frame = win.querySelector("#synth-frame");
      const want = api.state?.().parts?.[selected]?.preset ?? null;
      if (!want || !frame?.contentDocument) return;
      const selEl = frame.contentDocument.querySelector("select.preset-select");
      if (!selEl || selEl.options.length === 0) return;                 // their list is not built yet; the next paint retries
      const opt = [...selEl.options].find((o) => o.value === `factory:${want}` || o.value.endsWith(`:${want}`) || o.textContent.trim() === want);
      if (opt && selEl.value !== opt.value) selEl.value = opt.value;    // display only: no change event, nothing re-applied
    } catch { /* the frame may be mid-navigation */ }
  }

  /** Scale and offset, clamped so the stage is never left with a gap when the editor is larger than it. */
  function placeFrame() {
    const frame = win.querySelector("#synth-frame"), host = win.querySelector("#synth-sgr-host");
    const r = host.getBoundingClientRect();
    const fit = Math.max(0.2, Math.min((r.width || 1280) / 1280, (r.height || 1060) / 1060));
    const scale = fit * zoom;
    const cw = 1280 * scale, ch = 1060 * scale;
    const cx = (r.width - cw) / 2, cy = (r.height - ch) / 2;
    const clampAxis = (v, content, room) => (content <= room ? (room - content) / 2 : Math.max(room - content, Math.min(v, 0)));
    const left = clampAxis(cx + pan.x, cw, r.width);
    const top = clampAxis(cy + pan.y, ch, r.height);
    pan = { x: left - (r.width - cw) / 2, y: top - (r.height - ch) / 2 };
    frame.style.transform = `scale(${scale})`;
    frame.style.left = `${Math.round(left)}px`;
    frame.style.top = `${Math.round(top)}px`;
    const val = win.querySelector("#synth-zoom-val"); if (val) val.textContent = `${Math.round(zoom * 100)}%`;
    return { scale, left, top, cw, ch };
  }

  function fitFrame() {
    const frame = win.querySelector("#synth-frame"), host = win.querySelector("#synth-sgr-host");
    const r = host.getBoundingClientRect();
    const k = Math.max(0.2, Math.min((r.width || 1280) / 1280, (r.height || 1200) / 1200));
    frame.style.transform = `scale(${k})`;
    frame.style.left = Math.max(0, (r.width - 1280 * k) / 2) + "px";
    frame.style.top = Math.max(0, (r.height - 1200 * k) / 2) + "px";
  }
  let mountTries = 0;
  async function mountEditor() {
    const frame = win.querySelector("#synth-frame");
    if (!api.enabled?.()) return;
    try {
      if (!frame.src) {
        frame.src = location.href.replace(/[^/]*$/, "") + "synth/soundgineer-frame.html";
        await new Promise((r) => setTimeout(r, 500));
      }
      let engine = api.engineOf?.(selected);
      if (!engine) { await api.ensurePart?.(selected); engine = api.engineOf?.(selected); }
      const w = frame.contentWindow;
      if (!engine || !w?.__mount) {
        if (++mountTries < 25) setTimeout(mountEditor, 400);            // their module and the engine both take a moment
        else mountError = `did not come up (engine ${!!engine}, frame ${!!w?.__mount})`;
        return;
      }
      mountTries = 0; mountError = null;
      if (lastBuilt === selected) { fitFrame(); return; }
      const kids = w.__mount(engine);
      // the editor's own preset dropdown does not know which preset this engine is on (it is a fresh browser after a
      // remount), so it is set to what we recorded -- display only, no change event, nothing is re-applied
      try {
        const want = api.state?.().parts?.[selected]?.preset ?? null;
        const selEl = frame.contentDocument?.querySelector("select.preset-select");
        if (want && selEl) {
          const opt = [...selEl.options].find((o) => o.value === `factory:${want}` || o.value.endsWith(`:${want}`) || o.textContent.trim() === want);
          if (opt) selEl.value = opt.value;
        }
      } catch {}
      lastBuilt = selected;
      fitFrame();
      status(`${selected}: editor built (${kids} sections) · out: ${api.link?.().out}`);
    } catch (e) {
      mountError = `could not be built: ${e?.message ?? e}`;
      console.error("Synth — mounting the editor failed", e);
    }
  }

  let timer = 0;
  function set(next) {
    if (next === open) return false;
    open = next;
    document.body.dataset.synth = open ? "open" : "closed";
    btn.setAttribute("aria-pressed", String(open));
    btn.textContent = open ? "Audio" : "Synth";
    const vw = innerWidth, vh = innerHeight;
    const w = Math.min(Math.round(vw * 0.92), 1280), h = Math.min(Math.round(vh * 0.86), 800);
    win.style.width = `${w}px`; win.style.height = `${h}px`;
    // centred first time, wherever the player put it afterwards
    pos = clampPos(pos ?? { left: Math.round((vw - w) / 2), top: Math.round((vh - h) / 2) });
    win.style.left = `${pos.left}px`; win.style.top = `${pos.top}px`;
    if (open) { paint(); mountEditor(); timer = setInterval(paint, 500); addEventListener("resize", fitFrame); }
    else { clearInterval(timer); timer = 0; removeEventListener("resize", fitFrame); }
    return true;
  }
  document.addEventListener("keydown", (e) => {
    if (open && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); set(false); }
    else if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === "n" || e.key === "N")) { e.preventDefault(); e.stopPropagation(); set(!open); }
  }, true);

  startDrag(win.querySelector("#synth-bar"));
  document.body.dataset.synth = "closed";
  return { el: win, button: btn, open: () => open, set, selected: () => selected, paint, mountEditor, position: () => (pos ? { ...pos } : null), zoom: () => zoom, setZoom, pan: () => ({ ...pan }), placeFrame };
}
