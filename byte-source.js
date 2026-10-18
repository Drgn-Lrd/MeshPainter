/**
 * Random-access byte source (File/Blob in the browser, fs.openAsBlob in Node).
 * @typedef {object} ByteSource
 * @property {number} size
 * @property {(start: number, end: number) => Promise<Uint8Array>} read
 * @property {(start: number, end: number, chunkSize?: number) => AsyncGenerator<Uint8Array>} stream Stream [start, end) in chunks, prefetching one chunk ahead.
 */

/** @typedef {(phase: string, done: number, total: number) => void} ProgressFn */

/**
 * @param {Blob} blob
 * @returns {ByteSource}
 */
export function blobSource(blob) {
  /**
   * @param {number} s
   * @param {number} e
   */
  const read = async (s, e) => new Uint8Array(await blob.slice(s, e).arrayBuffer());
  return {
    size: blob.size,
    read,
    /**
     * @param {number} start
     * @param {number} end
     */
    async *stream(start, end, chunkSize = 1 << 21) {
      let p = start;
      /** @type {Promise<Uint8Array> | null} */
      let next = p < end ? read(p, Math.min(end, p + chunkSize)) : null;
      while (next) {
        const cur = await next;
        p += cur.length;
        if (cur.length === 0) break;
        next = p < end ? read(p, Math.min(end, p + chunkSize)) : null;
        yield cur;
      }
    },
  };
}
