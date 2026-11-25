import { useEffect, useRef } from 'react';

export interface Series {
  name: string;
  values: number[];
}

const COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'];

/** Minimal real-time line plot on a canvas (redraws on animation frames). */
export function Plotter({ series }: { series: React.RefObject<Map<string, number[]>> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const legend = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const c = canvas.current;
      const map = series.current;
      if (c && map) {
        const dpr = window.devicePixelRatio || 1;
        const w = c.clientWidth;
        const h = c.clientHeight;
        if (c.width !== w * dpr || c.height !== h * dpr) {
          c.width = w * dpr;
          c.height = h * dpr;
        }
        const ctx = c.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const styles = getComputedStyle(c);
        const all = [...map.values()].flat();
        const pad = 24;
        if (all.length) {
          let min = Math.min(...all);
          let max = Math.max(...all);
          if (min === max) {
            min -= 1;
            max += 1;
          }
          const span = max - min;
          const y = (v: number) => pad + (h - 2 * pad) * (1 - (v - min) / span);
          // grid
          ctx.strokeStyle = styles.getPropertyValue('--grid');
          ctx.fillStyle = styles.getPropertyValue('--text-3');
          ctx.font = '11px ' + styles.getPropertyValue('--mono');
          ctx.lineWidth = 1;
          for (let i = 0; i <= 4; i++) {
            const v = min + (span * i) / 4;
            const yy = Math.round(y(v)) + 0.5;
            ctx.beginPath();
            ctx.moveTo(40, yy);
            ctx.lineTo(w, yy);
            ctx.stroke();
            const label = v.toFixed(Math.abs(span) < 10 ? 2 : 0);
            ctx.fillText(/^-0(\.0+)?$/.test(label) ? label.slice(1) : label, 2, yy + 4);
          }
          let i = 0;
          for (const [, vals] of map) {
            ctx.strokeStyle = styles.getPropertyValue(COLORS[i % COLORS.length].slice(4, -1));
            ctx.lineWidth = 2;
            ctx.beginPath();
            const n = vals.length;
            vals.forEach((v, k) => {
              const xx = 40 + ((w - 44) * k) / Math.max(1, 299);
              const xOff = xx + ((w - 44) * (300 - n)) / 299;
              if (k === 0) ctx.moveTo(xOff, y(v));
              else ctx.lineTo(xOff, y(v));
            });
            ctx.stroke();
            i++;
          }
        } else {
          ctx.fillStyle = styles.getPropertyValue('--text-3');
          ctx.font = '13px system-ui';
          ctx.fillText('Waiting for numbers… print lines like  sin:12 cos:34', 16, h / 2);
        }
        if (legend.current) {
          const names = [...map.keys()];
          const html = names
            .map((n, k) => `<span><i style="background:${COLORS[k % COLORS.length]}"></i>${escapeHtml(n)}</span>`)
            .join('');
          if (legend.current.innerHTML !== html) legend.current.innerHTML = html;
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [series]);

  return (
    <div className="plotter">
      <div className="legend" ref={legend} />
      <canvas ref={canvas} aria-label="Serial plotter" />
    </div>
  );
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
