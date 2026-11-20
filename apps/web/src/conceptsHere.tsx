// The concepts of a material, from its side (ADR 0037): "Concepts here" under
// its title, each a click away from its next place in it; and words selected in
// a thread, a source or a note put under a concept by hand.

import type { MaterialConcepts, VaultTarget } from '@noema/core';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { asRead, CONCEPT_GLYPH, plural } from './roomText.ts';

export interface ConceptsApi {
  notebookId: string;
  /** Counts the concepts' changes made from here, so what shows them reads them again. */
  changed: number;
  openTarget: (t: VaultTarget) => void;
  /** A short line for the learner, as the app says things. */
  say: (text: string) => void;
  /** Open the list of concepts to put words under (kept by the app: the selection goes when the list is used). */
  pick: (target: VaultTarget, at: { top: number; left: number }) => void;
}
export const ConceptsContext = createContext<ConceptsApi | null>(null);

/** "Concepts here: ◎ … · 3 places": a click goes to its next place in this material. */
export function ConceptsHere({ kind, id, version = '' }: { kind: 'thread' | 'source' | 'note'; id: string; version?: string }) {
  const ctx = useContext(ConceptsContext);
  const [concepts, setConcepts] = useState<MaterialConcepts['concepts']>([]);
  const next = useRef(new Map<string, number>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the material changes
  useEffect(() => {
    let live = true;
    void api.materialConcepts(kind, id).then(
      (r) => live && setConcepts(r.concepts),
      () => live && setConcepts([]),
    );
    return () => {
      live = false;
    };
  }, [kind, id, version, ctx?.changed]);
  if (!ctx || concepts.length === 0) return null;
  const go = (c: MaterialConcepts['concepts'][number]) => {
    const places = c.places.filter((p) => p.target);
    if (places.length === 0) return;
    const i = (next.current.get(c.id) ?? 0) % places.length;
    next.current.set(c.id, i + 1);
    const t = places[i]?.target;
    if (t) ctx.openTarget(t);
  };
  return (
    <p className="concepts-here" data-testid="concepts-here">
      <span className="hint">Concepts here:</span>
      {concepts.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`concepts-here-chip${c.status === 'suggested' ? ' is-suggested' : ''}`}
          onClick={() => go(c)}
          title={c.status === 'suggested' ? 'Suggested by the AI. Click to go to its places here, one after another.' : 'Click to go to its places here, one after another.'}
          data-testid="concepts-here-chip"
        >
          {CONCEPT_GLYPH} {c.title}
          <span className="hint"> · {plural(c.places.length, 'place')}</span>
        </button>
      ))}
    </p>
  );
}

/** "◎ Under a concept…" for words selected: the list of the notebook's concepts to put them under. */
export function UnderConcept({ target, at }: { target: () => VaultTarget | null; at: { top: number; left: number } }) {
  const ctx = useContext(ConceptsContext);
  if (!ctx) return null;
  return (
    <button
      type="button"
      className="selection-button secondary"
      data-testid="under-concept"
      title="Put these words under a concept, as one of its places"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const t = target();
        if (t) ctx.pick(t, at);
      }}
    >
      {CONCEPT_GLYPH} Under a concept…
    </button>
  );
}

export function ConceptPicker({
  target,
  top,
  left,
  onClose,
  onDone,
}: {
  target: VaultTarget;
  top: number;
  left: number;
  onClose: () => void;
  onDone: (title: string) => void;
}) {
  const ctx = useContext(ConceptsContext);
  const [list, setList] = useState<Array<{ id: string; title: string; status: 'suggested' | 'kept' }> | null>(null);
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!ctx) return;
    void api.notebookConcepts(ctx.notebookId).then(
      (r) => setList(r.concepts),
      () => setList([]),
    );
  }, [ctx]);
  const shown = (list ?? []).filter((c) => c.title.toLowerCase().includes(typed.trim().toLowerCase())).slice(0, 12);
  const put = async (id: string, title: string) => {
    try {
      await api.addConceptPlace(id, target);
      onDone(title);
    } catch {
      setProblem('It could not be put there.');
    }
  };
  return (
    <div
      className="concept-picker"
      style={{ top: Math.max(8, top), left: Math.max(8, left - 140) }}
      role="dialog"
      aria-label="Put the words under a concept"
      data-testid="concept-picker"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <p className="concept-picker-quote">“{asRead(target.quote ?? '')}”</p>
      {/* biome-ignore lint/a11y/noAutofocus: typed into at once, after the click that opened it */}
      <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Find a concept" aria-label="Find a concept" autoFocus data-testid="concept-picker-find" />
      {list === null ? (
        <p className="hint">…</p>
      ) : shown.length === 0 ? (
        <p className="hint">{list.length === 0 ? 'No concepts yet: read a room with AI, or make one in its Concepts.' : 'No concept by that name.'}</p>
      ) : (
        <ul>
          {shown.map((c) => (
            <li key={c.id}>
              <button type="button" className="quiet" onClick={() => void put(c.id, c.title)} data-testid="concept-picker-item">
                {CONCEPT_GLYPH} {c.title}
                {c.status === 'suggested' && <span className="hint"> · suggested</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {problem && <p className="hint">{problem}</p>}
      <button type="button" className="quiet inline concept-picker-close" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}
