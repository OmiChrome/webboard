import { describe, expect, it } from 'vitest';
import { findFunctions, parseDiagnostics, preprocessSketch } from '../arduino/preprocess';

describe('sketch preprocessing (parity with server/src/sketch.rs)', () => {
  it('finds top-level functions and their lines', () => {
    const src = 'int x = 3;\nvoid setup() {\n}\n\nint add(int a, int b) { return a + b; }\nvoid loop() { if (x) { add(1,2); } }\n';
    const defs = findFunctions(src);
    expect(defs.map((d) => d.prototype)).toEqual(['void setup();', 'int add(int a, int b);', 'void loop();']);
    expect(defs[0].line).toBe(2);
  });
  it('ignores braces in comments and strings', () => {
    const src = '// void fake() {\n/* int nope() { */\nconst char* s = "{ }";\nvoid real(char c) {\n  char d = \'{\';\n}\n';
    expect(findFunctions(src)).toEqual([{ prototype: 'void real(char c);', line: 4 }]);
  });
  it('skips structs, enums and initializers', () => {
    const src = 'struct P { int x; };\nint arr[] = {1,2,3};\nenum E { A, B };\nP make() { P p; return p; }\n';
    expect(findFunctions(src).map((d) => d.prototype)).toEqual(['P make();']);
  });
  it('inserts prototypes with #line markers', () => {
    const out = preprocessSketch('#define N 3\n\nvoid loop() { helper(); }\nvoid helper() {}\n');
    expect(out.startsWith('#include <Arduino.h>\n#line 1 "sketch.ino"\n#define N 3\n\n')).toBe(true);
    expect(out).toContain('void loop();\nvoid helper();\n#line 3 "sketch.ino"\nvoid loop()');
  });
  it('parses gcc diagnostics', () => {
    const d = parseDiagnostics("sketch.ino: In function 'void loop()':\nsketch.ino:7:3: error: 'foo' was not declared in this scope\n");
    expect(d).toEqual([{ line: 7, column: 3, severity: 'error', message: "'foo' was not declared in this scope" }]);
  });
});
