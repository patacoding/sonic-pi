// The pattern layer's primitives, for the editor's completion list. Data only: the editor reads web/data/completion.json, so the
// build merges these entries into it and nothing in the editor needs to know the pattern layer exists.
//
// Each entry carries the three fields the list already uses: summary (a row's short line), usage (a call one can copy) and doc
// (the reference pane). The wording follows docs/pattern-user-guide.md.
export const completion = {
  pplay: {
    summary: "Play a pattern as a track",
    usage: 'pplay ppattern(["c2", "e2"]), use: :play, name: :melody',
    doc: "<p>Starts a track from a pattern. If a track of the same <code>name:</code> is already playing, the new version takes over at the next loop line, so an edit never overlaps itself.</p><p>Options: <code>use:</code> (the verb each event is sent to), <code>name:</code>, <code>cycle_beats:</code> (the track's own length; the rest of the loop is silent), <code>synth:</code> (a track's own synth, set inside its thread), <code>align:</code>, <code>cycles:</code>, and any other option is passed to the verb.</p>",
  },
  ppattern: {
    summary: "A pattern from an array (the only way to write a track)",
    usage: 'ppattern(["c2", "e2", "g2", "b4"])',
    doc: "<p>An array is the track: four elements are four events dividing the cycle; nesting subdivides (<code>[[\"a\", \"b\"], \"c\"]</code>); <code>\"~\"</code> or <code>nil</code> is a rest. A string is one value, not a track.</p>",
  },
  pstop: {
    summary: "Stop one track, or all of them",
    usage: "pstop :melody",
    doc: "<p>With a name, that track leaves at its next cycle line; without one, every track does.</p>",
  },
  prun: {
    summary: "Run a pattern's cycles once",
    usage: "prun(ppattern([1, 2, 3]))",
    doc: "<p>The library's own helper: the pattern's events for one cycle.</p>",
  },
  pdeclared: {
    summary: "Bracket a Run (the layer's own)",
    usage: "pdeclared :begin",
    doc: "<p>Used by the editor around a Run: a track the Run no longer declares is stopped, so commenting a <code>pplay</code> out stops sounding.</p>",
  },
};

// The operators, one line each: name, usage, summary.
const ops = [
  ["pval", "pval(57, 60, 64)", "One event whose value is several numbers (a chord)"],
  ["psegment", "psegment(psine, 8)", "A signal sampled into n events per cycle"],
  ["prange", "prange(psine, 40, 60)", "Map a signal's 0..1 onto lo..hi"],
  ["poffset", "poffset(psine, 0.25)", "Shift a signal in time"],
  ["pscale", "pscale(psine, 2)", "Scale a signal's output"],
  ["padd", "padd(psine, 1)", "Add a signal or a constant"],
  ["pslow_sig", "pslow_sig(psine, 2)", "Stretch a signal in time"],
  ["pfast_sig", "pfast_sig(psine, 2)", "Compress a signal in time"],
  ["psine", "psine", "A sine signal (0.5 → 1 → 0.5 → 0)"],
  ["psaw", "psaw", "A saw signal (0 → 1)"],
  ["psquare", "psquare", "A square signal (0 then 1)"],
  ["ptriangle", "ptriangle", "A triangle signal (0 → 1 → 0)"],
  ["prand", "prand", "One random value per cycle"],
  ["pnoise", "pnoise", "Continuous random values"],
  ["pply", "pply(ppattern([1, 2]), 2)", "Repeat every event n times"],
  ["piter", "piter(ppattern([1, 2, 3]), 2)", "Rotate the pattern by one each cycle"],
  ["piter_back", "piter_back(ppattern([1, 2, 3]), 2)", "Rotate the other way"],
  ["pearly", "pearly(ppattern([1, 2]), 0.5)", "Play the first half only, as a longer event"],
  ["plate", "plate(ppattern([1, 2]), 0.5)", "Play the second half only"],
  ["pswing", "pswing(ppattern([1, 2, 3, 4]), 2)", "Swing every second event"],
  ["pswing_by", "pswing_by(ppattern([1, 2, 3, 4]), 0.2, 2)", "Swing by an amount"],
  ["plast_of", "plast_of(ppattern([1, 2, 3]), 2) { |p| p }", "Keep the last n events of each cycle"],
  ["ptranspose", "ptranspose(ppattern([1, 2, 3]), 12)", "Transpose by semitones"],
  ["pzoom", "pzoom(ppattern([1, 2, 3, 4]), 0.0, 0.5)", "Play a slice, stretched over the whole cycle"],
  ["pcompress", "pcompress(ppattern([1, 2, 3, 4]), 0.0, 0.5)", "Squeeze the pattern into a slice, rest after"],
  ["pfast_gap", "pfast_gap(ppattern([1, 2, 3, 4]), 2)", "Faster, without repeating"],
  ["plinger", "plinger(ppattern([1, 2]), 0.5)", "Keep the first fraction as one long event"],
  ["peuclid_legato", "peuclid_legato(ppattern([1]), 3, 8)", "Euclidean rhythm, legato"],
  ["ppalindrome", "ppalindrome(ppattern([1, 2, 3]))", "Forward then backward"],
  ["pscale_to", "pscale_to(ppattern([0, 1, 2]), 60, :major)", "Map degrees onto a scale from a root"],
  ["pchord", "pchord(ppattern([\"57:minor\"]))", "A pattern of chords from a root:name spec"],
];
for (const [name, usage, summary] of ops) {
  completion[name] = { summary, usage, doc: `<p>Pattern operator. <code>${usage}</code></p>` };
}
export default completion;
