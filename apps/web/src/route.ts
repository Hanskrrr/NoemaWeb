// Where the learner is, kept in the URL hash so reload, Back/Forward and
// bookmarks work:
//   #/t/<threadId>                  a thread or branch
//   #/t/<threadId>/from/<branchId>  a thread, returning from one of its branches (highlights the passage)
//   #/t/<threadId>/m/<messageId>    a thread, scrolled to one exact message
//   #/map/<threadId>                the map of the whole thread tree around a thread
//   #/note/<noteId>                 a note
//   #/new                           a new thread, before its first question

import { isUlid } from '@noema/core';
import { useCallback, useEffect, useState } from 'react';

export type Route =
  | { kind: 'thread'; id: string; from?: string | undefined; message?: string | undefined }
  | { kind: 'map'; id: string }
  | { kind: 'note'; id: string }
  | { kind: 'new' };

export function parseHash(hash: string): Route | null {
  const parts = hash.replace(/^#\/?/, '').split('/');
  const [head, id, sub, subId] = parts;
  if (head === 'new') return { kind: 'new' };
  if (!isUlid(id)) return null;
  if (head === 'map') return { kind: 'map', id };
  if (head === 'note') return { kind: 'note', id };
  if (head === 't') {
    if (sub === 'from' && isUlid(subId)) return { kind: 'thread', id, from: subId };
    if (sub === 'm' && isUlid(subId)) return { kind: 'thread', id, message: subId };
    return { kind: 'thread', id };
  }
  return null;
}

export function toHash(route: Route): string {
  switch (route.kind) {
    case 'new':
      return '#/new';
    case 'map':
      return `#/map/${route.id}`;
    case 'note':
      return `#/note/${route.id}`;
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
