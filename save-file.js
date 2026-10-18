/**
 * Hand a generated file to the user. Inside a Claude artifact the page cannot
 * start downloads itself, so it asks the viewer through the `downloads`
 * capability (which only accepts some extensions; a 3MF is a ZIP, so it falls
 * back to "name.3mf.zip"). Everywhere else a normal download link is used.
 * @typedef {object} DownloadsApi
 * @property {(req: { filename: string; data: Blob }) => Promise<{ status: string }>} save
 */
/**
 * @typedef {object} ClaudeHost
 * @property {(name: string) => Promise<unknown>} use
 */

/** @type {Promise<DownloadsApi | null> | null} */
let downloadsPromise = null;
/** @returns {Promise<DownloadsApi | null>} */
function downloadsApi() {
  const host = (/** @type {{ claude?: ClaudeHost }} */ (/** @type {unknown} */ (window))).claude;
  if (!host || typeof host.use !== 'function') return Promise.resolve(null);
  downloadsPromise ??= host.use('downloads').then((d) => (/** @type {DownloadsApi | null} */ (d)) ?? null).catch(() => null);
  return downloadsPromise;
}

/** @returns {boolean} */
export function isFramedHost() {
  const host = (/** @type {{ claude?: ClaudeHost }} */ (/** @type {unknown} */ (window))).claude;
  return !!host && typeof host.use === 'function';
}

/**
 * @typedef {object} SaveOutcome
 * @property {boolean} ok
 * @property {string} filename
 * @property {string} message
 */

/**
 * @param {Blob} blob
 * @param {string} filename
 * @returns {Promise<SaveOutcome>}
 */
export async function saveBlob(blob, filename) {
  const api = await downloadsApi();
  if (api) {
    try {
      await api.save({ filename, data: blob });
      return { ok: true, filename, message: `Saved ${filename}` };
    } catch (e) {
      const code = (/** @type {{ code?: string }} */ (e)).code;
      if (code === 'rejected_extension' && /\.3mf$/i.test(filename)) {
        const zipName = filename + '.zip';
        try {
          await api.save({ filename: zipName, data: blob });
          return { ok: true, filename: zipName, message: `Saved ${zipName}. Remove the ".zip" ending so it opens as a 3MF (the file inside is unchanged).` };
        } catch (e2) {
          return { ok: false, filename: zipName, message: describe((/** @type {{ code?: string }} */ (e2)).code) };
        }
      }
      return { ok: false, filename, message: describe(code) };
    }
  }
  if (isFramedHost()) return { ok: false, filename, message: 'Saving files is not available in this view.' };
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { ok: true, filename, message: `Downloaded ${filename}` };
}

/**
 * @param {string | undefined} code
 * @returns {string}
 */
function describe(code) {
  switch (code) {
    case 'declined':
      return 'Save cancelled.';
    case 'rate_limited':
      return 'A save prompt is already open. Finish it, then try again.';
    case 'too_large':
      return 'The file is too large to save from this view.';
    default:
      return 'Saving files is not available in this view.';
  }
}
