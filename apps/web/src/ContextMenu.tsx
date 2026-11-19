// A menu at the pointer, for right-click (or the menu key, or Shift+F10, on
// something focused). One at a time, for the whole app: openMenu() shows it,
// the host draws it. Arrow keys move, Enter picks, Escape closes.

import { type KeyboardEvent, type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';

export type MenuItem =
  | { kind: 'heading'; label: string }
  | { kind: 'separator' }
  | {
      kind?: 'item';
      label: string;
      onSelect: () => void | Promise<void>;
      /** A thing it is in (a room), shown with a tick; picking it again takes it out. */
      checked?: boolean;
      hint?: string;
      testId?: string;
    }
  | {
      kind: 'input';
      label: string;
      placeholder: string;
      onSubmit: (text: string) => void | Promise<void>;
      testId?: string;
    }
  | {
      /** Something that cannot be undone (ADR 0034): picked, the menu asks first, in words, with the button to do it. */
      kind: 'confirm';
      label: string;
      ask: string;
      confirm: string;
      onConfirm: () => void | Promise<void>;
      testId?: string;
    };

interface Menu {
  x: number;
  y: number;
  items: MenuItem[];
  label: string;
}

let current: Menu | null = null;
const listeners = new Set<(m: Menu | null) => void>();
function set(menu: Menu | null) {
  current = menu;
  for (const l of listeners) l(menu);
}

/** Show a menu where the pointer is (or under the element, from the keyboard). */
export function openMenu(e: MouseEvent, items: MenuItem[], label = 'Actions') {
  e.preventDefault();
  e.stopPropagation();
  let { clientX: x, clientY: y } = e;
  // From the keyboard there is no pointer: under the element.
  if (x === 0 && y === 0) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    x = r.left + 12;
    y = r.bottom;
  }
  set({ x, y, items, label });
}
export const closeMenu = () => set(null);

export function ContextMenuHost() {
  const [menu, setMenu] = useState<Menu | null>(current);
  const [typing, setTyping] = useState<number | null>(null);
  const [asking, setAsking] = useState<number | null>(null);
  const [text, setText] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  useEffect(() => {
    const l = (m: Menu | null) => {
      setMenu(m);
      setTyping(null);
      setAsking(null);
      setText('');
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  // Kept inside the window.
  useLayoutEffect(() => {
    if (!menu || !box.current) return;
    const r = box.current.getBoundingClientRect();
    setAt({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8)),
    });
    // Asking before something that cannot be undone, Cancel is where the keyboard is.
    const items = box.current.querySelectorAll<HTMLElement>('[role^="menuitem"]');
    (asking === null ? items[0] : items[items.length - 1])?.focus();
  }, [menu, asking]);

  useEffect(() => {
    if (!menu) return;
    const away = (e: Event) => {
      if (box.current && e.target instanceof Node && box.current.contains(e.target)) return;
      closeMenu();
    };
    const gone = () => closeMenu();
    // Scrolling closes it: the wheel or a finger, not a scroll event, which can
    // arrive just after a right-click for a scroll made before it.
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('wheel', away, { capture: true, passive: true });
    document.addEventListener('touchmove', away, { capture: true, passive: true });
    window.addEventListener('blur', gone);
    window.addEventListener('resize', gone);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('wheel', away, true);
      document.removeEventListener('touchmove', away, true);
      window.removeEventListener('blur', gone);
      window.removeEventListener('resize', gone);
    };
  }, [menu]);

  if (!menu) return null;

  // Asking before something that cannot be undone: only that, in the menu's place.
  const ask = asking === null ? null : menu.items[asking];
  if (ask && ask.kind === 'confirm') {
    return (
      // biome-ignore lint/a11y/useSemanticElements: a question in the menu's place, not a dialog of its own
      <div
        ref={box}
        className="context-menu context-ask"
        role="menu"
        aria-label={ask.label}
        style={{ left: at.left, top: at.top }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            closeMenu();
          }
        }}
        onContextMenu={(e) => e.preventDefault()}
        data-testid="context-ask"
      >
        <p className="context-ask-text">{ask.ask}</p>
        <div className="context-ask-buttons">
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              closeMenu();
              void ask.onConfirm();
            }}
            data-testid={ask.testId ? `${ask.testId}-yes` : undefined}
          >
            {ask.confirm}
          </button>
          <button type="button" role="menuitem" className="quiet" onClick={closeMenu}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const move = (e: KeyboardEvent) => {
    const items = [...(box.current?.querySelectorAll<HTMLElement>('[role^="menuitem"], input') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
      next?.focus();
    } else if (e.key === 'Tab') {
      e.preventDefault();
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a menu of actions, not a select
    <div
      ref={box}
      className="context-menu"
      role="menu"
      aria-label={menu.label}
      style={{ left: at.left, top: at.top }}
      onKeyDown={move}
      onContextMenu={(e) => e.preventDefault()}
      data-testid="context-menu"
    >
      {menu.items.map((item, i) => {
        if (item.kind === 'heading') {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
            <div key={i} className="context-heading" role="presentation">
              {item.label}
            </div>
          );
        }
        if (item.kind === 'separator') {
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
          return <hr key={i} className="context-separator" />;
        }
        if (item.kind === 'confirm') {
          return (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
              key={i}
              type="button"
              role="menuitem"
              className="context-item context-danger"
              onClick={() => setAsking(i)}
              data-testid={item.testId}
            >
              <span className="context-check" aria-hidden />
              {item.label}
            </button>
          );
        }
        if (item.kind === 'input') {
          return typing === i ? (
            <form
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
              key={i}
              className="context-input"
              onSubmit={(e) => {
                e.preventDefault();
                if (!text.trim()) return;
                closeMenu();
                void item.onSubmit(text.trim());
              }}
            >
              <input
                // biome-ignore lint/a11y/noAutofocus: typed right after picking it
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={item.placeholder}
                aria-label={item.label}
                maxLength={200}
                data-testid={item.testId ? `${item.testId}-input` : undefined}
              />
            </form>
          ) : (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
              key={i}
              type="button"
              role="menuitem"
              className="context-item"
              onClick={() => setTyping(i)}
              data-testid={item.testId}
            >
              <span className="context-check" aria-hidden>
                +
              </span>
              {item.label}
            </button>
          );
        }
        return (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
            key={i}
            type="button"
            role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={item.checked}
            className="context-item"
            onClick={() => {
              closeMenu();
              void item.onSelect();
            }}
            title={item.hint}
            data-testid={item.testId}
          >
            <span className="context-check" aria-hidden>
              {item.checked ? '✓' : ''}
            </span>
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
