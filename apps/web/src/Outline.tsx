// A catalog of the page on the right edge: a short mark per question (or
// per heading, in a note), with side questions and merges under their
// question. It opens into labels on hover or focus, marks where you are as
// you scroll, and jumps on click.

import { useEffect, useRef, useState } from 'react';

export interface OutlineItem {
  id: string;
  label: string;
  level: 1 | 2 | 3;
  kind: 'question' | 'side' | 'merge' | 'heading';
  /** The element this item stands for (for jumping and for "you are here"). */
  target: string;
  /** Jump somewhere more precise than the element's top, such as a passage. */
  go?: (() => void) | undefined;
  /** More about the item, shown on hover. */
  hint?: string | undefined;
}

/** Below this line (from the top of the window) counts as "already read". */
const READ_LINE = 150;

function scrollBehavior(): ScrollBehavior {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

export function Outline({ items, label }: { items: OutlineItem[]; label: string }) {
  const [active, setActive] = useState<string | null>(null);
  const latest = useRef(items);
  latest.current = items;
  const signature = items.map((i) => i.id).join(',');

  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the items by their ids, not by identity
  useEffect(() => {
    let frame = 0;
    const spy = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        let current: string | null = null;
        for (const it of latest.current) {
          if (it.kind === 'side' || it.kind === 'merge') continue; // "you are here" follows the questions and headings
          const el = document.querySelector(it.target);
          if (!el) continue;
          if (el.getBoundingClientRect().top <= READ_LINE) current = it.id;
        }
        setActive(current ?? latest.current[0]?.id ?? null);
      });
    };
    spy();
    window.addEventListener('scroll', spy, { passive: true });
    window.addEventListener('resize', spy);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', spy);
      window.removeEventListener('resize', spy);
    };
  }, [signature]);

  const jump = (it: OutlineItem) => {
    if (it.go) {
      it.go();
      return;
    }
    document.querySelector(it.target)?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  };

  return (
    <nav className="outline" aria-label={label} data-testid="outline">
      <ol>
        {items.map((it) => (
          <li key={it.id} className={`outline-${it.kind} level-${it.level}${it.id === active ? ' active' : ''}`}>
            <button
              type="button"
              onClick={() => jump(it)}
              aria-current={it.id === active ? 'location' : undefined}
              title={it.hint ?? it.label}
              data-testid="outline-item"
              data-kind={it.kind}
            >
              <span className="outline-label">{it.label}</span>
              <span className="outline-tick" aria-hidden />
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Scroll so a range of text sits in the middle of the window. */
export function scrollRangeIntoView(range: Range | null): void {
  if (!range) return;
  const rect = range.getBoundingClientRect();
  window.scrollTo({
    top: window.scrollY + rect.top - window.innerHeight / 2 + rect.height / 2,
    behavior: scrollBehavior(),
  });
}

/** A short label from a question or heading. */
export function shortLabel(text: string, max = 70): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
