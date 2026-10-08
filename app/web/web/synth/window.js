// The synth's own window. Nothing of Sonic Pi's UI is touched: this is our element, ours to show and hide, and it
// covers the app rather than rearranging it (plan section 2). It is deliberately NOT full screen -- the audio
// interface stays reachable around the edges -- and it is level 2, so the canvas (level 0) and the Shadertoy window
// (level 1) are never competed with.
const STYLE = `
  #synth-btn { position: fixed; right: 0; z-index: 101; writing-mode: vertical-rl; height: 5.4em; overflow: hidden;
    padding: 10px 6px; cursor: pointer; font: 12px/1.1 system-ui, sans-serif; letter-spacing: .04em; text-align: center;
    color: var(--WindowForeground); border: 1px solid var(--WindowBorder); border-right: 0; border-radius: 8px 0 0 8px;
    background: color-mix(in srgb, var(--WindowBackground) 92%, transparent); }
  #synth-btn:hover { background: color-mix(in srgb, var(--WindowBackground) 78%, transparent); }
  #synth-btn[aria-pressed="true"] { border-color: #5a8; color: #5a8; }
  #synth-window { position: fixed; z-index: 97; display: none; flex-direction: column; gap: 6px; padding: 8px;
    background: var(--WindowBackground); color: var(--WindowForeground); border: 1px solid var(--WindowBorder);
    border-radius: 10px; font: 12px/1.45 system-ui, sans-serif; box-shadow: 0 8px 40px rgba(0,0,0,.45); }
  body[data-synth="open"] #synth-window { display: flex; }
  #synth-window h4 { margin: 0; font: 600 12px/1 system-ui, sans-serif; opacity: .8; }
  #synth-bar { display: flex; align-items: center; gap: 8px; }
  #synth-bar .spacer { flex: 1 1 auto; }
  #synth-bar button, #synth-reader { font: 11px/1 system-ui, sans-serif; color: var(--WindowForeground); cursor: pointer;
    background: color-mix(in srgb, var(--WindowBackground) 92%, transparent); border: 1px solid var(--WindowBorder);
    border-radius: 6px; padding: 3px 8px; }
  #synth-main { flex: 1 1 auto; min-height: 0; display: flex; gap: 8px; }
  #synth-channels { flex: 0 0 190px; overflow: auto; border: 1px solid var(--WindowBorder); border-radius: 8px; }
  #synth-channels table { width: 100%; border-collapse: collapse; font: 11px/1.5 ui-monospace, monospace; }
  #synth-channels th, #synth-channels td { text-align: left; padding: 2px 5px; border-bottom: 1px solid color-mix(in srgb, var(--WindowBorder) 50%, transparent); }
  #synth-channels tr.on { background: color-mix(in srgb, #5a8 25%, transparent); }
  #synth-channels tr.clickable { cursor: pointer; }
  #synth-stage { flex: 1 1 auto; min-width: 0; border: 1px solid var(--WindowBorder); border-radius: 8px; padding: 8px;
    display: flex; flex-direction: column; gap: 6px; }
  /* the mount point must FILL the stage: measured at height 0 before this, which is why the interface was invisible
     even once it had been built */
  #synth-sgr-host { flex: 1 1 auto; min-height: 120px; width: 100%; border-radius: 6px; overflow: hidden; position: relative; }
  #synth-frame { position: absolute; left: 0; top: 0; width: 1280px; height: 760px; border: 0; transform-origin: top left; background: transparent; }
  #synth-guide { white-space: pre-wrap; font: 11px/1.4 ui-monospace, monospace; opacity: .85; max-height: 7.5em; overflow: auto; }
  #synth-midi { font: 11px/1.4 ui-monospace, monospace; opacity: .7; max-height: 4.5em; overflow: auto; }
`;

const el = (tag, props = {}, ...kids) => Object.assign(document.createElement(tag), props, { ...(props.style ? { style: props.style } : {}) }, ...kids.map((k) => ({})));

