// A room as a path (ADR 0035): the order to study it in, made from the links
// kept. Each step says what it comes after and what is still open in it;
// things that contrast stand side by side (3 and 3′). What no link orders yet
// waits at the end. The steps are things, or concepts when the room has them
// (ADR 0036).

import { LINK_WORDS, type PathLink, pathOrder } from '@noema/core';
import type { MouseEvent, ReactNode } from 'react';

export interface PathNode {
  key: string;
  title: string;
  glyph: string;
  /** Its colour's kind (thread, source, note, concept). */
  kind: string;
  /** What the AI wrote of it, if anything. */
  text: string | null;
  open: string[];
  /** Side questions not come back from. */
  sides: number;
  onOpen: () => void;
  onMenu?: (e: MouseEvent) => void;
}

export function RoomPath({ nodes, links, empty }: { nodes: PathNode[]; links: PathLink[]; empty: ReactNode }) {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const path = pathOrder(
    nodes.map((n) => n.key),
    links,
  );
  if (nodes.length === 0) return <div className="room-path-view">{empty}</div>;
  // Numbers: 1, 2, 3 for the steps; 3′ for what stands beside 3.
  const number = new Map<string, string>();
  path.steps.forEach((s, i) => {
    number.set(s.key, String(i + 1));
    for (const b of s.beside) number.set(b, `${i + 1}′`);
  });
  /** How it comes after each thing before it: "builds on 1", "explains 2". */
  const afterWords = (key: string, after: string[]) =>
    after.flatMap((a) => {
      const link = links.find((l) => l.from === key && l.to === a);
      return link ? [`${LINK_WORDS[link.kind]} ${number.get(a) ?? ''}`] : [];
    });
  const besideWords = (key: string, main: string) => {
    const link = links.find((l) => (l.from === key && l.to === main) || (l.to === key && l.from === main));
    return `beside ${number.get(main)}${link ? `: ${link.kind === 'contrasts-with' ? 'another way' : 'the same question'}` : ''}`;
  };
  const step = (key: string, label: string, mark: string, beside: boolean) => {
    const n = byKey.get(key);
    if (!n) return null;
    return (
      <li key={key} className={`path-step${beside ? ' is-beside' : ''}`} data-key={key} data-testid="path-step">
        <span className="path-num" aria-hidden>
          {number.get(key)}
        </span>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: right-click is a shortcut; its button opens it */}
        <div className={`path-card kind-${n.kind}`} onContextMenu={n.onMenu}>
          <p className="path-head">
            <button type="button" className="path-title" onClick={n.onOpen} data-testid="path-open">
              <span className="path-glyph" aria-hidden>
                {n.glyph}
              </span>{' '}
              {n.title || 'Untitled'}
            </button>
            <span className="path-after" data-testid="path-after">
              {label || mark}
            </span>
          </p>
          {n.text && <p className="path-text">{n.text}</p>}
          {(n.open.length > 0 || n.sides > 0) && (
            <ul className="path-open">
              {n.open.map((q, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
                <li key={i}>? {q}</li>
              ))}
              {n.sides > 0 && (
                <li>
                  {n.sides} side question{n.sides === 1 ? '' : 's'} you did not come back from
                </li>
              )}
            </ul>
          )}
        </div>
      </li>
    );
  };
  return (
    <div className="room-path-view" data-testid="room-path-view">
      {path.steps.length === 0 ? (
        <div className="path-empty" data-testid="path-empty">
          <p className="empty-title">No order yet</p>
          <p className="hint">
            The path is made from the links you keep: what builds on what, what is an example of what, what explains
            what. Keep the links Read with AI suggests (Review), or draw them on the Board, and the order appears here.
          </p>
        </div>
      ) : (
        <ol className="path-steps">
          {path.steps.map((s) => (
            <li key={s.key} className="path-group">
              <ol className="path-group-steps">
                {step(s.key, afterWords(s.key, s.after).join(' · '), s.level === 0 ? 'start here' : '', false)}
                {s.beside.map((b) => step(b, besideWords(b, s.key), '', true))}
              </ol>
            </li>
          ))}
        </ol>
      )}
      {path.broken > 0 && (
        <p className="hint path-note">
          {path.broken === 1 ? 'One link went' : `${path.broken} links went`} round in a circle; the last one made is left out of the order.
        </p>
      )}
      {path.loose.length > 0 && path.steps.length > 0 && (
        <p className="path-loose" data-testid="path-loose">
          <span className="hint">Not on the path yet:</span>
          {path.loose.map((k) => {
            const n = byKey.get(k);
            if (!n) return null;
            return (
              <button key={k} type="button" className="path-chip" onClick={n.onOpen} onContextMenu={n.onMenu} data-testid="path-loose-item">
                <span aria-hidden>{n.glyph} </span>
                {n.title || 'Untitled'}
              </button>
            );
          })}
          <span className="hint">Link them to what they build on, and they take their place.</span>
        </p>
      )}
    </div>
  );
}
