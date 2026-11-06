// Where the learner is, kept in the URL hash so reload, Back/Forward and
// bookmarks work:
//   #/t/<threadId>                  a thread or branch
//   #/t/<threadId>/from/<branchId>  a thread, returning from one of its branches
//   #/new                           a new thread, before its first question

import { isUlid } from '@noema/core';
import { useCallback, useEffect, useState } from 'react';

export type Route = { kind: 'thread'; id: string; from?: string | undefined } | { kind: 'new' };

export function parseHash(hash: string): Route | null {
  const parts = hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'new') return { kind: 'new' };
  if (parts[0] === 't' && isUlid(parts[1])) {
    const from = parts[2] === 'from' && isUlid(parts[3]) ? parts[3] : undefined;
    return { kind: 'thread', id: parts[1], from };
  }
  return null;
}

export function toHash(route: Route): string {
  if (route.kind === 'new') return '#/new';
  return route.from ? `#/t/${route.id}/from/${route.from}` : `#/t/${route.id}`;
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
