/** @typedef {import('./byte-source.js').ByteSource} ByteSource */
/** @typedef {import('./byte-source.js').ProgressFn} ProgressFn */
/** @typedef {import('./model-data.js').ModelData} ModelData */
import { read3mf } from './threemf-reader.js?v=88dcdb7233';
import { readStl } from './stl-reader.js?v=081ce06ea0';

/**
 * Open an STL or 3MF (detected from content, not the file name).
 * @param {ByteSource} src
 * @param {string} name
 * @param {ProgressFn} [onProgress]
 * @returns {Promise<ModelData>}
 */
export async function loadModel(src, name, onProgress) {
  const head = await src.read(0, Math.min(4, src.size));
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return read3mf(src, name, onProgress);
  return readStl(src, name, onProgress);
}
