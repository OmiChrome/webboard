/// <reference lib="webworker" />
import { WasmToolchain, type Progress } from './toolchain';

let toolchain: WasmToolchain | null = null;

type Req = { id: number; type: 'compile'; source: string; define: string; base: string } | { id: number; type: 'warmup'; base: string };

self.onmessage = async (e: MessageEvent<Req>) => {
  const msg = e.data;
  toolchain ??= new WasmToolchain(msg.base);
  const progress = (p: Progress) => self.postMessage({ id: msg.id, type: 'progress', progress: p });
  try {
    if (msg.type === 'warmup') {
      await toolchain.init(progress);
      self.postMessage({ id: msg.id, type: 'done', result: null });
    } else {
      const result = await toolchain.compile(msg.source, { define: msg.define }, progress);
      self.postMessage({ id: msg.id, type: 'done', result });
    }
  } catch (err) {
    self.postMessage({ id: msg.id, type: 'error', error: (err as Error).message ?? String(err) });
  }
};
