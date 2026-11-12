// A PDF as its pages: drawn by pdf.js (pictures, formulas and layout as
// printed), each with pdf.js's text layer on top so text can be selected.
// Every span of a text layer is one pdf.js text item; core's pdfToMarkdown,
// run here on the same items, says where each item is in the stored text.
// So a selection on a page becomes a passage of the text (asked about,
// pinned, marked), and a passage becomes a selection on the page, exactly
// as in the text view. If the text here does not come out the same as the
// stored text (read by another reader), the pages are shown but cannot be
// selected from, and the caller is told.

import {
  type PdfPageText,
  type PdfTextMap,
  pdfItemAtOffset,
  pdfItemOffsets,
  pdfPageText,
  pdfToMarkdown,
} from '@noema/core';
import { useEffect, useRef } from 'react';
import { openPdf, type PdfPage, type PdfViewport, textLayer } from './pdf/pdfjs.ts';

/** What the source view needs from the pages: the same as from the text. */
export interface PdfSurface {
  /** A passage of the stored text as a DOM range on the pages. */
  rangeOf(start: number, end: number): Range | null;
  /** The current selection on the pages as a passage of the stored text. */
  selection(): { start: number; end: number } | null;
  /** The page at the top of the reading pane. */
  pageInView(): number;
  /** The page a passage starts on. */
  pageOf(offset: number): number | null;
  scrollToPage(page: number): void;
}

type Point = { node: Node; offset: number };

export function PdfPages({
  fileUrl,
  content,
  scroller,
  onReady,
  onMismatch,
  onFailed,
}: {
  fileUrl: string;
  /** The stored text of this version. */
  content: string;
  /** The element that scrolls (for drawing pages as they come into view). */
  scroller: HTMLElement | null;
  /** Called when the pages can be selected from (again after a resize). */
  onReady: (surface: PdfSurface | null) => void;
  /** The text read here differs from the stored text: pages without selection. */
  onMismatch: () => void;
  onFailed: (message: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onReady, onMismatch, onFailed });
  callbacks.current = { onReady, onMismatch, onFailed };

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let cancelled = false;
    let observer: IntersectionObserver | null = null;
    let width = 0;
    const tasks: Array<{ cancel(): void }> = [];

    const build = async () => {
      width = Math.floor(el.clientWidth);
      if (width < 50) return;
      el.replaceChildren();
      observer?.disconnect();
      callbacks.current.onReady(null);
      const doc = await openPdf(fileUrl);
      if (cancelled) return;
      const pages: Array<{ page: PdfPage; viewport: PdfViewport; div: HTMLDivElement; drawn: boolean }> = [];
      const texts: PdfPageText[] = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: width / base.width });
        const div = document.createElement('div');
        div.className = 'pdf-page';
        div.dataset.page = String(n);
        div.style.width = `${viewport.width}px`;
        div.style.height = `${viewport.height}px`;
        div.style.setProperty('--total-scale-factor', String(viewport.scale));
        div.style.setProperty('--scale-round-x', '1px');
        div.style.setProperty('--scale-round-y', '1px');
        const canvas = document.createElement('canvas');
        canvas.setAttribute('aria-hidden', 'true');
        const layer = document.createElement('div');
        layer.className = 'textLayer';
        div.append(canvas, layer);
        el.append(div);
        const items = await page.getTextContent();
        if (cancelled) return;
        texts.push(pdfPageText(items.items, base));
        const divs = await textLayer(layer, items, viewport);
        divs.forEach((span, k) => {
          span.dataset.item = String(k);
        });
        pages.push({ page, viewport, div, drawn: false });
      }

      // Draw each page as it comes near.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const p = pages[Number((entry.target as HTMLElement).dataset.page) - 1];
            if (!p || p.drawn) continue;
            p.drawn = true;
            const canvas = p.div.querySelector('canvas') as HTMLCanvasElement;
            const viewport = p.page.getViewport({ scale: p.viewport.scale * dpr });
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            const task = p.page.render({ canvas, viewport });
            tasks.push(task);
            task.promise.catch(() => {
              p.drawn = false;
            });
          }
        },
        { root: scroller, rootMargin: '1200px 0px' },
      );
      for (const p of pages) observer.observe(p.div);

      // The text read here must be the stored text, item for item.
      const reading = pdfToMarkdown(texts);
      if (reading.markdown !== content) {
        callbacks.current.onMismatch();
        return;
      }
      callbacks.current.onReady(surface(el, content, reading.map, scroller));
    };

    build().catch((err: unknown) => {
      if (!cancelled) callbacks.current.onFailed(err instanceof Error ? err.message : 'the PDF could not be shown');
    });

    // A different width: draw again to fit.
    let timer: number | undefined;
    const resized = new ResizeObserver(() => {
      if (Math.abs(Math.floor(el.clientWidth) - width) < 4) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        for (const t of tasks.splice(0)) t.cancel();
        build().catch(() => {});
      }, 200);
    });
    resized.observe(el);
    return () => {
      cancelled = true;
      resized.disconnect();
      observer?.disconnect();
      window.clearTimeout(timer);
      for (const t of tasks) t.cancel();
      callbacks.current.onReady(null);
    };
  }, [fileUrl, content, scroller]);

  return <div className="pdf-pages" ref={root} data-testid="pdf-pages" />;
}

