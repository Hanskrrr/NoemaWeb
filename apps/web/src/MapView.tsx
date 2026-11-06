// The map of one thread: everything you went through in it and below it, on
// one page. Each question in order with the start of its answer; every side
// question hangs off the exact message and passage it came from, nested as
// deep as you went. Every thread has its own map, with the way up to the
// maps above it. Everything is a way back to the exact place. Built from
// what is stored; no model involved.

import type { MapExchange, MapNode, ThreadMap } from '@noema/core';
import { useEffect, useState } from 'react';
import { ApiFailure, api } from './api.ts';

interface Go {
  toMessage: (threadId: string, messageId: string) => void;
  toPassage: (parentThreadId: string, branchThreadId: string) => void;
  toThread: (threadId: string) => void;
  toMap: (threadId: string) => void;
}

function count(node: MapNode): { questions: number; branches: number; deepest: number } {
  let questions = node.exchanges.length;
  let branches = 0;
  let deepest = 0;
  for (const e of node.exchanges) {
    for (const b of e.branches) {
      if (b.split) continue;
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
        {map.path.length > 0 ? (
          <nav className="map-kicker crumbs" aria-label="Maps above this one">
            {map.path.map((p) => (
              <span key={p.threadId}>
                <button type="button" className="quiet" onClick={() => go.toMap(p.threadId)} data-testid="map-up">
                  {p.title || 'Untitled'}
                </button>
                {' › '}
              </span>
            ))}
            Map
          </nav>
        ) : (
          <p className="map-kicker">Map</p>
        )}
        <h1>{root.title || 'Untitled'}</h1>
        {map.parent && root.origin && (
          <button
            type="button"
            className="map-from"
            onClick={() => go.toPassage(map.parent?.threadId as string, root.threadId)}
            title="Jump to this passage"
            data-testid="map-from"
          >
            {map.path.length === 0 ? 'Made its own thread from' : 'Asked about'} “{root.origin.exact}” in{' '}
            {map.parent.title || 'Untitled'}
          </button>
        )}
        {map.continuedFrom && (
          <button
            type="button"
            className="map-from"
            onClick={() => go.toMap(map.continuedFrom?.threadId as string)}
            title="Open the map of the thread it was split off from"
            data-testid="map-continued-from"
          >
            Split off from {map.continuedFrom.title || 'Untitled'}
          </button>
        )}
        <p className="map-stats">
          {c.questions} {c.questions === 1 ? 'question' : 'questions'} · {c.branches}{' '}
          {c.branches === 1 ? 'side question' : 'side questions'}
          {c.deepest > 1 ? ` · ${c.deepest} levels deep` : ''}
        </p>
        <button type="button" className="quiet" onClick={() => go.toThread(root.threadId)} data-testid="map-back">
          ← Back to the thread
        </button>
      </header>
      <NodeView node={root} go={go} />
      {map.continuedIn.map((c) => (
        <p key={c.threadId} className="continued-in" data-testid="map-continued-in">
          Continues in{' '}
          <button type="button" className="quiet inline" onClick={() => go.toMap(c.threadId)}>
            {c.title || 'Untitled'} →
          </button>
        </p>
      ))}
    </main>
  );
}

function NodeView({ node, go }: { node: MapNode; go: Go }) {
  return (
    <ol className="map-thread">
      {node.exchanges.map((e) => (
        <ExchangeView key={e.questionId} node={node} exchange={e} go={go} />
      ))}
      {node.exchanges.length === 0 && <li className="map-empty">No questions yet.</li>}
    </ol>
  );
}

function ExchangeView({ node, exchange: e, go }: { node: MapNode; exchange: MapExchange; go: Go }) {
  return (
    <li className="map-exchange" data-testid="map-exchange">
      <span className="map-index" aria-hidden>
        {e.index}
      </span>
      <div className="map-body">
        {e.headline && e.answerId ? (
          <>
            {/* What the exchange established, in the model's line; the learner's own question beneath. */}
            <button
              type="button"
              className="map-headline"
              onClick={() => go.toMessage(node.threadId, e.answerId as string)}
              data-testid="map-headline"
            >
              {e.headline}
            </button>
            <button
              type="button"
              className="map-asked"
              onClick={() => go.toMessage(node.threadId, e.questionId)}
              data-testid="map-question"
            >
              You asked: {e.question}
            </button>
          </>
        ) : (
          <>
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
          </>
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
                {b.split ? (
                  <button
                    type="button"
                    className="map-branch-title"
                    onClick={() => go.toMap(b.threadId)}
                    title="Made its own thread: open its map"
                    data-testid="map-split"
                  >
                    ↗ {b.title || 'Side question'} <span className="map-own">its own thread</span>
                  </button>
                ) : (
                  <>
                    <button type="button" className="map-branch-title" onClick={() => go.toThread(b.threadId)}>
                      ↳ {b.title || 'Side question'}
                      {b.mergedIntoId === node.threadId && <span className="map-own">merged back</span>}
                    </button>
                    <NodeView node={b} go={go} />
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}
