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
  pins: (threadId: string) => `noema:spike-pins:${threadId}`,
};
