// Right-click on a thread, source or note, wherever it is listed: to the
// Trash (with Undo), or deleted for good once the menu has said what goes
// with it (ADR 0034). The app says how; the lists only offer it.

import { createContext, useContext } from 'react';
import type { MenuItem } from './ContextMenu.tsx';
import type { DragItem } from './drag.ts';

export interface ItemsApi {
  /** To the Trash, with Undo. */
  trash: (item: DragItem) => Promise<void>;
  /** Deleted for good: no Undo. */
  forget: (item: DragItem) => Promise<void>;
  /** What deleting it for good takes with it and leaves, said before it is done. */
  forgetText: (item: DragItem) => string;
}

export const ItemsContext = createContext<ItemsApi | null>(null);
export const useItems = () => useContext(ItemsContext);

/** The menu's last part for a thing: Move to the Trash (unless it is there), and Delete forever…, which asks first. */
export function deleteItems(items: ItemsApi | null, item: DragItem, opts: { trashed?: boolean } = {}): MenuItem[] {
  if (!items) return [];
  return [
    { kind: 'separator' },
    ...(opts.trashed ? [] : [{ label: 'Move to the Trash', onSelect: () => items.trash(item), testId: 'menu-trash' }]),
    {
      kind: 'confirm',
      label: 'Delete forever…',
      ask: items.forgetText(item),
      confirm: 'Delete forever',
      onConfirm: () => items.forget(item),
      testId: 'menu-forever',
    },
  ];
}
