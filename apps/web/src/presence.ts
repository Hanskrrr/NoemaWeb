// What the Assistant is doing, for the living frame around the window and
// its orb (ADR 0023). One small store outside React state: the thread view
// sets it, the frame and the orb read it, and pulses (one per piece of text
// written, one per key typed) go straight to the frame without re-rendering.

import { useSyncExternalStore } from 'react';

export type Presence =
  /** The Assistant is not open: no frame. */
  | 'off'
  /** Open, waiting for a question. */
  | 'idle'
  /** A question is being typed. */
  | 'listening'
  | 'thinking'
  | 'looking'
  | 'writing'
  /** It just finished: a short bloom, then idle. */
  | 'done';

const DONE_MS = 1600;

let state: Presence = 'off';
let doneTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const pulses = new Set<(strength: number) => void>();

export function getPresence(): Presence {
  return state;
}

export function setPresence(next: Presence): void {
  clearTimeout(doneTimer);
  if (next === 'done') doneTimer = setTimeout(() => setPresence('idle'), DONE_MS);
  if (next === state) return;
  state = next;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function usePresence(): Presence {
  return useSyncExternalStore(subscribe, getPresence, () => 'off');
}

/** A beat of activity: text written, or a key typed (0 to 1). */
export function pulse(strength = 0.35): void {
  for (const fn of pulses) fn(strength);
}

export function onPulse(fn: (strength: number) => void): () => void {
  pulses.add(fn);
  return () => pulses.delete(fn);
}

/** The presence an answer's state gives: what the stream says it is doing, or done. */
export function presenceOf(
  status: 'pending' | 'streaming' | 'done' | 'failed' | 'interrupted' | 'stopped',
  phase: 'thinking' | 'looking' | 'writing' | null,
): Presence {
  if (status === 'pending' || status === 'streaming') return phase ?? (status === 'streaming' ? 'writing' : 'thinking');
  return status === 'done' ? 'done' : 'idle';
}
