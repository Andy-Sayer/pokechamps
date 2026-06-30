/* Minimal WebGPU harness for the damage kernel, via @kmamal/gpu (a maintained
 * Dawn-in-Node binding). Loose typing on purpose — throwaway PoC, not shipped code. */
// @ts-expect-error - @kmamal/gpu ships no usable types
import Gpu from '@kmamal/gpu';
import { WGSL, ROLLS } from './damageKernel.js';

// Standard WebGPU bit-flag constants (the binding doesn't reliably expose them as globals).
const BUF = { MAP_READ: 0x0001, COPY_SRC: 0x0004, COPY_DST: 0x0008, UNIFORM: 0x0040, STORAGE: 0x0080 };
const MAP_READ = 0x0001;

export interface RunTiming { out: Int32Array; uploadMs: number; dispatchMs: number; readbackMs: number; totalMs: number }

export interface Batch {
  run: (readback: boolean) => Promise<RunTiming>;
  /** Encode `reps` compute passes into ONE submit + ONE sync — amortizes the
   *  binding's fixed per-submit sync latency to reveal TRUE compute throughput.
   *  Returns total wall ms for all reps (no readback). */
  runMany: (reps: number) => Promise<number>;
  free: () => void;
}

export interface Gpu {
  device: any;
  adapterInfo: any;
  prepare: (level: Int32Array, bp: Int32Array, atk: Int32Array, def: Int32Array) => Batch;
  dispose: () => void;
}

export async function initGpu(): Promise<Gpu> {
  const gpu = (Gpu as any).create([]);
  if (!gpu) throw new Error('no WebGPU instance');
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('no GPU adapter');
  const adapterInfo = adapter.info ?? {};
  const device = await adapter.requestDevice();
  const module = device.createShaderModule({ code: WGSL });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });

  function prepare(level: Int32Array, bp: Int32Array, atk: Int32Array, def: Int32Array): Batch {
    const n = level.length;
    const outBytes = n * ROLLS * 4;
    const mkIn = (bytes: number) => device.createBuffer({ size: bytes, usage: BUF.STORAGE | BUF.COPY_DST });
    const bLevel = mkIn(level.byteLength), bBp = mkIn(bp.byteLength), bAtk = mkIn(atk.byteLength), bDef = mkIn(def.byteLength);
    const bOut = device.createBuffer({ size: outBytes, usage: BUF.STORAGE | BUF.COPY_SRC });
    const bN = device.createBuffer({ size: 16, usage: BUF.UNIFORM | BUF.COPY_DST });
    device.queue.writeBuffer(bN, 0, new Uint32Array([n]));
    const readBuf = device.createBuffer({ size: outBytes, usage: BUF.COPY_DST | BUF.MAP_READ });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: bLevel } }, { binding: 1, resource: { buffer: bBp } },
        { binding: 2, resource: { buffer: bAtk } }, { binding: 3, resource: { buffer: bDef } },
        { binding: 4, resource: { buffer: bOut } }, { binding: 5, resource: { buffer: bN } },
      ],
    });
    const all = [bLevel, bBp, bAtk, bDef, bOut, bN, readBuf];

    async function run(readback: boolean): Promise<RunTiming> {
      const t0 = performance.now();
      device.queue.writeBuffer(bLevel, 0, level);
      device.queue.writeBuffer(bBp, 0, bp);
      device.queue.writeBuffer(bAtk, 0, atk);
      device.queue.writeBuffer(bDef, 0, def);
      const uploadMs = performance.now() - t0;

      const t1 = performance.now();
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(n / 64));
      pass.end();
      if (readback) enc.copyBufferToBuffer(bOut, 0, readBuf, 0, outBytes);
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();
      const dispatchMs = performance.now() - t1;

      let out = new Int32Array(0);
      let readbackMs = 0;
      if (readback) {
        const t2 = performance.now();
        await readBuf.mapAsync(MAP_READ);
        out = new Int32Array(readBuf.getMappedRange().slice(0));
        readBuf.unmap();
        readbackMs = performance.now() - t2;
      }
      return { out, uploadMs, dispatchMs, readbackMs, totalMs: uploadMs + dispatchMs + readbackMs };
    }
    async function runMany(reps: number): Promise<number> {
      device.queue.writeBuffer(bLevel, 0, level);
      device.queue.writeBuffer(bBp, 0, bp);
      device.queue.writeBuffer(bAtk, 0, atk);
      device.queue.writeBuffer(bDef, 0, def);
      await device.queue.onSubmittedWorkDone(); // settle uploads first
      const t = performance.now();
      const enc = device.createCommandEncoder();
      for (let r = 0; r < reps; r++) {
        const pass = enc.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(n / 64));
        pass.end();
      }
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();
      return performance.now() - t;
    }

    return { run, runMany, free: () => { for (const b of all) { try { b.destroy?.(); } catch { /* noop */ } } } };
  }

  return { device, adapterInfo, prepare, dispose: () => { try { (Gpu as any).destroy?.(gpu); } catch { /* noop */ } } };
}
