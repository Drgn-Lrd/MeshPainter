/// <reference lib="webworker" />
/**
 * Heavy lifting off the main thread: parsing STL/3MF, writing the painted 3MF,
 * the round-trip check and the piece analysis. Model arrays are transferred in
 * and out (no copies).
 */
import { blobSource } from './byte-source.js?v=01b4498c33';
import { loadModel } from './model-loader.js?v=b6f6e2ffaa';
import { write3mf } from './threemf-writer.js?v=f501135853';
import { compareModels } from './round-trip-check.js?v=796b699a5d';
import { modelTransferables } from './model-data.js?v=bb5fb4d3b6';
/** @typedef {import('./model-data.js').ModelData} ModelData */
import { analyze, analysisTransferables } from './piece-analysis.js?v=be07861d55';
/** @typedef {import('./worker-client.js').WorkerRequest} WorkerRequest */
/** @typedef {import('./worker-client.js').WorkerResponse} WorkerResponse */

const ctx = /** @type {DedicatedWorkerGlobalScope} */ (/** @type {unknown} */ (self));

/**
 * @param {WorkerResponse} msg
 * @param {Transferable[]} [transfer]
 */
function post(msg, transfer = []) {
  ctx.postMessage(msg, transfer);
}

ctx.onmessage = async (ev) => {
  const msg = ev.data;
  let last = 0;
  /**
   * @param {string} phase
   * @param {number} done
   * @param {number} total
   */
  const progress = (phase, done, total) => {
    const now = performance.now();
    if (now - last < 50 && done < total) return;
    last = now;
    post({ id: msg.id, type: 'progress', phase, done, total });
  };
  /** @type {ModelData | undefined} */
  let held;
  try {
    if (msg.type === 'load') {
      const model = await loadModel(blobSource(msg.file), msg.name, progress);
      post({ id: msg.id, type: 'loaded', model }, modelTransferables(model));
    } else if (msg.type === 'analyze') {
      const analysis = analyze(msg.positions, msg.indices, progress);
      post({ id: msg.id, type: 'analyzed', analysis }, analysisTransferables(analysis));
    } else if (msg.type === 'export') {
      held = msg.model;
      const res = await write3mf(held, { onProgress: progress, level: msg.level });
      let report = null;
      let verifySeconds = 0;
      if (msg.verify) {
        const t0 = performance.now();
        const back = await loadModel(blobSource(res.blob), 'check.3mf', (_p, d, t) => progress('Re-importing the export', d, t));
        report = compareModels(held, back);
        verifySeconds = (performance.now() - t0) / 1000;
      }
      post(
        { id: msg.id, type: 'exported', result: { blob: res.blob, xmlBytes: res.xmlBytes, zipBytes: res.zipBytes, seconds: res.seconds, report, verifySeconds }, model: held },
        modelTransferables(held),
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Always hand a borrowed model back, even on failure.
    if (held) post({ id: msg.id, type: 'error', message, model: held }, modelTransferables(held));
    else post({ id: msg.id, type: 'error', message });
  }
};
