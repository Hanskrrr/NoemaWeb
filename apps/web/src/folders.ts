// The Folders view of a room (ADR 0035): its rooms inside as folders, its
// threads, sources and notes as files. Pure, so it is tested without a browser.

import type { Room } from '@noema/core';

export type FolderColumn = 'name' | 'kind' | 'touched' | 'open';
export interface FolderSort {
  by: FolderColumn;
  desc: boolean;
}
export const DEFAULT_SORT: FolderSort = { by: 'name', desc: false };

/** What a row is sorted by. */
export interface Sortable {
  folder: boolean;
  title: string;
  kind: string;
  at: string;
  open: number;
}

const byName = (a: Sortable, b: Sortable) =>
  (a.title || 'Untitled').localeCompare(b.title || 'Untitled', undefined, { sensitivity: 'base', numeric: true });

/** Folders stay on top, as Finder keeps them; then by the column, and by name where they are the same. */
export function sortRows<T extends Sortable>(rows: readonly T[], sort: FolderSort): T[] {
  const sign = sort.desc ? -1 : 1;
  const cmp = (a: T, b: T): number => {
    if (a.folder !== b.folder) return a.folder ? -1 : 1;
    let d = 0;
    if (sort.by === 'kind') d = a.kind.localeCompare(b.kind);
    else if (sort.by === 'touched') d = a.at.localeCompare(b.at);
    else if (sort.by === 'open') d = a.open - b.open;
    else d = byName(a, b);
    return d !== 0 ? d * sign : byName(a, b);
  };
  return [...rows].sort(cmp);
}

/** A click on a column: by it, or the other way round if it is the one already. Dates and open questions start newest and most. */
export function nextSort(sort: FolderSort, by: FolderColumn): FolderSort {
  if (sort.by === by) return { by, desc: !sort.desc };
  return { by, desc: by === 'touched' || by === 'open' };
}

/** The other rooms a thing is in: an alias is the same thing, never a copy (ADR 0035). */
export function alsoIn(rooms: readonly Room[], key: string, here: string): Room[] {
  return rooms.filter((r) => r.id !== here && r.members.includes(key as Room['members'][number]));
}

/** The other rooms a room is in. */
export function roomAlsoIn(rooms: readonly Room[], id: string, here: string): Room[] {
  const room = rooms.find((r) => r.id === id);
  if (!room) return [];
  return room.parents.filter((p) => p !== here).flatMap((p) => rooms.find((r) => r.id === p) ?? []);
}

/**
 * Typing to jump to a row, as in Finder: the first row from `from` on (round again from the top) whose name
 * starts with what was typed; -1 if none.
 */
export function typeAhead(titles: readonly string[], typed: string, from: number): number {
  const t = typed.toLowerCase();
  if (!t) return -1;
  const n = titles.length;
  for (let i = 0; i < n; i++) {
    const at = (from + i) % n;
    if ((titles[at] || 'Untitled').toLowerCase().startsWith(t)) return at;
  }
  return -1;
}