export function createSynthWindow(api) {
  if (!document.getElementById("synth-style")) {
    const s = document.createElement("style"); s.id = "synth-style"; s.textContent = STYLE; document.head.appendChild(s);
  }
  let selected = "main";
  let open = false;
  let mounting = false;
  let lastGen = -1;

  const btn = document.createElement("button");
  btn.id = "synth-btn"; btn.type = "button"; btn.textContent = "Synth"; btn.title = "the synth (Ctrl/Cmd+Alt+N)";
  btn.style.top = "calc(50% + 6.3em)";                                  // directly below the canvas's button
  btn.addEventListener("click", () => set(!open));
  document.body.appendChild(btn);

  const win = document.createElement("div");
  win.id = "synth-window"; win.setAttribute("role", "dialog"); win.setAttribute("aria-label", "Synth");
  win.innerHTML = `<div id="synth-bar"><h4>Synth</h4><span id="synth-status"></span><span class="spacer"></span>
      <button id="synth-connect">connect to Sonic Pi</button><button id="synth-reader">start a reader</button><button id="synth-close">close</button></div>
    <div id="synth-main"><div id="synth-channels"></div>
      <div id="synth-stage"><div id="synth-stage-body"></div><div id="synth-sgr-host"><iframe id="synth-frame" title="Soundgineer editor"></iframe></div></div></div>
    <h4>how the music addresses it</h4><div id="synth-guide"></div>
    <h4>recent MIDI</h4><div id="synth-midi"></div>`;
  document.body.appendChild(win);
  win.querySelector("#synth-close").addEventListener("click", () => set(false));
  win.querySelector("#synth-reader").addEventListener("click", () => startReader());
  win.querySelector("#synth-connect").addEventListener("click", async () => {
    status("connecting — this runs the current buffer once");
    await api.connectToEngine?.();
    await startReader();          // and something must read the bus for anything to be heard
    paint();
  });

  /**
   * Their editor, in a frame sized to the design it was written for.
   *
   * The frame is not decoration and not an isolation trick: their layout is written in vh/vw, which only mean the
   * design size if there is a viewport of that size. So the frame is 1280x760 and the FRAME is scaled to the room we
   * have; nothing inside it is rewritten, remapped or scaled.
   */
  function fitFrame() {
    const frame = document.getElementById("synth-frame");
    const host = document.getElementById("synth-sgr-host");
    if (!frame || !host) return 0;
    const r = host.getBoundingClientRect();
    const k = Math.max(0.2, Math.min((r.width || 1280) / 1280, (r.height || 760) / 760));
    frame.style.transform = `scale(${k})`;
    frame.style.left = Math.max(0, (r.width - 1280 * k) / 2) + "px";
    frame.style.top = Math.max(0, (r.height - 760 * k) / 2) + "px";
    return k;
  }

  async function mountSoundgineer() {
    const frame = document.getElementById("synth-frame");
    if (!frame) return;
    try {
      if (!frame.src) {
        frame.src = location.href.replace(/[^/]*$/, "") + "synth/soundgineer-frame.html";
        await new Promise((r) => setTimeout(r, 500));
      }
      let engine = api.engineOf?.(selected);
      if (!engine) { await api.ensurePart?.(selected); engine = api.engineOf?.(selected); }
      if (!engine) { status("the editor could not start (no audio context) — see the console", true); return; }
      const win = frame.contentWindow;
      if (!win?.__mount) { setTimeout(() => mountSoundgineer(), 400); return; }
      const kids = win.__mount(engine);
      frame.dataset.built = selected;
      fitFrame();
      if (!win.__fitBound) { win.__fitBound = true; addEventListener("resize", fitFrame); }
      status(`${selected}: editor built (${kids} sections${api.ownContext?.() ? ", our own context — press Run for the engine" : ""})`);
    } catch (e) { status(`the editor could not be built: ${e?.message ?? e}`, true); console.error(e); }
  }

  async function startReader() {
    try {
      await globalThis.sonicPi?.session?.run?.("synth :sound_in_stereo, sustain: 3600, amp: 1", { group: 0 });
      status("reader started — the synth is now heard through the engine");
    } catch (e) { status(`could not start the reader: ${e?.message ?? e}`, true); }
  }
  const statusEl = () => win.querySelector("#synth-status");
  const status = (t, bad = false) => { const s = statusEl(); s.textContent = t ?? ""; s.style.color = bad ? "#f66" : ""; };

  function paint() {
    const st = api.state?.() ?? { parts: {} };
    const patches = api.patches?.() ?? [];
    const names = Object.keys(st.parts ?? {});
    const rows = [];
    for (let ch = 0; ch < 16; ch++) {
      const part = ch === 0 ? "main" : `ch${ch}`;
      const p = st.parts?.[part];
      rows.push(`<tr class="${part === selected ? "on" : ""} clickable" data-part="${part}">
        <td>${ch}</td><td>${part}</td><td>${p ? (p.patch ?? "—") : "—"}</td>
        <td>${p ? p.voices : "—"}</td><td>${p ? (p.peak ?? 0).toFixed(2) : "—"}</td></tr>`);
    }
    win.querySelector("#synth-channels").innerHTML =
      `<table><thead><tr><th>ch</th><th>part</th><th>midi prog</th><th>voi</th><th>peak</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
    for (const tr of win.querySelectorAll("#synth-channels tr.clickable")) {
      tr.addEventListener("click", () => { selected = tr.dataset.part; paint(); });
    }
    // The stage is the editor and nothing else: their interface already chooses presets, and the channel table
    // already carries the numbers, so a title, a second patch list and a second reading of voices/peak were all
    // duplicates of what is beside them.
    win.querySelector("#synth-stage-body").textContent = st.parts?.[selected] ? "" : "";
    win.querySelector("#synth-guide").textContent = api.guide?.() ?? "";
    win.querySelector("#synth-midi").textContent = (api.midiTrace?.() ?? []).slice(-6).map((e) => `${e.path} ${JSON.stringify(e.args)}${e.mapped ? " → " + JSON.stringify(e.mapped) : ""}`).join("\n");
    const selPart = st.parts?.[selected];
    const link = api.link?.() ?? null;
    statusEl().textContent = link ? `link: ${link.state} · ${names.length} instr · peak ${(selPart?.peak ?? 0).toFixed(3)}`
                                  : `${names.length} instrument(s) · peak ${(selPart?.peak ?? 0).toFixed(3)}`;
  }

  let timer = 0;
  function set(next) {
    if (next === open) return false;
    open = next;
    document.body.dataset.synth = open ? "open" : "closed";
    btn.setAttribute("aria-pressed", String(open));
    btn.textContent = open ? "Audio" : "Synth";                        // what clicking does
    const vw = innerWidth, vh = innerHeight;
    const w = Math.min(Math.round(vw * 0.92), 1280), h = Math.min(Math.round(vh * 0.86), 800);
    win.style.width = `${w}px`; win.style.height = `${h}px`;
    win.style.left = `${Math.round((vw - w) / 2)}px`; win.style.top = `${Math.round((vh - h) / 2)}px`;
    if (open) { paint(); mountSoundgineer(); ensureReader(); timer = setInterval(paint, 500); }
    else { clearInterval(timer); timer = 0; }
    return true;
  }
  document.addEventListener("keydown", (e) => {
    if (open && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); set(false); }
    else if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === "n" || e.key === "N")) { e.preventDefault(); e.stopPropagation(); set(!open); }
  }, true);

  document.body.dataset.synth = "closed";
  return { el: win, button: btn, open: () => open, set, selected: () => selected, paint, mountSoundgineer };
}
