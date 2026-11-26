/**
 * Arduino sketch -> C++ (same rules as server/src/sketch.rs):
 * prepend Arduino.h, generate prototypes for top-level functions, and add
 * #line directives so diagnostics point at the user's lines.
 */

const FN_HEAD = /^\s*((?:[A-Za-z_][\w:<>]*[\s*&]+)+?)([A-Za-z_]\w*)\s*\(([^()]*)\)\s*(const)?\s*$/s;
const NOT_TYPES = new Set([
  'if', 'else', 'for', 'while', 'switch', 'return', 'do', 'struct', 'class', 'enum', 'union',
  'namespace', 'typedef', 'using', 'template', 'operator', 'new', 'delete',
]);

/** Blank comments, string/char literals and preprocessor lines, keeping offsets and newlines. */
function mask(src: string): string {
  const out = src.split('');
  let i = 0;
  let lineStart = true;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (lineStart && c === '#') {
      while (i < n && src[i] !== '\n') {
        if (src[i] === '\\' && src[i + 1] === '\n') {
          out[i] = ' ';
          i += 2;
          continue;
        }
        out[i++] = ' ';
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) {
        out[i] = ' ';
        if (i + 1 < n) out[i + 1] = ' ';
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') out[i++] = ' ';
        if (i < n) out[i++] = ' ';
      }
      i++;
      lineStart = false;
      continue;
    }
    if (c === '\n') lineStart = true;
    else if (!/\s/.test(c)) lineStart = false;
    i++;
  }
  return out.join('');
}

export interface FunctionDef {
  prototype: string;
  line: number;
}

export function findFunctions(src: string): FunctionDef[] {
  const m = mask(src);
  const defs: FunctionDef[] = [];
  let depth = 0;
  let paren = 0;
  let segStart = 0;
  for (let i = 0; i < m.length; i++) {
    const c = m[i];
    if (c === '(') paren++;
    else if (c === ')') paren--;
    else if (c === '{') {
      if (depth === 0 && paren === 0) {
        const seg = m.slice(segStart, i);
        const caps = FN_HEAD.exec(seg);
        if (caps) {
          const ret = caps[1].trim().split(/\s+/).join(' ');
          const name = caps[2];
          const first = ret.split(/[ *&]/)[0];
          if (!NOT_TYPES.has(name) && !NOT_TYPES.has(first) && !ret.includes('=')) {
            const args = caps[3].trim().split(/\s+/).filter(Boolean).join(' ');
            const lead = seg.length - seg.trimStart().length;
            const start = segStart + lead;
            const line = 1 + (m.slice(0, start).match(/\n/g)?.length ?? 0);
            defs.push({ prototype: `${ret} ${name}(${args})${caps[4] ? ' const' : ''};`, line });
          }
        }
      }
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) segStart = i + 1;
    } else if (c === ';' && depth === 0 && paren === 0) segStart = i + 1;
  }
  return defs;
}

export function preprocessSketch(src: string, fileName = 'sketch.ino'): string {
  const defs = findFunctions(src);
  const lines = src.split('\n');
  const insertAt = defs[0]?.line ?? lines.length + 1;
  const out: string[] = ['#include <Arduino.h>', `#line 1 "${fileName}"`];
  lines.forEach((line, idx) => {
    const lineno = idx + 1;
    if (lineno === insertAt) {
      for (const d of defs) out.push(d.prototype);
      out.push(`#line ${lineno} "${fileName}"`);
    }
    out.push(line);
  });
  return out.join('\n') + '\n';
}

export interface ParsedDiagnostic {
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'note';
  message: string;
}

export function parseDiagnostics(log: string, file = 'sketch.ino'): ParsedDiagnostic[] {
  const esc = file.replace(/\./g, '\\.');
  const re = new RegExp(`^${esc}:(\\d+):(?:(\\d+):)?\\s*(error|warning|note|fatal error):\\s*(.*)$`, 'gm');
  const out: ParsedDiagnostic[] = [];
  for (const m of log.matchAll(re)) {
    out.push({
      line: Number(m[1]),
      column: m[2] ? Number(m[2]) : 1,
      severity: m[3] === 'fatal error' ? 'error' : (m[3] as ParsedDiagnostic['severity']),
      message: m[4].trim(),
    });
  }
  return out;
}
