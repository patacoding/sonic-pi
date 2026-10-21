// The loader, as a body: built into web/synth/pattern-prelude.js, where CHUNKS and META are in scope. It is not a module on
// its own, so it has no imports and assumes nothing but the two bindings the build puts above it.
//
// Contract: run(code) runs one program in the session and answers { output: [String], errors: [String] }. The runtime's own
// record stream is what it reads; console.log is never a criterion (this project has lost a whole frame's errors to a
// console that belonged to a different document).
//
// The states are the point. A caller may not run pattern code before READY, and the layer says so rather than failing later
// with `undefined method 'pplay'`:
//
//   idle      nothing sent yet
//   loading   n of total chunks accepted (progress is reported on every chunk, so the UI can show n/12)
//   ready     the chunks are in and the probe says the verbs and __p are really there
//   failed    a chunk raised, or the probe came back incomplete; the reason names the chunk
//   disabled  the verbs answer with a clear error and pstop has been sent
//
// load() is idempotent and safe to call twice: two callers share one promise.

const PROBE = `
probes = []
probes << respond_to?(:pplay)
probes << respond_to?(:ppattern)
probes << respond_to?(:pstop)
writable = begin
  __p.time = __p.time
  true
rescue StandardError, NoMethodError
  false
end
probes << writable
puts probes.inspect
"probe"
`;

const DISABLE = `
cls = SonicPi.current_lang.class
cls.class_eval do
  define_method(:pplay)    { |*_a, **_k| raise "the pattern layer is disabled" }
  define_method(:ppattern) { |*_a, **_k| raise "the pattern layer is disabled" }
  define_method(:pstop)    { |*_a, **_k| nil }
end
"disabled"
`;

export const PatternStatus = Object.freeze({
  IDLE: "idle", LOADING: "loading", READY: "ready", FAILED: "failed", DISABLED: "disabled",
});

export function createPatternLayer({ run, onState, chunks, files } = {}) {
  if (typeof run !== "function") throw new TypeError("createPatternLayer needs a run(code) function");
  // chunks/files may be supplied: the pipeline builds a deliberately broken copy to prove its timing assertions can fail,
  // and nothing else should ever pass them.
  const CH = chunks ?? CHUNKS;
  const FS = files ?? META.files;
  const state = { status: PatternStatus.IDLE, done: 0, total: CH.length, error: null, files: FS.slice() };
  let loading = null;
  const set = (next) => { state.status = next.status ?? state.status; state.error = next.error ?? null; onState?.({ ...state }); };

  const load = () => {
    if (loading) return loading;
    loading = (async () => {
      set({ status: PatternStatus.LOADING });
      for (let i = 0; i < CH.length; i++) {
        const res = await run(CH[i]);
        const errors = res?.errors ?? [];
        if (errors.length) {
          set({ status: PatternStatus.FAILED, error: `chunk ${i + 1}/${CH.length} (${FS[i] ?? "?"}): ${errors[0]}` });
          return state;
        }
        state.done = i + 1;
        onState?.({ ...state });
        // Yield between chunks: twelve programs in one burst is a blocked page, and a blocked page is a defect here, not a
        // cosmetic issue. A macrotask lets the frame paint and the progress state show.
        await new Promise((r) => setTimeout(r, 0));
      }
      const probe = await run(PROBE);
      const text = (probe?.output ?? []).join(" ");
      // The record's text is the inspected array; three trues are the verbs, the fourth is __p being writable.
      const ok = (text.match(/true/g) ?? []).length >= 4;
      if (!ok) {
        set({ status: PatternStatus.FAILED, error: `the prelude loaded but its probe answered ${text || "(nothing)"}` });
        return state;
      }
      set({ status: PatternStatus.READY });
      return state;
    })();
    return loading;
  };

  const disable = async () => {
    await run("pstop");
    const res = await run(DISABLE);
    if ((res?.errors ?? []).length) { set({ status: PatternStatus.FAILED, error: (res.errors)[0] }); return state; }
    set({ status: PatternStatus.DISABLED });
    return state;
  };

  return { get state() { return { ...state }; }, load, disable, ready: () => state.status === PatternStatus.READY };
}
