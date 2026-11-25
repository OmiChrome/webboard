import { describe, expect, it } from 'vitest';
import { parsePlotLine } from '../plot';

describe('parsePlotLine', () => {
  it('parses labelled values', () => {
    expect(parsePlotLine('sin:12.5 cos:-3')).toEqual({ sin: 12.5, cos: -3 });
    expect(parsePlotLine('a:1,b:2\r')).toEqual({ a: 1, b: 2 });
  });
  it('parses bare numbers', () => {
    expect(parsePlotLine('1 2 3')).toEqual({ 'value 1': 1, 'value 2': 2, 'value 3': 3 });
  });
  it('ignores text lines', () => {
    expect(parsePlotLine('Hello from Bitbench!')).toBeNull();
    expect(parsePlotLine('')).toBeNull();
  });
});
