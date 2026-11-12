// "Asked before" reminders come from two checks: words compared at once, and
// the model reading for meaning a moment later. This puts them together.

import type { AskedHit } from '@noema/core';

/**
 * At most `limit` reminders, one per thread, `same` before `related`. A hit
 * found both ways is one hit, with the stronger reading; the model's reading
 * comes first among equals, since it read for meaning.
 */
export function mergeAsked(words: AskedHit[], meaning: AskedHit[], limit = 2): AskedHit[] {
  const byThread = new Map<string, AskedHit>();
  for (const hit of [...meaning, ...words]) {
    const have = byThread.get(hit.threadId);
    if (!have) byThread.set(hit.threadId, hit);
    else if (have.strength === 'related' && hit.strength === 'same') byThread.set(hit.threadId, hit);
  }
  const all = [...byThread.values()];
  return [...all.filter((h) => h.strength === 'same'), ...all.filter((h) => h.strength === 'related')].slice(0, limit);
}
