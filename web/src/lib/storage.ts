/** Local-first sketch storage: everything lives on the device. */

export interface Sketch {
  id: string;
  name: string;
  source: string;
  updatedAt: number;
  exampleId?: string;
}

const KEY = 'bitbench.sketches.v1';
const CURRENT = 'bitbench.current';

export function loadSketches(): Sketch[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Sketch[]) : [];
  } catch {
    return [];
  }
}

export function saveSketches(list: Sketch[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable (private mode): keep working in memory */
  }
}

export function loadCurrentId(): string | null {
  try {
    return localStorage.getItem(CURRENT);
  } catch {
    return null;
  }
}

export function saveCurrentId(id: string) {
  try {
    localStorage.setItem(CURRENT, id);
  } catch {
    /* ignore */
  }
}

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export const BLANK_SKETCH = `void setup() {
  // put your setup code here, to run once:

}

void loop() {
  // put your main code here, to run repeatedly:

}
`;
