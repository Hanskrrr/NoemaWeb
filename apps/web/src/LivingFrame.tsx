// The living frame (ADR 0023): while the Assistant is open, a soft light runs
// around the edge of the window, and shows what it is doing. It breathes
// while it waits, flows while it thinks, sweeps quickly while it looks things
// up, pulses with the words as it writes, and blooms when it is done.
//
// One fixed layer that takes no clicks. The colours change with CSS (they are
// registered properties, so they fade); the light turns with the Web
// Animations API, whose speed changes without a jump. With reduced motion
// asked for, nothing turns: the frame only fades between states.

import { useEffect, useRef } from 'react';
import { onPulse, type Presence, usePresence } from './presence.ts';

/** Turns per second, by state: slow when waiting, quick when looking. */
const SPEED: Record<Presence, number> = {
  off: 0,
  idle: 1 / 16,
  listening: 1 / 11,
  thinking: 1 / 5,
  looking: 1 / 1.8,
  writing: 1 / 6,
  done: 1 / 3,
};
const BASE_TURN_MS = 16_000;

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function LivingFrame() {
  const presence = usePresence();
  const root = useRef<HTMLDivElement>(null);
  const spins = useRef<Animation[]>([]);

  // The light turns: one animation per layer, made once, sped up or slowed down.
  useEffect(() => {
    const el = root.current;
    if (!el || reducedMotion() || typeof el.animate !== 'function') return;
    const made = Array.from(el.querySelectorAll<HTMLElement>('.lf-spin')).map((spin) =>
      spin.animate(
        [{ transform: 'translate(-50%, -50%) rotate(0turn)' }, { transform: 'translate(-50%, -50%) rotate(1turn)' }],
        { duration: BASE_TURN_MS, iterations: Number.POSITIVE_INFINITY },
      ),
    );
    spins.current = made;
    return () => {
      for (const a of made) a.cancel();
      spins.current = [];
    };
  }, []);

  useEffect(() => {
    const rate = SPEED[presence] * (BASE_TURN_MS / 1000);
    for (const a of spins.current) {
      if (presence === 'off') a.pause();
      else {
        if (a.playState === 'paused') a.play();
        a.updatePlaybackRate(rate);
      }
    }
  }, [presence]);

  // Pulses: each raises the glow, which falls back by itself.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let energy = 0;
    let frame = 0;
    const tick = () => {
      energy *= 0.9;
      if (energy < 0.01) energy = 0;
      el.style.setProperty('--energy', energy.toFixed(3));
      frame = energy > 0 ? requestAnimationFrame(tick) : 0;
    };
    const off = onPulse((strength) => {
      energy = Math.min(1, energy + strength);
      if (!frame) frame = requestAnimationFrame(tick);
    });
    return () => {
      off();
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div ref={root} className="living-frame" data-presence={presence} aria-hidden data-testid="living-frame">
      <div className="lf-layer lf-glow">
        <div className="lf-ring">
          <div className="lf-spin" />
        </div>
      </div>
      <div className="lf-layer lf-edge">
        <div className="lf-ring">
          <div className="lf-spin" />
        </div>
      </div>
    </div>
  );
}

/** The Assistant's orb: the same light, small, beside its name. */
export function Orb({ size = 'normal' }: { size?: 'small' | 'normal' | 'large' }) {
  const presence = usePresence();
  return (
    <span className={`orb orb-${size}`} data-presence={presence === 'off' ? 'idle' : presence} aria-hidden>
      <span className="orb-core" />
    </span>
  );
}
