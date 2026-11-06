// The map: everything you went through in one thread tree, on one page.
// Each question in order with the start of its answer; every side question
// hangs off the exact message and passage it came from, nested as deep as
// you went. Everything is a way back to the exact place. Built from what is
// stored; no model involved.

import type { MapExchange, MapNode, ThreadMap } from '@noema/core';
import { useEffect, useState } from 'react';
import { ApiFailure, api } from './api.ts';

interface Go {
  toMessage: (threadId: string, messageId: string) => void;
  toPassage: (parentThreadId: string, branchThreadId: string) => void;
  toThread: (threadId: string) => void;
}

function count(node: MapNode): { questions: number; branches: number; deepest: number } {
  let questions = node.exchanges.length;
  let branches = 0;
  let deepest = 0;
  for (const e of node.exchanges) {
    for (const b of e.branches) {
      const c = count(b);
      questions += c.questions;
      branches += 1 + c.branches;
      deepest = Math.max(deepest, 1 + c.deepest);
    }
  }
  return { questions, branches, deepest };
}

export function MapView({ threadId, ...go }: { threadId: string } & Go) {
  const [map, setMap] = useState<ThreadMap | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .threadMap(threadId)
      .then((m) => !cancelled && setMap(m))
      .catch((err: unknown) => !cancelled && setError(err instanceof ApiFailure ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  if (error) return <main className="thread map-page">{error}</main>;
  if (!map) return <main className="thread map-page" aria-busy />;

  const { root } = map;
  const c = count(root);
  return (
    <main className="thread map-page" data-testid="map">
      <header className="map-head">
        <p className="map-kicker">Map</p>
        <h1>{root.title || 'Untitled'}</h1>
        <p className="map-stats">
          {c.questions} {c.questions === 1 ? 'question' : 'questions'} · {c.branches}{' '}
          {c.branches === 1 ? 'side question' : 'side questions'}
          {c.deepest > 1 ? ` · ${c.deepest} levels deep` : ''}
        </p>
        <button type="button" className="quiet" onClick={() => go.toThread(map.focusThreadId)} data-testid="map-back">
          ← Back to the thread
        </button>
      </header>
      {/* Opened from a branch: that branch is marked so you can see where you are. */}
      <NodeView node={root} focus={map.focusThreadId === root.threadId ? '' : map.focusThreadId} go={go} />
    </main>
  );
}

function NodeView({ node, focus, go }: { node: MapNode; focus: string; go: Go }) {
  return (
    <ol className={`map-thread${node.threadId === focus ? ' is-focus' : ''}`}>
      {node.exchanges.map((e) => (
        <ExchangeView key={e.questionId} node={node} exchange={e} focus={focus} go={go} />
      ))}
      {node.exchanges.length === 0 && <li className="map-empty">No questions yet.</li>}
    </ol>
  );
}

function ExchangeView({ node, exchange: e, focus, go }: { node: MapNode; exchange: MapExchange; focus: string; go: Go }) {
  return (
    <li className="map-exchange" data-testid="map-exchange">
      <span className="map-index" aria-hidden>
        {e.index}
      </span>
      <div className="map-body">
        <button
          type="button"
          className="map-question"
          onClick={() => go.toMessage(node.threadId, e.questionId)}
          data-testid="map-question"
        >
          {e.question}
        </button>
        {e.answerId && e.gist && (
          <button
            type="button"
            className="map-gist"
            onClick={() => go.toMessage(node.threadId, e.answerId as string)}
            data-testid="map-gist"
          >
            {e.gist}
          </button>
        )}
        {e.status !== 'done' && e.answerId && <span className="map-status">{e.status}</span>}
        {e.branches.length > 0 && (
          <ul className="map-branches">
            {e.branches.map((b) => (
              <li key={b.threadId} className="map-branch" data-testid="map-branch">
                {b.origin && (
                  <button
                    type="button"
                    className="map-passage"
                    onClick={() => go.toPassage(node.threadId, b.threadId)}
                    title="Jump to this passage"
                    data-testid="map-passage"
                  >
                    “{b.origin.exact}”
                  </button>
                )}
                <button type="button" className="map-branch-title" onClick={() => go.toThread(b.threadId)}>
                  ↳ {b.title || 'Side question'}
                </button>
                <NodeView node={b} focus={focus} go={go} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}
