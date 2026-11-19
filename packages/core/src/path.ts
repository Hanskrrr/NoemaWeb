// A room as a path (ADR 0035): an order to study its things in, made only from
// the links the learner kept. "A builds on B", "A is an example of B", "A is
// part of B", "A explains B": B comes first. Things that contrast, or ask the
// same, stand side by side. What no such link touches is not on the path yet.
// The same works for concepts (ADR 0036): their keys are "room:id".

import type { LinkKind } from './links.ts';

export interface PathLink {
  from: string;
  to: string;
  kind: LinkKind;
}
export interface PathStep {
  /** The thing at this step, and what stands beside it (contrasts with it, asks the same). */
  key: string;
  beside: string[];
  /** How deep in the order: 0 needs nothing before it. */
  level: number;
  /** What comes before it, by a kept link (of the step's thing and of those beside it). */
  after: string[];
}
export interface Path {
  steps: PathStep[];
  /** Things no ordering link touches, in the order given. */
  loose: string[];
  /** Links left out of the order because they would have gone round in a circle. */
  broken: number;
}

/** Kinds that say which comes first: the far end ("to") before the near one ("from"). */
export const ORDER_KINDS: readonly LinkKind[] = ['builds-on', 'example-of', 'part-of', 'explains'];
/** Kinds that set two things side by side. */
export const BESIDE_KINDS: readonly LinkKind[] = ['contrasts-with', 'same-question'];

export function pathOrder(keys: readonly string[], links: readonly PathLink[]): Path {
  const index = new Map(keys.map((k, i) => [k, i]));
  const before = new Map<string, Set<string>>(keys.map((k) => [k, new Set()]));
  const afterOf = new Map<string, Set<string>>(keys.map((k) => [k, new Set()]));
  const reaches = (from: string, to: string): boolean => {
    // Whether `to` already comes after `from` (so from → to exists, directly or not).
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const k = stack.pop() as string;
      if (k === to) return true;
      if (seen.has(k)) continue;
      seen.add(k);
      for (const n of afterOf.get(k) ?? []) stack.push(n);
    }
    return false;
  };
  let broken = 0;
  const beside = new Map<string, Set<string>>(keys.map((k) => [k, new Set()]));
  for (const l of links) {
    if (!index.has(l.from) || !index.has(l.to) || l.from === l.to) continue;
    if (BESIDE_KINDS.includes(l.kind)) {
      beside.get(l.from)?.add(l.to);
      beside.get(l.to)?.add(l.from);
      continue;
    }
    if (!ORDER_KINDS.includes(l.kind)) continue;
    const first = l.to;
    const then = l.from;
    if (before.get(then)?.has(first)) continue;
    // A link that would close a circle is left out: the earlier ones stand.
    if (reaches(then, first)) {
      broken++;
      continue;
    }
    before.get(then)?.add(first);
    afterOf.get(first)?.add(then);
  }

  const ordered = new Set(keys.filter((k) => (before.get(k)?.size ?? 0) > 0 || (afterOf.get(k)?.size ?? 0) > 0));
  // Levels: one more than the deepest thing before it.
  const level = new Map<string, number>();
  const levelOf = (k: string): number => {
    const known = level.get(k);
    if (known !== undefined) return known;
    let l = 0;
    for (const b of before.get(k) ?? []) l = Math.max(l, levelOf(b) + 1);
    level.set(k, l);
    return l;
  };
  for (const k of ordered) levelOf(k);
  // Side by side with something on the path, and nothing to order it itself: at that thing's level.
  let grew = true;
  while (grew) {
    grew = false;
    for (const k of keys) {
      if (level.has(k)) continue;
      const near = [...(beside.get(k) ?? [])].filter((b) => level.has(b));
      if (near.length === 0) continue;
      level.set(k, Math.min(...near.map((b) => level.get(b) as number)));
      grew = true;
    }
  }

  const onPath = keys.filter((k) => level.has(k));
  const byLevel = [...onPath].sort((a, b) => (level.get(a) as number) - (level.get(b) as number) || (index.get(a) as number) - (index.get(b) as number));
  const placed = new Set<string>();
  const steps: PathStep[] = [];
  for (const k of byLevel) {
    if (placed.has(k)) continue;
    placed.add(k);
    const l = level.get(k) as number;
    // Beside it: what contrasts with it (or with those beside it) at the same level.
    const group: string[] = [];
    const queue = [k];
    while (queue.length) {
      const x = queue.shift() as string;
      for (const b of beside.get(x) ?? []) {
        if (placed.has(b) || level.get(b) !== l) continue;
        placed.add(b);
        group.push(b);
        queue.push(b);
      }
    }
    group.sort((a, b) => (index.get(a) as number) - (index.get(b) as number));
    const after = new Set<string>();
    for (const x of [k, ...group]) for (const b of before.get(x) ?? []) after.add(b);
    steps.push({ key: k, beside: group, level: l, after: keys.filter((x) => after.has(x)) });
  }
  return { steps, loose: keys.filter((k) => !level.has(k)), broken };
}
