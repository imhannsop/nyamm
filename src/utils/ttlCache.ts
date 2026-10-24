type Entry<V> = { value: V; expiresAt: number };

/**
 * Small LRU with per-entry expiry. Scraper results are stable for hours while the upstream
 * costs seconds per request, so the cache is what keeps a merged episode chain usable.
 * Stateless hosting (Vercel) starts each instance empty; that is a slower first hit, not a
 * correctness problem.
 */
export const createTtlCache = <V>(max: number) => {
  const entries = new Map<string, Entry<V>>();

  return {
    get(key: string): V | undefined {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (hit.expiresAt <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      // Re-insert to move it to the back, i.e. mark it most recently used.
      entries.delete(key);
      entries.set(key, hit);
      return hit.value;
    },
    set(key: string, value: V, ttlMs: number) {
      if (entries.size >= max) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    delete(key: string) {
      entries.delete(key);
    },
    size: () => entries.size,
  };
};

export const HOUR_MS = 3_600_000;
