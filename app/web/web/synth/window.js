// Our window: the channel table, the numbering guide, the MIDI echo, and -- when Soundgineer is enabled -- their own
// editor. Nothing of Sonic Pi's UI is touched: this element covers the page, it never rearranges it, and no state of
// ours is persisted.
import { createEditorPool } from "./editors.js";
console.info("Synth build: window.js b100b4");
const BUILD = "b100b4";   // single source of truth: the stamp, the row and the staleness check all use this

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
  /* the build stamp must never be squeezed out by the buttons: no wrapping, no shrinking, and it sits before the spacer */
  /* what the last import did: visible, and never overwritten by the paint loop */
  #synth-last-import { flex: 0 0 auto; white-space: nowrap; font: 11px/1.6 ui-monospace, monospace; opacity: .85; max-width: 42ch; overflow: hidden; text-overflow: ellipsis; }
  #synth-build-stamp { flex: 0 0 auto; white-space: nowrap; font: 11px/1.6 ui-monospace, monospace; opacity: .75; }
  #synth-bar button { cursor: pointer; }
  #synth-bar .spacer { flex: 1 1 auto; }
  #synth-bar button, #synth-reader { font: 11px/1 system-ui, sans-serif; color: var(--WindowForeground); cursor: pointer;
    background: color-mix(in srgb, var(--WindowBackground) 92%, transparent); border: 1px solid var(--WindowBorder);
    border-radius: 6px; padding: 3px 8px; }
  #synth-bar button[data-role="enable"] { border-color: #5a8; color: #5a8; }
  #synth-main { flex: 1 1 auto; min-height: 0; display: flex; gap: 8px; }
  #synth-channels { flex: 0 0 222px; overflow: auto; border: 1px solid var(--WindowBorder); border-radius: 8px; }
  #synth-channels table { width: 100%; border-collapse: collapse; font: 11px/1.5 ui-monospace, monospace; }
  #synth-channels th, #synth-channels td { text-align: left; padding: 2px 5px; border-bottom: 1px solid color-mix(in srgb, var(--WindowBorder) 50%, transparent); }
  #synth-channels th:last-child, #synth-channels td:last-child { width: 1.6em; text-align: center; padding: 2px 2px; }
  #synth-channels tr.on { background: color-mix(in srgb, #5a8 25%, transparent); }
  #synth-channels tr.clickable { cursor: pointer; }
  #synth-stage { flex: 1 1 auto; min-width: 0; border: 1px solid var(--WindowBorder); border-radius: 8px;
    display: flex; flex-direction: column; }
  #synth-gate { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 8px; padding: 16px; text-align: center; }
  /* the stage clips: the editor may be zoomed past it, but nothing of it ever leaves the window */
  #synth-stale { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 4px 6px;
    font: 11px/1.5 system-ui, sans-serif; color: #2b1a00; background: #ffd479;
    border-bottom: 1px solid rgba(0,0,0,.25); }
  #synth-stale button { font: 11px/1.6 system-ui, sans-serif; cursor: pointer; }
  #synth-import-row { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 4px 6px;
    border-bottom: 1px solid color-mix(in srgb, var(--WindowBorder) 60%, transparent); }
  #synth-import-row button { font: 11px/1.6 system-ui, sans-serif; cursor: pointer; }
  /* the conversion report is several lines and must not be truncated: it is the product's diagnosis surface */
  #synth-import-note { font: 11px/1.4 system-ui, sans-serif; opacity: .7; white-space: pre-wrap; max-width: 72ch; text-align: left; }
  #synth-row-stamp { font: 11px/1.6 ui-monospace, monospace; opacity: .7; }
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
  let selected = "main", open = false, builtEngine = null, builtFor = null, mountError = null, mounting = false;
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
      <button id="synth-reader">start a reader</button><button id="synth-panic">all notes off</button>
      <button id="synth-close">close</button></div>
    <div id="synth-main"><div id="synth-channels"></div>
      <div id="synth-stage">
        <div id="synth-stale" hidden>
          <strong>A newer build is available.</strong>
          <span id="synth-stale-text"></span>
          <button id="synth-stale-reload" type="button">reload now</button>
        </div>
        <div id="synth-import-row">
          <button id="synth-import-vital-2" type="button">Import a Vital preset (.vital)</button>
          <span id="synth-row-stamp"></span>
          <span id="synth-import-note">one file: its parameters and any wavetables inside it are loaded into the selected channel</span>
        </div>
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

  // ── Import the player's own Vital presets, locally (nothing is uploaded; see docs/vital-presets-feasibility.md §8)
  const vitalInput = document.createElement("input");
  vitalInput.id = "synth-vital-file";
  vitalInput.type = "file";
  vitalInput.accept = ".vital,application/json";
  vitalInput.multiple = false;   // ONE file: anything needing more than one is the player's business (see the doc)
  vitalInput.style.display = "none";
  let vitalBtn = null;
  try {
    vitalBtn = document.createElement("button");
    vitalBtn.id = "synth-import-vital";
    vitalBtn.type = "button";
    vitalBtn.textContent = "Import Vital…";
    vitalBtn.title = "Load ONE of your own .vital presets into the selected channel. A preset that needs other files is yours to complete with the Import button in the oscillator panel.";
    vitalBtn.addEventListener("click", () => vitalInput.click());
  } catch { /* cosmetic */ }
  /** Say something in BOTH places the player looks: the title-bar line and the note beside the import button.
   *  Every outcome uses this -- a rejection that only reaches the console reads to the player as "nothing happened". */
  const say = (text, bad = false) => {
    try {
      const el = win.querySelector("#synth-last-import");
      const note = win.querySelector("#synth-import-note");
      if (el) el.textContent = text;
      if (note) { note.textContent = text; note.style.opacity = "1"; note.style.color = bad ? "#ffb4b4" : ""; }
    } catch { /* cosmetic */ }
    if (bad) console.warn("Synth — " + text); else console.info("Synth — " + text);
  };

  vitalInput.addEventListener("change", async () => {
    // ONE file. This flow is a single file going in and coming out as parameters plus whatever wavetables that same
    // file carries. A preset that needs other files is the player's to complete, with the oscillator's Import button.
    const file = vitalInput.files?.[0] ?? null;
    vitalInput.value = "";
    if (!file) { say("no file was chosen", true); return; }
    try {
      const mod = await import("./vital.js").catch((e) => { say("the converter could not load: " + (e?.message ?? e), true); return null; });
      if (!mod) return;
      const engine = api.engineOf?.(selected);
      if (!engine) { say(`pick a channel first — the selected one, "${selected}", has no sound yet`, true); return; }
      if (file.size > 32 * 1024 * 1024) { say(`"${file.name}" is ${(file.size / 1048576).toFixed(1)} MB, too large to be a preset`, true); return; }
      const text = await file.text();
      const kind = mod.classifyFile(file.name, text);
      if (kind.kind !== "vital") {
        // By far the most common miss: a macOS "._name.vital" metadata sibling, which looks like a preset in the picker.
        const meta = /^\._/.test(file.name);
        const real = file.name.replace(/^\._/, "");
        say(meta
          ? `"${file.name}" is macOS metadata, not a preset — pick "${real}" instead (the one without the "._" prefix)`
          : `"${file.name}" is not a .vital preset (${kind.reason ?? kind.kind}); this importer takes one preset file`, true);
        return;
      }
      const parsed = mod.parseVitalText ? mod.parseVitalText(text)
        : (() => { try { return { ok: true, data: JSON.parse(text) }; } catch (e) { return { ok: false, reason: e?.message }; } })();
      if (!parsed.ok) { say(`"${file.name}" could not be read: ${parsed.reason}`, true); return; }
      const vital = parsed.data;
      try {
        const unknown = mod.vitalUnknownTopLevel?.(vital) ?? [];
        if (unknown.length) console.warn("Synth — " + file.name + " has top-level keys Vital does not define: " + unknown.slice(0, 6).join(", ") + (unknown.length > 6 ? ", …" : "") + " (kept in memory, not applied)");
      } catch { /* the report is a courtesy */ }
      if (parsed.trailing) console.warn(`Synth — ${file.name} has bytes after the preset object; they were ignored (Vital does the same)`);
      // The engine's own converters, fetched once and used for BOTH passes, so every value is normalised by the engine
      // rather than by a guess of mine. The name must NOT be "api": this block already reads an outer `api` above, and a
      // local `const api` here puts that outer name in the temporal dead zone for the whole block, so the earlier line
      // throws "cannot access before initialization" before any catch can see it. That cost three attempts at this switch.
      let engineApi = null;
      try { engineApi = (await import("./paramapi.js")) ?? engine.__sgrParamApi ?? null; } catch { engineApi = null; }
      const { preset, report } = mod.vitalToPreset(vital, file.name.replace(/\.vital$/i, ""), engineApi);
      const judged = mod.assessPreset(preset, mod.knownParamIds());
      if (!judged.ok) { say(`"${file.name}" was not applied: ${judged.note}`, true); return; }
      // the LFOs and the insides of the effects, through the same converters
      let extra = { params: {}, mapped: {}, dropped: {} };
      try {
        if (engineApi) {
          extra = mod.vitalExtraParams?.(vital, engineApi) ?? extra;
          const n = Object.keys(extra.params).length;
          Object.assign(preset.params, extra.params);
          if (n) console.info(`Synth — ${n} more parameters mapped from the LFOs and the effects`);
          const missing = Object.keys(extra.dropped ?? {});
          if (missing.length) console.info(`Synth — ${missing.length} parameter(s) have no counterpart here: ` + missing.slice(0, 4).join(", ") + (missing.length > 4 ? ", …" : ""));
        }
      } catch (e) { console.warn("Synth — the LFO and effect parameters could not be mapped: " + (e?.message ?? e)); }

      engine.loadPreset(preset);
      // SAVE IT WHERE THE PLAYER CAN SEE IT: the editor's dropdown is rendered from their user library in localStorage,
      // so a preset that only lives in the engine is invisible and is lost on reload. Repair the library while saving:
      // entries their reader cannot use make it return an empty list, and then the User group never appears at all.
      try {
        const KEY = "soundgineer.presets.v1";
        let list = [];
        let repaired = false;
        try {
          const raw = localStorage.getItem(KEY);
          const was = raw ? JSON.parse(raw) : [];
          if (Array.isArray(was)) list = was.filter((x) => x && typeof x.name === "string");
          else repaired = true;
          if (Array.isArray(was) && list.length !== was.length) repaired = true;
        } catch { repaired = true; }
        const kept = list.filter((x) => x.name !== preset.name);
        kept.push(preset);
        localStorage.setItem(KEY, JSON.stringify(kept));
        if (repaired) console.warn("Synth — your preset library had entries that could not be used; it was rewritten with the valid ones (" + kept.length + ")");
      } catch (e) {
        say("loaded, but it could not be saved to your library: " + (e?.message ?? e), true);
      }
      let wiringUsable = 0, wiringShapes = 0;   // reported below, and the wiring block below is their own scope
      // the wiring and the shapes: only the connections this engine can hold, with the rest named rather than dropped.
      // The store applies them on every engine it creates, because importing a preset replaces this channel's engine --
      // applying to whatever it pointed at in this moment registered routes on an object that was then discarded.
      try {
        const ids = mod.knownParamIds ? mod.knownParamIds() : null;
        const MOD_SOURCES = [...Array.from({ length: 6 }, (_, i) => `env${i + 1}`), ...Array.from({ length: 8 }, (_, i) => `lfo${i + 1}`),
                            "velocity", "keytrack", "random", ...Array.from({ length: 4 }, (_, i) => `macro${i + 1}`),
                            "modwheel", "pitchwheel", "aftertouch"];
        const { routes, skipped } = mod.vitalModRoutes?.(vital, ids, MOD_SOURCES) ?? { routes: [], skipped: [] };
        const shapes = mod.vitalLfoShapeApplications?.(vital) ?? [];
        const paramApi = await import("./paramapi.js").catch(() => null);
        const destIndex = {};
        for (const r of routes) if (paramApi) destIndex[r.dest] = paramApi.paramIndex(r.dest);
        const usable = routes.filter((r) => (destIndex[r.dest] ?? -1) >= 0 && MOD_SOURCES.includes(r.source));
        wiringUsable = usable.length; wiringShapes = shapes.length;
        console.info(`Synth — wiring: ${usable.length} usable of ${routes.length} route(s), ${Object.keys(destIndex).length} destination index/indices, sources ${MOD_SOURCES.length}, shapes ${shapes.length}`);
        await api.setWiring?.(selected, { routes: usable, shapes, sources: MOD_SOURCES, destIndex });
        console.info("Synth — wiring handed to the store for " + selected);
        if (usable.length || shapes.length) console.info(`Synth — ${usable.length} modulation route(s) and ${shapes.length} LFO shape(s) handed to the channel`);
        if (skipped?.length) console.warn(`Synth — ${skipped.length} Vital connection(s) have no counterpart here: ` + skipped.slice(0, 3).join("; ") + (skipped.length > 3 ? "; …" : ""));
      } catch (e) { console.warn("Synth — the modulation wiring could not be applied: " + (e?.message ?? e)); }

      engine.__sgrPreset = "user:" + preset.name;
      await api.setPreset?.(selected, preset.name);
      // FORCE the view to be rebuilt: the pool only rebuilds on its own when the preset NAME changes, so re-importing a
      // name that is already current used to leave the previous option list on screen -- "nothing changed".
      try { pool.reload(selected); } catch (e) { console.warn("Synth — could not rebuild the editor: " + (e?.message ?? e)); }
      // 1) the wavetables INSIDE this file: use them, so one file is complete
      const embedded = mod.vitalEmbeddedTables?.(vital) ?? [];
      for (const table of embedded.filter((x) => x.frames?.length)) {
        try {
          const samples = mod.flattenFrames(table.frames, table.frameSize);
          const name = `${preset.name} osc${table.osc + 1} (${table.kind === "wave" ? "Wave Source" : "Audio File Source"}).wav`;
          const blob = new Blob([mod.encodeWavFloat32(samples, table.sampleRate ?? 44100)], { type: "audio/wav" });
          await engine.importWavetableFile(Math.min(table.osc, 2), new File([blob], name, { type: "audio/wav" }));
          console.info(`Synth — osc${table.osc + 1} ← its embedded table (${table.frames.length} frames of ${table.frameSize})`);
        } catch (e) { console.warn(`Synth — osc${table.osc + 1} embedded table could not be used: ${e?.message ?? e}`); }
      }
      // Two regions only Vital 1.5.5 writes. They are named rather than ignored so a 1.5.5 preset is not silently partial.
      for (const [key, what] of [['custom_warps', 'custom wavetable warps'], ['random_values', 'randomisation seeds']]) {
        const region = vital?.settings?.[key];
        if (Array.isArray(region) && region.length) console.info(`Synth — "${preset.name}" carries ${region.length} ${what} (settings.${key}); this engine has no counterpart, so they are not loaded`);
      }

      // The sample oscillator is its own region and this engine has none: say so with its numbers rather than
      // pretending. Measured over 400 real presets, settings.sample is the only structured region besides the three
      // this importer already handles; custom_warps and random_values do not exist in any of them.
      try {
        const smp = vital?.settings?.sample;
        if (smp && typeof smp === "object" && (smp.samples || smp.length)) {
          const secs = (typeof smp.length === "number" && typeof smp.sample_rate === "number" && smp.sample_rate) ? (smp.length / smp.sample_rate).toFixed(2) : null;
          say(`"${preset.name}" also carries a sample oscillator (${smp.name ?? "unnamed"}${smp.sample_rate ? ", " + smp.sample_rate + " Hz" : ""}${secs ? ", " + secs + " s" : ""}) — this engine has no sample oscillator, so that part is not loaded`, true);
        }
      } catch { /* the region is optional */ }

      // 2) the wavetables it does NOT carry: name the file and hand it over
      const external = mod.externalAudioRefs?.(vital) ?? [];
      for (const table of embedded.filter((x) => !x.frames?.length)) {
        const wanted = external.filter((r) => r.osc === table.osc);
        if (wanted.length) console.warn(`Synth — osc${table.osc + 1} needs "${wanted.map((r) => r.name).join('", "')}", which is not inside this preset; load it with the Import button on that oscillator panel`);
        else console.warn(`Synth — osc${table.osc + 1}'s table is a Vital DSP chain (${table.type}) with no base waveform inside this file; load a wavetable with that panel's Import button`);
      }
      try {
        const appliedParams = { ...(preset.params ?? {}), ...((extra ?? {}).params ?? {}) };
        const pi = await import("./paramapi.js").catch(() => null);
        const check = (mod.verifyApplied && pi) ? mod.verifyApplied(engine, (id) => pi.paramIndex(id), appliedParams) : null;
        const keptSlots = (engine.modSlots ?? []).filter(Boolean).length;
        const keptShapes = (engine.lfoShapes ?? []).filter(Boolean).length;
        const layers = mod.vitalLayerReport?.({ parsed, mapping: report, extra, routes: wiringUsable, shapes: wiringShapes,
          applied: { slots: keptSlots, shapes: keptShapes, verifiedParams: check?.verified ?? null, ofParams: check?.of ?? null } });
        if (layers) console.info("Synth — " + layers.line);
        // Four states, kept apart on purpose: telling the player "there were warnings" hides which is which -- what the
        // engine has no counterpart for, what failed, what the engine did not keep, and what has not been checked.
        const unsupported = Object.keys({ ...(report?.dropped ?? {}), ...((extra ?? {}).dropped ?? {}) }).length;
        const notKept = check?.missing ?? [];
        say([
          `imported "${preset.name}" \u2192 ${selected}`,
          `file: read ok${parsed?.trailing ? ", trailing bytes ignored" : ""}`,
          `converted: ${judged.mapped} parameter(s) \u00b7 unsupported ${unsupported} \u00b7 wiring ${wiringUsable} route(s) \u00b7 ${wiringShapes} shape(s)`,
          `engine: ${keptSlots} modulation slot(s) \u00b7 ${keptShapes} shape(s) \u00b7 ${check ? `${check.verified}/${check.of} parameter(s) read back` : "read-back not checked"}`,
          notKept.length ? `read-back mismatch: ${notKept.slice(0, 4).join(", ")}${notKept.length > 4 ? ", \u2026" : ""}` : "read-back mismatch: none",
          "not verified: nothing here listens to the result, so the sound is not compared with Vital",
        ].join("\n"));
      } catch (e) { say(`imported "${preset.name}" \u2192 ${selected}, but the report could not be built: ` + (e?.message ?? e), true); }
    } catch (e) {
      say("the import stopped unexpectedly: " + (e?.message ?? e), true);
    }
  });
  // VISIBLE: the title bar, next to the other window controls -- inside the collapsed help block it could not be seen.
  try {
    const alt = win.querySelector("#synth-import-vital-2");
    if (alt) alt.addEventListener("click", () => vitalInput.click());
    const rs = win.querySelector("#synth-row-stamp");
    if (rs) rs.textContent = BUILD;
    // A page that was loaded before a newer build was deployed keeps running the old code forever -- the browser only
    // reads these files at load time. So ask the server what it has now and say so, loudly and visibly.
    try {
      const reload = win.querySelector("#synth-stale-reload");
      if (reload) reload.addEventListener("click", () => { if (typeof location.reload === "function") location.reload(); });
      fetch(import.meta.url, { cache: "no-store" })
        .then((r) => r.text())
        .then((text) => {
          const served = (text.match(/b1[0-9]{3}[a-z0-9]+/g) ?? []).sort().pop();
          if (!served || served === BUILD) return;
          const box = win.querySelector("#synth-stale");
          const what = win.querySelector("#synth-stale-text");
          if (what) what.textContent = `running ${BUILD}, the server has ${served} — reload to get it`;
          if (box) box.hidden = false;
          console.warn(`Synth — this page is running build ${BUILD} but the server serves ${served}; reload the page`);
        })
        .catch(() => { /* offline or file:// — nothing to compare */ });
    } catch { /* cosmetic */ }
  } catch { /* cosmetic */ }
  try {
    const bar = win.querySelector("#synth-bar");
    const close = win.querySelector("#synth-close");
    if (bar && vitalBtn) bar.insertBefore(vitalBtn, close ?? null);
    if (bar && !bar.contains(vitalBtn)) bar.appendChild(vitalBtn);
    win.appendChild(vitalInput);
    vitalInput.style.display = "none";
  } catch { /* cosmetic */ }
  // A stamp you can SEE, in the title bar: "no change" arguments end when the running build is on screen.
  try {
    const bar = win.querySelector("#synth-bar") ?? win.firstElementChild;
    const stamp = document.createElement("span");
    stamp.id = "synth-build-stamp";
    stamp.textContent = " build " + BUILD;
    stamp.style.cssText = "font:10px/1 ui-monospace,monospace;opacity:.6;margin-left:6px";
    const spacer = bar?.querySelector(".spacer");
    const last = document.createElement("span");
    last.id = "synth-last-import";
    last.title = "what the last Vital import did";
    if (bar) { if (spacer) { bar.insertBefore(last, spacer); bar.insertBefore(stamp, spacer); } else { bar.appendChild(last); bar.appendChild(stamp); } }
  } catch { /* cosmetic */ }
  // one document per channel, built once; switching only shows another one (see editors.js). No LRU: with a handful of
  // channels, destroying and rebuilding views is the churn we are trying to eliminate.
  const pool = createEditorPool({
    host: win.querySelector("#synth-sgr-host"),
    frameUrl: location.href.replace(/[^/]*$/, "") + "synth/soundgineer-frame.html",
    cap: 64, onStatus: (m) => console.info("Synth — " + m),
  });
  try { win.querySelector("#synth-frame")?.remove(); } catch { /* already gone */ }
  // Remove sound, per channel row. Delegated: the rows are rebuilt on every paint, and this leaves that loop alone.
  win.querySelector("#synth-channels")?.addEventListener("click", async (e) => {
    const btn = e.target?.closest?.(".synth-row-clear");
    if (!btn) return;
    e.stopPropagation();                       // do not also select the row
    e.preventDefault();
    const part = btn.dataset.part;
    try {
      if (api.setPreset) await api.setPreset(part, null);
      else if (api.rememberPreset) api.rememberPreset(part, null);
      console.info("Synth — " + part + " has no preset now, so it stays silent");
    } catch (err) { console.error("Synth — could not clear " + part + ": " + (err?.message ?? err)); }
    paint();
  });
  // clearing a channel's sound: our own control, so nothing of theirs is touched. A channel with no preset is silent.
  const clearBtn = document.createElement("button");
  clearBtn.id = "synth-clear-preset";
  clearBtn.type = "button";
  clearBtn.textContent = "Remove sound";
  clearBtn.title = "Forget this channel's preset: it stops sounding until you choose another";
  clearBtn.addEventListener("click", async () => {
    const part = selected;
    try {
      if (api.setPreset) await api.setPreset(part, null);
      else if (api.rememberPreset) api.rememberPreset(part, null);
      console.info("Synth — " + part + " has no preset now, so it stays silent");
    } catch (e) { console.error("Synth — could not clear " + part + ": " + (e?.message ?? e)); }
    paint();
  });
  try { win.querySelector("#synth-help")?.appendChild(clearBtn); } catch { /* the help block may be absent */ }

  const status = (t, bad = false) => { const el = win.querySelector("#synth-status"); el.textContent = t ?? ""; el.style.color = bad ? "#f66" : ""; };
  win.querySelector("#synth-close").addEventListener("click", () => set(false));
  win.querySelector("#synth-pan")?.addEventListener("click", (e) => {
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
        <td>${p?.preset ?? "—"}</td><td>${p?.voices ?? "—"}</td><td>${p ? (p.peak ?? 0).toFixed(2) : "—"}</td><td><button class="synth-row-clear" data-part="${part}" title="remove this channel's sound">×</button></td></tr>`);
    }
    win.querySelector("#synth-channels").innerHTML =
      `<table><thead><tr><th>ch</th><th>part</th><th>preset</th><th>voi</th><th>peak</th><th title="remove this channel's sound"></th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
    for (const tr of win.querySelectorAll("#synth-channels tr.clickable")) {
      tr.addEventListener("click", () => { selected = tr.dataset.part; builtEngine = null; builtFor = null; mountError = null; paint(); });
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
    if (on && open) pool.select(selected, api);   // the switch: build once, then only display
    if (on && open) pool.prepare(Object.keys(api.state?.().parts ?? {}), api);   // build them up front, so switching is instant
    host.style.display = on ? "block" : "none";
    // A channel that has no engine yet has engineOf() === null, which matched the never-built state and skipped the
    // mount for ever: the editor stayed on the previous channel, so a preset chosen for ch4 was written to main.
    const wanted = api.engineOf?.(selected) ?? null;
    if (on && open && !mounting && (builtFor !== selected || builtEngine !== wanted)) { mounting = true; mountEditor().finally(() => { mounting = false; }); }
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

  /**
   * Let the frame scroll. Their stylesheet hides overflow on html and body, and that is exactly what stopped the
   * browser's own gestures -- two-finger panning and zooming inside the editor -- from doing anything at all.
   */
  function allowNativeScrolling(frame) {
    try {
      const doc = frame.contentDocument;
      if (!doc || doc.__sgrScroll) return;
      doc.__sgrScroll = true;
      doc.documentElement.style.setProperty("overflow", "auto", "important");
      doc.body.style.setProperty("overflow", "auto", "important");
    } catch { /* the frame is not ready yet */ }
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
    // the frame's real box, never a second copy of the number: the CSS said 1200 while this said 1060, so at 100% the
    // bottom of the editor -- the on-screen keyboard -- was scaled as if the frame were shorter and got clipped away
    const DW = frame.offsetWidth || 1280;
    const DH = frame.offsetHeight || 1200;
    const fit = Math.max(0.2, Math.min((r.width || DW) / DW, (r.height || DH) / DH));
    const scale = fit * zoom;
    const cw = DW * scale, ch = DH * scale;
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
    // superseded by the editor pool: once it owns the views, this legacy path only ever found the removed
    // #synth-frame and threw "cannot read properties of null" on every paint
    if (pool) return;   // the pool owns every editor now: this legacy path only ever found the removed #synth-frame
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
      // keyed on the ENGINE, not on the channel name: a name change with the same engine meant the editor kept showing (and
      // editing) the previous channel's parameters, which is exactly the reported bug.
      if (builtFor === selected && builtEngine === engine) { fitFrame(); return; }
      installRightDragPan(frame);
      allowNativeScrolling(frame);
      // Mount ONCE. After that a channel switch is a repoint of the same view (the frame's __focus): nothing is
      // rebuilt, so their knob registry never holds dead canvases and no WebGL context is leaked.
      const already = builtEngine === engine;
      const kids = (already && typeof w.__focus === "function") ? (w.__focus(engine), 0) : w.__mount(engine);
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
      builtEngine = engine; builtFor = selected;
      fitFrame();
      status(`${selected}: editor built (${kids} sections) · out: ${api.link?.().out}`);
    } catch (e) {
      mountError = `could not be built: ${e?.message ?? e}`;
      console.error("Synth — mounting the editor failed", e);
    }
  }

  /**
   * Move the editor with the right mouse button while it is zoomed past the stage.
   *
   * The events have to be caught inside the frame: a pointer over an iframe belongs to that document, so the parent
   * never sees it. Only button 2 is taken, so their left-button interactions are untouched, and the context menu is
   * suppressed only so that it cannot interrupt a drag.
   */
  function installRightDragPan(frame) {
    try {
      const doc = frame.contentDocument;
      if (!doc || doc.__sgrPan) return;
      doc.__sgrPan = true;
      doc.addEventListener("contextmenu", (e) => e.preventDefault());
      doc.addEventListener("pointerdown", (e) => {
        if (e.button !== 2) return;
        const x0 = e.clientX, y0 = e.clientY, p0 = { ...pan };
        const move = (ev) => { pan = { x: p0.x + (ev.clientX - x0), y: p0.y + (ev.clientY - y0) }; placeFrame(); };
        const up = () => { doc.removeEventListener("pointermove", move, true); doc.removeEventListener("pointerup", up, true); doc.removeEventListener("pointercancel", up, true); };
        doc.addEventListener("pointermove", move, true);
        doc.addEventListener("pointerup", up, true);
        doc.addEventListener("pointercancel", up, true);
        e.preventDefault();
      }, true);
    } catch { /* the frame is not ready yet */ }
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
  return { el: win, button: btn, open: () => open, set, selected: () => selected, paint, mountEditor, position: () => (pos ? { ...pos } : null), zoom: () => zoom, pan: () => ({ ...pan }), placeFrame };
}
