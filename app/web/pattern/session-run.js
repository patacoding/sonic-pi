// Adapts the session handle to the loader's contract: run(code) -> { output, errors }.
//
// The handle answers with a job id, not with records, so this collects the records that job produced. The layer's chunks
// are definitions only -- they do not sleep -- so a short settle is enough and a timeout is the backstop, not the mechanism.
// A chunk that raises produces an error record for its job, and that is what the loader turns into "failed at chunk n".
export function createSessionRun(session, { settleMs = 90, timeoutMs = 4000 } = {}) {
  if (!session || typeof session.run !== "function") throw new TypeError("createSessionRun needs a session with run()");
  return async (code) => {
    const job = await session.run(code);
    const output = [];
    const errors = [];
    const deadline = performance.now() + timeoutMs;
    const seen = new Set();
    while (performance.now() < deadline) {
      for (const r of session.recent(300)) {
        if (r?.job !== job) continue;
        const key = `${r.kind}:${r.t}:${r.time}:${r.text ?? r.message ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (r.kind === "output") output.push(String(r.text ?? ""));
        else if (r.kind === "error") errors.push(`${r.class}: ${String(r.message ?? "").split("\n")[0]}`);
      }
      if (errors.length) break;
      if (performance.now() > deadline - timeoutMs + settleMs) break;   // a definition-only chunk: settled, not finished
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { output, errors };
  };
}

/** The handle, wherever it is: this page, or the app that opened this page. */
export function findSession(win = globalThis) {
  try { if (win.sonicPiSession) return { session: win.sonicPiSession, where: "this page" }; } catch { /* cross-origin */ }
  try { if (win.opener?.sonicPiSession) return { session: win.opener.sonicPiSession, where: "the app that opened this page" }; } catch { /* cross-origin */ }
  return { session: null, where: null };
}
