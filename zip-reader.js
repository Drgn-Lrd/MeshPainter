/**
 * Random-access ZIP reader: parses the central directory (with Zip64) and
 * streams individual entries through fflate's streaming inflater, so a 3MF
 * never has to be held in memory whole.
 */
import { Inflate } from './lib/fflate.js?v=d33a216730';
/** @typedef {import('./byte-source.js').ByteSource} ByteSource */

/**
 * @typedef {object} ZipEntry
 * @property {string} name
 * @property {number} method
 * @property {number} flags
 * @property {number} compSize
 * @property {number} size
 * @property {number} localOffset
 */

const utf8 = new TextDecoder('utf-8');

/**
 * @param {Uint8Array} b
 * @param {number} o
 * @returns {number}
 */
function u16(b, o) {
  return b[o] | (b[o + 1] << 8);
}
/**
 * @param {Uint8Array} b
 * @param {number} o
 * @returns {number}
 */
function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
/**
 * @param {Uint8Array} b
 * @param {number} o
 * @returns {number}
 */
function u64(b, o) {
  return u32(b, o) + u32(b, o + 4) * 4294967296;
}

/**
 * @param {ByteSource} src
 * @returns {Promise<Map<string, ZipEntry>>}
 */
export async function readZipDirectory(src) {
  const tailLen = Math.min(src.size, 65557 + 20);
  const tailStart = src.size - tailLen;
  const tail = await src.read(tailStart, src.size);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a 3MF/ZIP file (no end-of-central-directory record).');
  let total = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && u32(tail, loc) === 0x07064b50) {
      const z64off = u64(tail, loc + 8);
      const z = await src.read(z64off, z64off + 56);
      if (u32(z, 0) === 0x06064b50) {
        total = u64(z, 32);
        cdSize = u64(z, 40);
        cdOffset = u64(z, 48);
      }
    }
  }
  const cd = await src.read(cdOffset, cdOffset + cdSize);
  const entries = new Map();
  let p = 0;
  for (let k = 0; k < total && p + 46 <= cd.length; k++) {
    if (u32(cd, p) !== 0x02014b50) break;
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    let compSize = u32(cd, p + 20);
    let size = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    let localOffset = u32(cd, p + 42);
    const name = utf8.decode(cd.subarray(p + 46, p + 46 + nameLen));
    // Zip64 extra field
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = u16(cd, e);
      const len = u16(cd, e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) {
          size = u64(cd, q);
          q += 8;
        }
        if (compSize === 0xffffffff) {
          compSize = u64(cd, q);
          q += 8;
        }
        if (localOffset === 0xffffffff) localOffset = u64(cd, q);
      }
      e += 4 + len;
    }
    entries.set(name, { name, method, flags, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Find an entry by path, ignoring a leading '/', case and %-encoding differences.
 * @param {Map<string, ZipEntry>} entries
 * @param {string} path
 * @returns {ZipEntry | undefined}
 */
export function findEntry(entries, path) {
  let p = path.replace(/^\/+/, '');
  const direct = entries.get(p);
  if (direct) return direct;
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep */
  }
  const lower = p.toLowerCase();
  for (const [k, v] of entries) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * @param {ByteSource} src
 * @param {ZipEntry} e
 * @returns {Promise<number>}
 */
async function dataStart(src, e) {
  const h = await src.read(e.localOffset, e.localOffset + 30);
  if (u32(h, 0) !== 0x04034b50) throw new Error(`Corrupt ZIP: bad local header for ${e.name}`);
  return e.localOffset + 30 + u16(h, 26) + u16(h, 28);
}

/**
 * Stream an entry's uncompressed bytes to `onData`. `onRaw(n)` reports
 * compressed bytes consumed (for progress).
 * @param {ByteSource} src
 * @param {ZipEntry} e
 * @param {(chunk: Uint8Array) => void} onData
 * @param {(compressedBytes: number) => void} [onRaw]
 * @returns {Promise<void>}
 */
export async function streamEntry(
  src,
  e,
  onData,
  onRaw,
) {
  const start = await dataStart(src, e);
  const end = start + e.compSize;
  if (e.method === 0) {
    for await (const c of src.stream(start, end)) {
      onData(c);
      onRaw?.(c.length);
    }
    return;
  }
  if (e.method !== 8) throw new Error(`Unsupported compression method ${e.method} in ${e.name}`);
  const inf = new Inflate((chunk) => onData(chunk));
  for await (const c of src.stream(start, end, 1 << 20)) {
    inf.push(c, false);
    onRaw?.(c.length);
  }
  inf.push(new Uint8Array(0), true);
}

/**
 * @param {ByteSource} src
 * @param {ZipEntry} e
 * @returns {Promise<string>}
 */
export async function readEntryText(src, e) {
  /** @type {Uint8Array[]} */
  const parts = [];
  let n = 0;
  await streamEntry(src, e, (c) => {
    parts.push(c);
    n += c.length;
  });
  const all = new Uint8Array(n);
  let o = 0;
  for (const c of parts) {
    all.set(c, o);
    o += c.length;
  }
  return utf8.decode(all);
}
