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
  #synth-bar { display: flex; align-items: center; gap: 8px; }
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
  #synth-sgr-host { flex: 1 1 auto; min-height: 0; position: relative; overflow: hidden; display: none; }
  #synth-frame { position: absolute; left: 0; top: 0; width: 1280px; height: 760px; border: 0; transform-origin: top left; }
  #synth-guide { white-space: pre-wrap; font: 11px/1.4 ui-monospace, monospace; opacity: .85; max-height: 7em; overflow: auto; }
  #synth-midi { font: 11px/1.4 ui-monospace, monospace; opacity: .7; max-height: 4em; overflow: auto; }
`;

export function createSynthWindow(api) {
  if (!document.getElementById("synth-style")) {
    const s = document.createElement("style"); s.id = "synth-style"; s.textContent = STYLE; document.head.appendChild(s);
  }
  let selected = "main", open = false, lastBuilt = null;

  const btn = document.createElement("button");
  btn.id = "synth-btn"; btn.type = "button"; btn.textContent = "Synth"; btn.title = "the synth (Ctrl/Cmd+Alt+N)";
  btn.addEventListener("click", () => set(!open));
  document.body.appendChild(btn);

  const win = document.createElement("div");
  win.id = "synth-window"; win.setAttribute("role", "dialog"); win.setAttribute("aria-label", "Synth");
  win.innerHTML = `<div id="synth-bar"><h4>Synth</h4><span id="synth-status"></span><span class="spacer"></span>
      <button id="synth-enable" data-role="enable">Enable Soundgineer</button>
      <button id="synth-reader">start a reader</button>
      <button id="synth-close">close</button></div>
    <div id="synth-main"><div id="synth-channels"></div>
      <div id="synth-stage">
        <div id="synth-gate"><strong>Soundgineer is off</strong>
          <div id="synth-gate-why">Enabling starts it: it presses the app's Run once (which also runs the current buffer), puts the instruments on the engine's context and starts the reader.</div>
          <button id="synth-enable-2" data-role="enable">Enable Soundgineer</button></div>
        <div id="synth-sgr-host"><iframe id="synth-frame" title="Soundgineer editor"></iframe></div>
      </div></div>
    <h4>how the music addresses it</h4><div id="synth-guide"></div>
    <h4>recent MIDI</h4><div id="synth-midi"></div>`;
  document.body.appendChild(win);

  const status = (t, bad = false) => { const el = win.querySelector("#synth-status"); el.textContent = t ?? ""; el.style.color = bad ? "#f66" : ""; };
  win.querySelector("#synth-close").addEventListener("click", () => set(false));
  win.querySelector("#synth-reader").addEventListener("click", async () => {
    try { await globalThis.sonicPi?.session?.run?.("synth :sound_in_stereo, sustain: 3600, amp: 1", { group: 0 }); status("reader started"); }
    catch (e) { status(`could not start the reader: ${e?.message ?? e}`, true); }
  });
  for (const b of win.querySelectorAll('[data-role="enable"]')) {
    b.addEventListener("click", async () => {
      status("starting…");
      const ok = await api.enable?.();
      status(ok ? "enabled" : `could not enable: ${api.link?.().reason ?? "unknown"}`, !ok);
      paint(); mountEditor();
    });
  }

  function paintTable() {
    const st = api.state?.() ?? { parts: {} };
    const rows = [];
    for (let ch = 0; ch < 16; ch++) {
      const part = ch === 0 ? "main" : `ch${ch}`;
      const p = st.parts?.[part];
      rows.push(`<tr class="${part === selected ? "on" : ""} clickable" data-part="${part}"><td>${ch}</td><td>${part}</td>
        <td>${p?.patch ?? "—"}</td><td>${p?.voices ?? "—"}</td><td>${p ? (p.peak ?? 0).toFixed(2) : "—"}</td></tr>`);
    }
    win.querySelector("#synth-channels").innerHTML =
      `<table><thead><tr><th>ch</th><th>part</th><th>midi prog</th><th>voi</th><th>peak</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
    for (const tr of win.querySelectorAll("#synth-channels tr.clickable")) {
      tr.addEventListener("click", () => { selected = tr.dataset.part; lastBuilt = null; paint(); mountEditor(); });
    }
  }
  function paint() {
    paintTable();
    win.querySelector("#synth-guide").textContent = api.guide?.() ?? "";
    win.querySelector("#synth-midi").textContent = (api.midiTrace?.() ?? []).slice(-6)
      .map((e) => `${e.path} ch${e.channel} ${JSON.stringify(e.mapped)}`).join("\n");
    const link = api.link?.() ?? { state: "?" };
    status(`link: ${link.state}${link.reason ? ` (${link.reason})` : ""} · ${link.instruments?.length ?? 0} instr · out: ${link.out}`);
    const gate = win.querySelector("#synth-gate"), host = win.querySelector("#synth-sgr-host");
    const on = !!link.enabled;
    gate.style.display = on ? "none" : "flex";
    host.style.display = on ? "block" : "none";
    win.querySelectorAll('[data-role="enable"]').forEach((b) => { b.textContent = on ? "Disable" : "Enable Soundgineer"; });
  }

  function fitFrame() {
    const frame = win.querySelector("#synth-frame"), host = win.querySelector("#synth-sgr-host");
    const r = host.getBoundingClientRect();
    const k = Math.max(0.2, Math.min((r.width || 1280) / 1280, (r.height || 760) / 760));
    frame.style.transform = `scale(${k})`;
    frame.style.left = Math.max(0, (r.width - 1280 * k) / 2) + "px";
    frame.style.top = Math.max(0, (r.height - 760 * k) / 2) + "px";
  }
  async function mountEditor() {
    const frame = win.querySelector("#synth-frame");
    if (!api.enabled?.()) return;
    if (!frame.src) { frame.src = location.href.replace(/[^/]*$/, "") + "synth/soundgineer-frame.html"; await new Promise((r) => setTimeout(r, 500)); }
    const engine = api.engineOf?.(selected);
    if (!engine) { await api.ensurePart?.(selected); }
    const e2 = api.engineOf?.(selected);
    const w = frame.contentWindow;
    if (!e2 || !w?.__mount) { setTimeout(mountEditor, 400); return; }
    if (lastBuilt === selected) { fitFrame(); return; }
    w.__mount(e2);
    lastBuilt = selected;
    fitFrame();
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
    win.style.left = `${Math.round((vw - w) / 2)}px`; win.style.top = `${Math.round((vh - h) / 2)}px`;
    if (open) { paint(); mountEditor(); timer = setInterval(paint, 500); addEventListener("resize", fitFrame); }
    else { clearInterval(timer); timer = 0; removeEventListener("resize", fitFrame); }
    return true;
  }
  document.addEventListener("keydown", (e) => {
    if (open && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); set(false); }
    else if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === "n" || e.key === "N")) { e.preventDefault(); e.stopPropagation(); set(!open); }
  }, true);

  document.body.dataset.synth = "closed";
  return { el: win, button: btn, open: () => open, set, selected: () => selected, paint, mountEditor };
}