/** Selection and passages on drawn pages, through the map of items. */
function surface(root: HTMLElement, content: string, map: PdfTextMap, scroller: HTMLElement | null): PdfSurface {
  const spanOf = (page: number, item: number) =>
    root.querySelector<HTMLElement>(`.pdf-page[data-page="${page}"] span[data-item="${item}"]`);

  /** A text offset as a point in a span. */
  const pointAt = (offset: number, side: 'start' | 'end'): Point | null => {
    const at = pdfItemAtOffset(map, offset, side);
    if (!at) return null;
    const [item, s, e] = at.range;
    const span = spanOf(at.page, item);
    const node = span?.firstChild;
    if (!node) return null;
    const raw = node.textContent ?? '';
    const offsets = pdfItemOffsets(raw, content.slice(s, e));
    const local = Math.max(0, Math.min(offset - s, e - s));
    let i = offsets.findIndex((k) => k >= local);
    if (i < 0) i = raw.length;
    return { node, offset: Math.min(i, raw.length) };
  };

  /** A point in the DOM as a text offset, or null if it is not on a page's text. */
  const offsetAt = (node: Node, offset: number, side: 'start' | 'end'): number | null => {
    let span: HTMLElement | null = null;
    let c = 0;
    if (node.nodeType === Node.TEXT_NODE) {
      span = node.parentElement?.closest<HTMLElement>('span[data-item]') ?? null;
      c = offset;
    } else if (node instanceof Element) {
      const own = node.closest<HTMLElement>('span[data-item]');
      if (own) {
        span = own;
        c = offset > 0 ? (own.textContent?.length ?? 0) : 0;
      } else {
        // Between spans (in a text layer, or a page): the span after (a start) or before (an end).
        const spans = Array.from(node.querySelectorAll<HTMLElement>('span[data-item]'));
        const children = Array.from(node.childNodes);
        const boundary = children[offset] ?? null;
        const after = spans.find((s) => !boundary || boundary === s || boundary.compareDocumentPosition(s) & 4);
        const before = [...spans].reverse().find((s) => !boundary || boundary.compareDocumentPosition(s) & 2);
        span = side === 'start' ? (after ?? null) : (before ?? null);
        c = side === 'start' ? 0 : (span?.textContent?.length ?? 0);
      }
    }
    if (!span || !root.contains(span)) return null;
    const page = Number(span.closest<HTMLElement>('.pdf-page')?.dataset.page);
    const item = Number(span.dataset.item);
    const ranges = map[page - 1] ?? [];
    let range = ranges.find((r) => r[0] === item);
    if (!range) {
      // An item not in the text (a bullet, a page number): the nearest that is.
      range = side === 'start' ? ranges.find((r) => r[0] > item) : [...ranges].reverse().find((r) => r[0] < item);
      if (!range) return null;
      return side === 'start' ? range[1] : range[2];
    }
    const offsets = pdfItemOffsets(span.textContent ?? '', content.slice(range[1], range[2]));
    return range[1] + (offsets[Math.max(0, Math.min(c, offsets.length - 1))] ?? 0);
  };

  const pageDivs = () => Array.from(root.querySelectorAll<HTMLElement>('.pdf-page'));

  return {
    rangeOf(start, end) {
      const a = pointAt(start, 'start');
      const b = pointAt(end, 'end');
      if (!a || !b) return null;
      const range = document.createRange();
      try {
        range.setStart(a.node, a.offset);
        range.setEnd(b.node, b.offset);
      } catch {
        return null;
      }
      return range.collapsed ? null : range;
    },
    selection() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
      const r = sel.getRangeAt(0);
      if (!root.contains(r.commonAncestorContainer)) return null;
      const start = offsetAt(r.startContainer, r.startOffset, 'start');
      const end = offsetAt(r.endContainer, r.endOffset, 'end');
      return start !== null && end !== null && end > start ? { start, end } : null;
    },
    pageInView() {
      const top = (scroller?.getBoundingClientRect().top ?? 0) + 80;
      let page = 1;
      for (const div of pageDivs()) {
        if (div.getBoundingClientRect().top > top) break;
        page = Number(div.dataset.page);
      }
      return page;
    },
    pageOf(offset) {
      return pdfItemAtOffset(map, offset, 'start')?.page ?? null;
    },
    scrollToPage(page) {
      root.querySelector<HTMLElement>(`.pdf-page[data-page="${page}"]`)?.scrollIntoView({ block: 'start' });
    },
  };
}
