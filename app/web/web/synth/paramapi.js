// The engine's own parameter helpers, in one place so the importer can convert values faithfully.
// valueToNorm(def, value) turns a real frequency/time/gain into this engine's normalised 0..1 slot.
import { PARAMS, paramDef, valueToNorm, normToValue, paramIndex } from "./vendor/soundgineer-params.js";
export { PARAMS, paramDef, valueToNorm, normToValue, paramIndex };
export const knownIds = () => new Set(PARAMS.map((p) => p.id));
