// SPDX-License-Identifier: AGPL-3.0-or-later
// The SynthDef panel: compile SuperCollider source through the service (tools/synthdef-server) and load what
// comes back into the running engine, without leaving the app.
//
// It is deliberately thin. The service does the compiling and returns a URL; the page's only job is
//   * to send source, poll the job (plain HTTP, no websockets), and show what came back,
//   * to put `<service>/defs/<name>.scsyndef` into `load_synthdef "<url>"` (the app's own path -- Sonic Pi
//     registers it, the Docs gain a page from the `.json` beside it, and `synth :name` works),
//   * and to say so, in the Log, the way the rest of our layer does ("Synth — compiled spfm (651 B)").
//
// Nothing here is required by the rest of the app: if the service is not running, the section says so and
// everything else keeps working. The endpoint is a setting (localStorage `sp-synthdef-url`), because this is
// also the shape a hosted service would take.
//
// Verified against the real thing by:
//   tools/synthdef-server/probe-http.mjs      the service's protocol, over HTTP (7/7)
//   tools/synthdef-server/probe-browser.mjs   a compiled def loaded in a real Chrome and heard (4/4)
//   tools/synthdefs-ui-probe/check.mjs        this file's wiring, in jsdom, against a stubbed service
const DEFAULTS = { url: "http://127.0.0.1:8461", source: "" };
const STYLE_ID = "synthdefs-ui-style";
const CSS = `
.sd-panel{display:flex;flex-direction:column;gap:.45em;width:100%}
.sd-status{font-family:var(--code-font,monospace);font-size:var(--t-tiny,11px);opacity:.9;white-space:pre-wrap}
.sd-status.sd-bad{color:#e08a5a;opacity:1}
.sd-source{width:100%;min-height:9em;resize:vertical;font-family:var(--code-font,monospace);font-size:var(--t-tiny,11px);
  background:transparent;color:inherit;border:1px solid var(--pop-border,#3a3a42);border-radius:8px;padding:.5em}
.sd-list{display:flex;flex-direction:column;gap:.25em;width:100%}
.sd-def{display:flex;align-items:center;gap:.45em}
.sd-def span{flex:1;font-family:var(--code-font,monospace);font-size:var(--t-tiny,11px);opacity:.9}
.sd-row{display:flex;gap:.4em;flex-wrap:wrap}
`;

const el = (tag, cls = "", text = null) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * @param {{
 *   synth?: object,
 *   onSay?: (text: string) => void,
 *   onProblem?: (text: string) => void,
 *   service?: string,
 *   store?: Storage,
 *   fetchImpl?: typeof fetch,
 *   session?: object,
 * }} opts
 */
