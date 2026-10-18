/**
 * The page's side of model-worker.js: sends it files to open, models to export
 * and meshes to analyse, and turns its replies into promises.
 */
import { modelTransferables } from './model-data.js?v=bb5fb4d3b6';
/** @typedef {import('./model-data.js').ModelData} ModelData */
/** @typedef {import('./piece-analysis.js').Analysis} Analysis */

// ---------------------------------------------------------------------------
// Messages between the page and the worker
// ---------------------------------------------------------------------------

/** @typedef {import('./round-trip-check.js').VerifyReport} VerifyReport */

/**
 * @typedef {| { id: number; type: 'load'; file: Blob; name: string }
 *   | { id: number; type: 'export'; model: ModelData; verify: boolean; level?: number }
 *   | { id: number; type: 'analyze'; positions: Float32Array; indices: Uint32Array }} WorkerRequest
 */

/**
 * @typedef {object} ExportResult
 * @property {Blob} blob
 * @property {number} xmlBytes
 * @property {number} zipBytes
 * @property {number} seconds
 * @property {VerifyReport | null} report
 * @property {number} verifySeconds
 */

/**
 * @typedef {| { id: number; type: 'progress'; phase: string; done: number; total: number }
 *   | { id: number; type: 'loaded'; model: ModelData }
 *   | { id: number; type: 'exported'; result: ExportResult; model: ModelData }
 *   | { id: number; type: 'analyzed'; analysis: Analysis }
 *   | { id: number; type: 'error'; message: string; model?: ModelData }} WorkerResponse
 */

// ---------------------------------------------------------------------------

/** @typedef {(phase: string, done: number, total: number) => void} ProgressCb */

/**
 * @template T
 * @typedef {T extends unknown ? Omit<T, 'id'> : never} WithoutId
 */

/**
 * @typedef {{
 *   resolve: (r: WorkerResponse) => void;
 *   reject: (e: Error) => void;
 *   progress?: ProgressCb;
 *   }} Pending
 */

export class ModelWorker {
  /** @type {Worker} */
  worker;
  nextId = 1;
  pending = new Map();

  constructor() {
    this.worker = new Worker(new URL('./model-worker.js?v=d45336d55c', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev) => {
      const m = ev.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') {
        p.progress?.(m.phase, m.done, m.total);
        return;
      }
      this.pending.delete(m.id);
      p.resolve(m);
    };
    this.worker.onerror = (ev) => {
      const err = new Error(ev.message || 'The background worker stopped (possibly out of memory).');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  /**
   * @param {WithoutId<WorkerRequest>} req
   * @param {Transferable[]} transfer
   * @param {ProgressCb} [progress]
   * @returns {Promise<WorkerResponse>}
   */
  call(req, transfer, progress) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress });
      this.worker.postMessage({ ...req, id }, transfer);
    });
  }

  /**
   * @param {Blob} file
   * @param {string} name
   * @param {ProgressCb} [progress]
   * @returns {Promise<ModelData>}
   */
  async load(file, name, progress) {
    const r = await this.call({ type: 'load', file, name }, [], progress);
    if (r.type === 'loaded') return r.model;
    throw new Error(r.type === 'error' ? r.message : 'Unexpected reply from worker');
  }

  /**
   * Piece analysis on copies of the mesh arrays (the originals stay here).
   * @param {Float32Array} positions
   * @param {Uint32Array} indices
   * @param {ProgressCb} [progress]
   * @returns {Promise<Analysis>}
   */
  async analyze(positions, indices, progress) {
    const p = positions.slice();
    const i = indices.slice();
    const r = await this.call({ type: 'analyze', positions: p, indices: i }, [p.buffer, i.buffer], progress);
    if (r.type === 'analyzed') return r.analysis;
    throw new Error(r.type === 'error' ? r.message : 'Unexpected reply from worker');
  }

  /**
   * Export (and optionally verify). The model's arrays are lent to the worker
   * and come back in `model`; do not touch the original arrays meanwhile.
   * @param {ModelData} model
   * @param {boolean} verify
   * @param {ProgressCb} [progress]
   * @returns {Promise<{ result?: ExportResult; model: ModelData; error?: string }>}
   */
  async export(model, verify, progress) {
    const r = await this.call({ type: 'export', model, verify }, modelTransferables(model), progress);
    if (r.type === 'exported') return { result: r.result, model: r.model };
    if (r.type === 'error') return { model: r.model ?? model, error: r.message };
    throw new Error('Unexpected reply from worker');
  }
}
