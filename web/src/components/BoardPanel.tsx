import { useEffect, useState } from 'react';
import type { PinSnapshot, VirtualUno } from '../lib/serial/virtual';

const LED_COLORS: Record<number, string> = {
  10: 'var(--led-green)',
  11: 'var(--led-yellow)',
  12: 'var(--led-red)',
};

/** Live view of the simulated Uno: one LED per digital pin, plus A0 input. */
export function BoardPanel({ board }: { board: VirtualUno }) {
  const [snap, setSnap] = useState<PinSnapshot>(() => board.snapshot());
  const [a0, setA0] = useState(board.analogIn[0]);

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      if (t - last > 33) {
        setSnap(board.snapshot());
        last = t;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [board]);

  const pins = Array.from({ length: 12 }, (_, i) => 13 - i); // D13 … D2
  const label = snap.state === 'running' ? 'Running' : snap.state === 'bootloader' ? 'Bootloader' : 'No sketch';

  return (
    <section className="board" aria-label="Virtual Arduino Uno">
      <header className="board-head">
        <h2>Virtual Uno</h2>
        <span className={`chip chip-${snap.state}`} data-testid="board-state">
          {label}
        </span>
      </header>
      <div className="pcb">
        <div className="leds" role="list">
          {pins.map((p) => {
            const duty = snap.duty[p] ?? 0;
            return (
              <div className="led-col" key={p} role="listitem" aria-label={`D${p} ${duty > 0.5 ? 'on' : 'off'}`}>
                <span
                  className="led"
                  data-testid={`led-${p}`}
                  data-on={duty > 0.5 ? '1' : '0'}
                  style={{ '--glow': duty.toFixed(2), '--led': LED_COLORS[p] ?? 'var(--led-default)' } as React.CSSProperties}
                />
                <span className={`pin ${snap.output[p] ? 'pin-out' : ''}`}>{p}</span>
              </div>
            );
          })}
        </div>
        <div className="pcb-row">
          <div className="onboard">
            <span className="led small" style={{ '--glow': snap.duty[13]?.toFixed(2) ?? 0, '--led': 'var(--led-yellow)' } as React.CSSProperties} />
            <span>L</span>
            <span className="led small" style={{ '--glow': 1, '--led': 'var(--led-green)' } as React.CSSProperties} />
            <span>ON</span>
          </div>
          <div className="mcu">ATmega328P</div>
          <button className="btn small" onClick={() => board.reset()} title="Press the reset button">
            Reset
          </button>
        </div>
      </div>
      <label className="pot">
        <span>A0 potentiometer</span>
        <input
          type="range"
          min={0}
          max={5}
          step={0.01}
          value={a0}
          onChange={(e) => {
            const v = Number(e.target.value);
            board.analogIn[0] = v;
            setA0(v);
          }}
        />
        <output>{a0.toFixed(2)} V</output>
      </label>
      <p className="hint">
        The virtual board runs the real compiled machine code (AVR simulation by avr8js) and speaks the same STK500
        bootloader protocol as a physical Uno.
      </p>
    </section>
  );
}
