// localStorage for small per-tab conveniences (drafts, the outbox, spike
// pins). Never the source of truth: the server's store is. Every access is
// guarded because storage can be full, disabled or missing.

export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // full or disabled: the feature degrades, nothing breaks
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  },
  getJson<T>(key: string, fallback: T): T {
    const raw = storage.get(key);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  setJson(key: string, value: unknown): void {
    storage.set(key, JSON.stringify(value));
  },
};

export const keys = {
  draft: (threadId: string) => `noema:draft:${threadId}`,
  outbox: (threadId: string) => `noema:outbox:${threadId}`,
  /** Whether a merged card is open, as this reader left it. */
  mergeOpen: (mergeId: string) => `noema:merge-open:${mergeId}`,
  /** The last thread, map or note open in this browser, and when: where Noema reopens. */
  lastPlace: 'noema:last-place',
  /** Threads whose side questions are folded away in the sidebar. */
  sidebarFolded: 'noema:sidebar-folded',
  sidebarSection: 'noema:sidebar-section',
  sidebarCollapsed: 'noema:sidebar-collapsed',
  /** The Assistant open beside what is open, and how wide. */
  assistantDock: 'noema:assistant-dock',
  assistantDockWidth: 'noema:assistant-dock-width',
  /** Folders of linked folders shown open in Files. */
  filesOpen: 'noema:files-open',
};
