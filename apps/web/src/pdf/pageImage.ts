// A picture of a PDF page for the model (ADR 0022): drawn here with pdf.js,
// about 1,600 pixels on its longer side (providers scale pictures to about
// 1,300), as a JPEG, and kept on the server once per page of a version.

import { api } from '../api.ts';
import { openPdf } from './pdfjs.ts';

const LONG_SIDE = 1600;
const sent = new Map<string, Promise<void>>();

/** Draw page `page` and keep it on the server; once per page per session. Never rejects. */
export function sendPageImage(sourceId: string, versionId: string, page: number): Promise<void> {
  const key = `${versionId}:${page}`;
  let done = sent.get(key);
  if (!done) {
    done = (async () => {
      const doc = await openPdf(api.sourceFileUrl(sourceId, versionId));
      const p = await doc.getPage(page);
      const base = p.getViewport({ scale: 1 });
      const viewport = p.getViewport({ scale: LONG_SIDE / Math.max(base.width, base.height) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        // A white sheet behind the page: JPEG has no transparency.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      await p.render({ canvas, viewport }).promise;
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
      if (!blob) throw new Error('the page could not be drawn');
      await api.putPageImage(sourceId, versionId, page, blob, canvas.width, canvas.height);
    })().catch(() => {
      // Asked without the picture: the text still goes. Try again next time.
      sent.delete(key);
    });
    sent.set(key, done);
  }
  return done;
}
