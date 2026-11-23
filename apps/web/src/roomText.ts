// Words and marks shared by the ways to see a room (ADR 0035): Board, Folders, Path, Concepts.

import type { RoomKind, RoomView } from '@noema/core';

export type RoomCard = RoomView['clusters'][number]['cards'][number];
export type Door = RoomView['doors'][number];

export const GLYPH: Record<RoomKind, string> = { source: '❡', thread: '◦', note: '▤' };
export const ROOM_GLYPH = '⌂';
export const CONCEPT_GLYPH = '◎';
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** Words quoted from a material's Markdown, as read: without the marks of bold, italics and code. */
export const asRead = (quote: string) => quote.replace(/(\*\*|__|`)(?=\S)([\s\S]*?\S)\1/g, '$2').replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1');
export const day = (at: string) => (at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');

/** What a card says was done there. */
export function marksOf(c: RoomCard): string {
  const m = c.marks;
  const parts: string[] = [];
  if (c.kind === 'source' && m.threads) parts.push(plural(m.threads, 'thread'));
  if (c.kind !== 'note') {
    if (m.questions) parts.push(plural(m.questions, 'question'));
    if (m.sides) parts.push(plural(m.sides, 'side question'));
  } else {
    parts.push(plural(m.blocks, 'block'));
  }
  return parts.join(' · ');
}
export const kindName = (c: Pick<RoomCard, 'kind' | 'file'>) =>
  c.kind === 'source' ? (c.file ? 'File' : 'Source') : c.kind === 'thread' ? 'Thread' : 'Note';
/** A card's key ("thread:01…") as the thing it is. */
export const refOf = (key: string) => {
  const i = key.indexOf(':');
  return { kind: key.slice(0, i) as RoomKind, id: key.slice(i + 1) };
};
/** What a room holds, in words. */
export function holdsOf(c: { sources: number; threads: number; notes: number; rooms: number }): string {
  return [
    ...(c.sources ? [plural(c.sources, 'source')] : []),
    ...(c.threads ? [plural(c.threads, 'thread')] : []),
    ...(c.notes ? [plural(c.notes, 'note')] : []),
    ...(c.rooms ? [plural(c.rooms, 'room')] : []),
  ].join(' · ');
}
