/**
 * Parse a Serial Plotter line. Accepts the Arduino IDE 2 formats:
 *   "12 34 56"   "12,34,56"   "sin:12 cos:34"   "sin:12,cos:34"
 */
export function parsePlotLine(line: string): Record<string, number> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/[\s,;\t]+/).filter(Boolean);
  const out: Record<string, number> = {};
  let idx = 1;
  for (const p of parts) {
    const m = /^([^:]+):(-?[\d.eE+-]+)$/.exec(p);
    if (m) {
      const v = Number(m[2]);
      if (!Number.isFinite(v)) return null;
      out[m[1]] = v;
    } else {
      const v = Number(p);
      if (!Number.isFinite(v)) return null;
      out[`value ${idx++}`] = v;
    }
  }
  return Object.keys(out).length ? out : null;
}
