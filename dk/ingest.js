// ingest.js: a screenshot of a bet slip, into a draft lock.
//
// Three steps, and the middle one is not optional:
//
//   1. Compress the image and send it up.
//   2. Show the person the transcribed text so they can fix it.
//   3. Turn the corrected text into a draft they then check in the form.
//
// Step 2 exists because a misread number settles a bet wrongly and leaves no
// trace. A 249.5 read as 246.5 looks perfectly reasonable on screen and is
// only wrong when the money moves. This is a hard rule carried over from the
// sibling LockIN app, where skipping it was the mistake that prompted it.

import { createLock } from './api.js';
import { parseSlip, slipToDraft } from './slip.js';
import { API_URL } from './config.js';
import { token } from './auth.js';

/**
 * Shrink a screenshot before sending it.
 *
 * A phone screenshot is a few megabytes and mostly flat colour. Scaling the
 * long edge to 1400px keeps the small print legible while cutting the upload
 * to a fraction, which matters both for the daily model allowance and for
 * somebody on a bad connection at a bar.
 */
export function compressImage(file, { maxEdge = 1400, maxBytes = 900_000, type = 'image/jpeg' } = {}) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      // Screenshots are flat colour and hard edges; smoothing softens the
      // small print, which is exactly the part that has to stay readable.
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, w, h);

      // Step the quality down until it fits, rather than guessing once.
      let quality = 0.92;
      let out = canvas.toDataURL(type, quality);
      while (out.length > maxBytes && quality > 0.4) {
        quality -= 0.12;
        out = canvas.toDataURL(type, quality);
      }
      resolve({ dataUrl: out, width: w, height: h, bytes: out.length, quality });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image this browser can read.')); };
    img.src = url;
  });
}

/** Send the image up and get the transcript back. Never throws. */
export async function readScreenshot(dataUrl) {
  if (!API_URL) return { ok: false, error: 'Reading screenshots needs the backend. Sign in first.' };
  const jwt = await token();
  if (!jwt) return { ok: false, error: 'Sign in first.', needsAuth: true };

  let res;
  try {
    res = await fetch(`${API_URL}/v1/ingest/read`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ image: dataUrl }),
    });
  } catch {
    return { ok: false, error: 'Could not reach the server.' };
  }

  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) return { ok: false, error: (data && data.error) || `Server said ${res.status}.` };
  return { ok: true, text: String((data && data.text) || ''), model: data && data.model };
}

/**
 * The whole path: file in, draft out, with the transcript carried along so
 * the person can see and edit what was actually read.
 */
export async function readFileToDraft(file, code) {
  const img = await compressImage(file);
  const read = await readScreenshot(img.dataUrl);
  if (!read.ok) return { ok: false, error: read.error, needsAuth: read.needsAuth };
  const slip = parseSlip(read.text);
  return {
    ok: true,
    transcript: read.text,
    model: read.model,
    slip,
    draft: slipToDraft(slip, code),
    preview: img.dataUrl,
  };
}

/** Re-read an edited transcript, without uploading anything again. */
export function redraft(transcript, code) {
  const slip = parseSlip(transcript);
  return { slip, draft: slipToDraft(slip, code) };
}

export { createLock };
