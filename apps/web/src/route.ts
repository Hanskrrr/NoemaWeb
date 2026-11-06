// Where the learner is, kept in the URL hash so reload, Back/Forward and
// bookmarks work:
//   #/t/<threadId>                  a thread or branch
//   #/t/<threadId>/from/<branchId>  a thread, returning from one of its branches (highlights the passage)
//   #/t/<threadId>/m/<messageId>    a thread, scrolled to one exact message
//   #/map/<threadId>                the map of the whole thread tree around a thread
//   #/note/<noteId>                 a note
//   #/note/<noteId>/b/<blockId>     a note, scrolled to one block
//   #/new                           a new thread, before its first question
//   #/s/<sourceId>                  a source in the reading pane (its latest version)
//   #/s/<sourceId>/v/<versionId>    one version of it
//     …/at/<offset>                 scrolled to the block that holds this offset (from search)
//     …/from/<threadId>             back from a thread asked there: its passage, highlighted
// A thread asked about a source (and its side questions) keeps #/t/…; it is
// shown beside the source.

import { isUlid } from '@noema/core';
import { useCallback, useEffect, useState } from 'react';

export type Route =
  | { kind: 'thread'; id: string; from?: string | undefined; message?: string | undefined }
  | { kind: 'map'; id: string }
  | { kind: 'note'; id: string; block?: string | undefined }
  | {
      kind: 'source';
      id: string;
      version?: string | undefined;
      at?: number | undefined;
      from?: string | undefined;
    }
  | { kind: 'new' };

export function parseHash(hash: string): Route | null {
  const parts = hash.replace(/^#\/?/, '').split('/');
  const [head, id, sub, subId] = parts;
  if (head === 'new') return { kind: 'new' };
  if (!isUlid(id)) return null;
  if (head === 'map') return { kind: 'map', id };
  if (head === 'source' || head === 's') return parseSource(id, parts.slice(2));
  if (head === 'note') return sub === 'b' && isUlid(subId) ? { kind: 'note', id, block: subId } : { kind: 'note', id };
  if (head === 't') {
    if (sub === 'from' && isUlid(subId)) return { kind: 'thread', id, from: subId };
    if (sub === 'm' && isUlid(subId)) return { kind: 'thread', id, message: subId };
    return { kind: 'thread', id };
  }
  return null;
}

function parseSource(id: string, rest: string[]): Route {
  const route: Extract<Route, { kind: 'source' }> = { kind: 'source', id };
  let i = 0;
  if (rest[i] === 'v' && isUlid(rest[i + 1])) {
    route.version = rest[i + 1];
    i += 2;
  }
  if (rest[i] === 'at' && /^\d{1,9}$/.test(rest[i + 1] ?? '')) route.at = Number(rest[i + 1]);
  else if (rest[i] === 'from' && isUlid(rest[i + 1])) route.from = rest[i + 1];
  return route;
}

export function toHash(route: Route): string {
  switch (route.kind) {
    case 'source': {
      let hash = `#/s/${route.id}`;
      if (route.version) hash += `/v/${route.version}`;
      if (route.at !== undefined) hash += `/at/${route.at}`;
      else if (route.from) hash += `/from/${route.from}`;
      return hash;
    }
    case 'new':
      return '#/new';
    case 'map':
      return `#/map/${route.id}`;
    case 'note':
      return route.block ? `#/note/${route.id}/b/${route.block}` : `#/note/${route.id}`;
    case 'thread':
      if (route.from) return `#/t/${route.id}/from/${route.from}`;
      if (route.message) return `#/t/${route.id}/m/${route.message}`;
      return `#/t/${route.id}`;
  }
}

export function useRoute(): [Route | null, (route: Route, options?: { replace?: boolean }) => void] {
  const [route, setRoute] = useState<Route | null>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((next: Route, options: { replace?: boolean } = {}) => {
    const hash = toHash(next);
    if (options.replace) window.history.replaceState(null, '', hash);
    else if (window.location.hash !== hash) window.history.pushState(null, '', hash);
    setRoute(next);
  }, []);

  return [route, navigate];
}
