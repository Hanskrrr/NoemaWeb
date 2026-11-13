// Dragging in Noema (ADR 0026): a thread, source or note from a list onto a
// room; files and links from outside onto Sources or a room, to read them as
// sources.

import { fileMarkdown, isMarkdownFile, type RoomKind, type Source, ulid } from '@noema/core';
import type { DragEvent } from 'react';
import { ApiFailure, api } from './api.ts';

export const ITEM_MIME = 'application/x-noema-item';

export interface DragItem {
  kind: RoomKind;
  id: string;
  title: string;
}

/** What makes a row draggable as a thing to put in a room. */
export function draggableItem(item: DragItem) {
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(ITEM_MIME, JSON.stringify(item));
      e.dataTransfer.setData('text/plain', item.title || 'Untitled');
      e.dataTransfer.effectAllowed = 'copyLink';
    },
  };
}

export const isItemDrag = (e: DragEvent) => e.dataTransfer.types.includes(ITEM_MIME);
/** Files, or a link, from outside Noema. */
export const isOutsideDrag = (e: DragEvent) =>
  !isItemDrag(e) && (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/uri-list'));

export function droppedItem(e: DragEvent): DragItem | null {
  try {
    const raw = JSON.parse(e.dataTransfer.getData(ITEM_MIME)) as Partial<DragItem>;
    if ((raw.kind === 'thread' || raw.kind === 'source' || raw.kind === 'note') && typeof raw.id === 'string') {
      return { kind: raw.kind, id: raw.id, title: raw.title ?? '' };
    }
  } catch {
    // not ours
  }
  return null;
}

/** What was dropped from outside, taken at once (the browser empties it after the event). */
export interface OutsideDrop {
  files: File[];
  links: string[];
}
export function takeOutsideDrop(e: DragEvent): OutsideDrop {
  const files = [...e.dataTransfer.files];
  const links = files.length
    ? []
    : e.dataTransfer
        .getData('text/uri-list')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^https?:\/\//i.test(l));
  return { files, links };
}

const MAX_TEXT = 2_000_000;

/** Read what was dropped as sources: PDFs page by page, text files (Markdown, code) as text, links fetched. */
export async function addDropped(
  notebookId: string,
  drop: OutsideDrop,
  onProgress?: (done: number, total: number) => void,
): Promise<{ added: Source[]; problems: string[] }> {
  const added: Source[] = [];
  const problems: string[] = [];
  const total = drop.files.length + drop.links.length;
  let done = 0;
  const step = () => onProgress?.(++done, total);
  for (const file of drop.files) {
    try {
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        added.push(await api.addPdf(notebookId, file, { id: ulid(), name: file.name }));
      } else if (file.size > MAX_TEXT) {
        problems.push(`${file.name}: larger than 2 MB.`);
      } else {
        const text = await file.text();
        if (text.slice(0, 8000).includes('\u0000') || (file.size > 0 && text.length === 0)) {
          problems.push(`${file.name}: not text (a picture, an archive or a program?), so it cannot be read.`);
        } else if (!text.trim()) {
          problems.push(`${file.name}: it is empty.`);
        } else {
          const md = isMarkdownFile(file.name);
          added.push(
            await api.addSource(notebookId, {
              id: ulid(),
              text: fileMarkdown(file.name, text),
              // Markdown takes its title from its heading; anything else, its name.
              ...(md && /^#\s/m.test(text) ? {} : { title: file.name }),
            }),
          );
        }
      }
    } catch (err) {
      problems.push(`${file.name}: ${err instanceof ApiFailure ? err.message : 'it could not be added.'}`);
    }
    step();
  }
  for (const url of drop.links) {
    try {
      added.push(await api.addSource(notebookId, { id: ulid(), url }));
    } catch (err) {
      problems.push(`${url}: ${err instanceof ApiFailure ? err.message : 'it could not be read.'}`);
    }
    step();
  }
  return { added, problems };
}
