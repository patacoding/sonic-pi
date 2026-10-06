// SPDX-License-Identifier: AGPL-3.0-or-later
// Our own settings, and the one thing that is easy to get wrong about them.
//
// A stored setting has three states, not two: absent, present-and-valid, and present-but-unusable.
// Collapsing "absent" into a value is how a stored 0 gets mistaken for nothing --
//
//     const v = Number(localStorage.getItem(KEY));          // null -> 0  (!)
//     return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.82;
//
// which is exactly what happened here: the opacity slider's minimum was 30% when that guard was
// written, 0 could not be meant, and `v > 0` read as "sensible". Then the slider was allowed down to
// 0 -- and 0 was rejected, so the player's setting came back as the default 0.82 on the next read,
// which is a theme switch, a reload, or the panel redrawing itself. The bug is not the comparison;
// it is passing a value and a missing value through the same channel.
//
// So reads go through here, and each one answers "what did the player choose?", with an absent or
// unusable entry giving the fallback and a legitimate 0 or false coming back as 0 or false.

/**
 * One step of a control a key press moves: the opacity, up or down by a fixed amount.
 *
 * Pure, and here rather than in the key handler, because the two things that are easy to get wrong are
 * arithmetic and are worth pinning: the ends CLAMP rather than wrap (a shortcut held down must stop at
 * 0 and at 1, not leap from one end to the other mid-performance), and the value is kept to the step's
 * own precision so that twenty presses down and twenty presses up come back to where they started
 * rather than to 0.7999999999999999.
 *
 * @param {number} current 0..1
 * @param {number} direction +1 for more opaque, -1 for less
 * @param {number} step how much one press moves it
 */
export function stepLevel(current, direction, step = 0.05) {
  const from = Number.isFinite(current) ? current : 0;
  const to = Math.min(1, Math.max(0, from + (direction >= 0 ? step : -step)));
  const places = Math.max(0, Math.ceil(-Math.log10(step)));        // 0.05 -> 2 places
  return Number(to.toFixed(places));
}

export function createSettings(store = localStorage) {
  /** The raw string, or null when there is none -- the distinction the rest of this file is about. */
  const raw = (key) => {
    try { return store.getItem(key); } catch { return null; }    // a browser may refuse storage entirely
  };

  return {
    /** A number the player chose. Absent, unparsable, or outside [min, max] gives the fallback. */
    number(key, { min = -Infinity, max = Infinity, fallback }) {
      const text = raw(key);
      // an empty entry is not a choice: `set(key, 0)` writes "0", and Number("") would read as a
      // perfectly good 0 -- the same absent-versus-zero muddle in its other direction
      if (text == null || text.trim() === "") return fallback;
      const value = Number(text);
      return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
    },

    /** A switch: "1"/"0" as this file writes them, and anything else gives the fallback. */
    bool(key, fallback) {
      const text = raw(key);
      if (text === "1") return true;
      if (text === "0") return false;
      return fallback;
    },

    set(key, value) {
      try { store.setItem(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value)); } catch { /* nothing to do about it */ }
    },
  };
}