export function createSynthdefs({
  synth = null,
  onSay = null,
  onProblem = null,
  service = DEFAULTS.url,
  store = globalThis.localStorage ?? null,
  fetchImpl = globalThis.fetch?.bind(globalThis) ?? null,
  session = null,
} = {}) {
  const say = (t) => (onSay ? onSay(t) : console.info(`Synth — ${t}`));
  const problem = (t) => (onProblem ? onProblem(t) : console.warn(t));
  const read = (k, d) => { try { return store?.getItem(k) ?? d; } catch { return d; } };
  const write = (k, v) => { try { store?.setItem(k, v); } catch { /* private mode: not fatal */ } };

  const state = {
    url: (read("sp-synthdef-url", service) || service).replace(/\/+$/, ""),
    source: read("sp-synthdef-source", DEFAULTS.source),
    note: "",                                              // the last action's outcome (compile/load)
    library: "the service is not running: start it with tools/synthdef-server/service.sh start",
    bad: false,
    busy: false,
    defs: [],
    job: null,
  };
  let listBox = null, statusBox = null, sourceBox = null;

  const sessionOf = () => session ?? globalThis.sonicPi?.session ?? null;

  /**
   * A short note to play after a compile, built ONLY from controls the def actually has (Sonic Pi validates
   * what you pass, and a def without `gate` has no `sustain`). The point is that compiling and hearing the
   * result is one action -- otherwise every iteration ends with writing Ruby by hand.
   */
  function auditionLine(name, controls = []) {
    const has = (c) => controls.includes(c);
    const opts = [];
    if (has("note")) opts.push("note: 60");
    if (has("amp")) opts.push("amp: 0.6");
    if (has("gate")) opts.push("sustain: 1.5");
    if (has("release")) opts.push("release: 0.4");
    return `synth :${name}${opts.length ? `, ${opts.join(", ")}` : ""}\nsleep 3\n`;
  }
  const api = (p) => `${state.url}${p}`;

  function paint() {
    if (statusBox) {
      statusBox.textContent = [state.note, state.library].filter(Boolean).join("\n");
      statusBox.classList.toggle("sd-bad", state.bad);
    }
    if (listBox) {
      listBox.textContent = "";
      if (!state.defs.length) listBox.appendChild(el("span", "sd-status", "(no defs on the service yet)"));
      for (const d of state.defs) {
        const row = el("div", "sd-def");
        row.appendChild(el("span", "", `${d.name}${d.controls?.length ? ` — ${d.controls.length} controls` : ""}`));
        const load = el("button", "sp-mini-btn", "load");
        load.addEventListener("click", () => loadDef(d.name, { play: true, controls: d.controls }));
        row.appendChild(load);
        listBox.appendChild(row);
      }
    }
  }

  /** The important line (an action's outcome). It survives a library refresh. */
  const setStatus = (text, bad = false) => { state.note = text; state.bad = bad; paint(); };
  /** The library line (how many defs the service has). It never overwrites the note. */
  const setLibrary = (text, bad = false) => { state.library = text; state.bad = bad; paint(); };

  /** Ask the service what it has. Failure is not an error the player must act on: it is a status line. */
  async function refresh() {
    if (!fetchImpl) return false;
    try {
      const r = await fetchImpl(api("/defs"));
      if (!r.ok) throw new Error(`the service answered ${r.status}`);
      const body = await r.json();
      state.defs = body.defs ?? [];
      setLibrary(`${state.defs.length} def(s) on ${state.url}${state.defs.length ? "" : " — compile one below"}`, false);
      paint();
      return true;
    } catch (e) {
      setLibrary(`no answer from ${state.url} (${e.message ?? e}). Start it with ` +
        "tools/synthdef-server/service.sh start", true);
      return false;
    }
  }

  /** One compile: POST, then poll the job the plain-HTTP way. The service caches by source hash. */
  async function compile(code = null, { play = true } = {}) {
    const src = code ?? sourceBox?.value ?? state.source;
    if (!src.trim()) { setStatus("nothing to compile: write a SynthDef first", true); return null; }
    state.source = src;
    write("sp-synthdef-source", src);
    if (!fetchImpl) { setStatus("this browser cannot fetch", true); return null; }
    state.busy = true;
    try {
      setStatus("compiling…");
      const posted = await fetchImpl(api("/compile"), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: src }),
      });
      if (posted.status === 400) {
        const e = await posted.json().catch(() => ({}));
        setStatus(`the service refused it: ${e.error ?? posted.status}`, true);
        return null;
      }
      if (!posted.ok && posted.status !== 202) {
        setStatus(`the service answered ${posted.status}`, true);
        return null;
      }
      let job = await posted.json();
      if (posted.status === 202) {
        state.job = job.job;
        for (let i = 0; i < 80 && job.state !== "done" && job.state !== "error"; i++) {
          await new Promise((r) => setTimeout(r, 250));
          const r = await fetchImpl(api(`/jobs/${job.job}`));
          if (!r.ok) { setStatus(`the job disappeared (${r.status})`, true); return null; }
          job = await r.json();
          if (job.state === "compiling") setStatus("compiling… (sclang is working)");
        }
      }
      if (job.state === "error") {
        const e = job.error ?? { message: "unknown error" };
        const extra = (e.sclang ?? []).join("\n");
        setStatus(`${e.message ?? "compile failed"}${extra ? `\n${extra}` : ""}`, true);
        problem(`the SynthDef did not compile: ${e.message ?? "unknown error"}`);
        return null;
      }
      if (job.state !== "done") { setStatus(`the job did not finish (${job.state})`, true); return null; }
      const names = (job.defs ?? []).map((d) => d.name);
      setStatus(`compiled ${names.join(", ")}${job.cached ? " (from the cache)" : ""}` +
        `${job.defs?.[0]?.bytes ? ` — ${job.defs[0].bytes} B` : ""}`, false);
      say(`compiled ${names.join(", ")}${job.cached ? " (from the cache)" : ""}`);
      await refresh();
      for (const d of job.defs ?? []) if (d.url) await loadDef(d.name, { play, controls: d.controls });  // in
      // order and awaited: the status must end up saying what actually happened, and a failure is not silent
      return job;
    } catch (e) {
      setStatus(`the service is not reachable at ${state.url} (${e.message ?? e})`, true);
      return null;
    } finally {
      state.busy = false;
    }
  }

  /** `load_synthdef "<url>"`, run through the app's own session -- the path the probes verified end to end. */
  async function loadDef(name, { play = false, controls = null } = {}) {
    const s = sessionOf();
    if (!s?.run) {
      // say it WHERE THE PLAYER IS LOOKING (the row above the list), not only in the Log
      setStatus(`cannot load ${name}: the session is not available yet -- press Run once, then load again`, true);
      problem(`cannot load ${name}: the session is not available (press Run once)`);
      return false;
    }
    try {
      const known = controls ?? state.defs.find((d) => d.name === name)?.controls ?? [];
      const line = `load_synthdef "${api(`/defs/${name}.scsyndef`)}"\nsleep 0.25\n` + (play ? auditionLine(name, known) : "");
      await s.run(line);
      setStatus(`loaded ${name}${play ? " and played a note" : ""}: it is registered, so \`synth :${name}\` works now`, false);
      say(`loaded ${name}${play ? " and auditioned it" : ""} (its .json beside it gives the Docs page and the knobs)`);
      return true;
    } catch (e) {
      setStatus(`could not load ${name}: ${e.message ?? e}`, true);
      return false;
    }
  }

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  /** The panel's section, in the app's declarative item language (gfx-ui.js: note/button/custom). */
  function panelSection() {
    installStyle();
    const rows = [];
    const head = el("div", "sd-row");
    const refreshBtn = el("button", "sp-mini-btn", "refresh the library");
    refreshBtn.addEventListener("click", () => refresh());
    const compilePlayBtn = el("button", "sp-mini-btn", "compile & play");
    compilePlayBtn.addEventListener("click", () => compile(null, { play: true }));
    const compileBtn = el("button", "sp-mini-btn", "compile only");
    compileBtn.addEventListener("click", () => compile(null, { play: false }));
    head.append(compilePlayBtn, compileBtn, refreshBtn);
    rows.push(head);

    sourceBox = el("textarea", "sd-source");
    sourceBox.value = state.source || EXAMPLE;
    sourceBox.spellcheck = false;
    sourceBox.addEventListener("input", () => { state.source = sourceBox.value; write("sp-synthdef-source", state.source); });
    sourceBox.addEventListener("keydown", (e) => {                     // Ctrl/Cmd+Enter compiles, as in an IDE
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); e.stopPropagation(); compile(null, { play: true }); }
      e.stopPropagation();                                             // the app's shortcuts are not for this box
    });
    rows.push(sourceBox);

    statusBox = el("div", "sd-status");
    rows.push(statusBox);

    const list = el("div", "sd-list");
    listBox = list;
    rows.push(list);

    rows.push(el("div", "sd-status",
      `service: ${state.url}   Ctrl/Cmd+Enter = compile & play; then play it from your code: synth :name`));
    const wrap = el("div", "sd-panel");
    wrap.append(...rows);
    paint();
    queueMicrotask(() => refresh());                                    // a status line, never a thrown error
    return { title: "SynthDefs", items: [{ kind: "custom", make: () => wrap }] };
  }

  return {
    panelSection,
    compile,
    loadDef,
    refresh,
    get state() { return { ...state, status: [state.note, state.library].filter(Boolean).join("\n") }; },
    setServiceUrl(url) {
      state.url = String(url).replace(/\/+$/, "");
      write("sp-synthdef-url", state.url);
      return refresh();
    },
  };
}

/** The starter every SuperCollider player expects, and a def that fits Sonic Pi's conventions (`cutoff` is a
 * MIDI note, hence `.midicps`). Shown in the box until the player writes their own -- and kept in localStorage
 * after that. */
export const EXAMPLE = `SynthDef(\\spfm, { |out = 0, note = 60, amp = 0.3, ratio = 2, index = 3, cutoff = 110, release = 0.6|
    var freq = note.midicps;
    var mod = SinOsc.ar(freq * ratio, 0, freq * ratio * index);
    var env = EnvGen.kr(Env.perc(0.005, release), doneAction: 2);
    var sig = RLPF.ar(SinOsc.ar(freq + mod) * 0.5, cutoff.midicps, 0.4);
    Out.ar(out, Pan2.ar(sig * env * amp, 0));
}).add;
`;
