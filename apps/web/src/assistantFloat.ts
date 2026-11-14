// The Assistant floating over whatever is open (ADR 0028): where its window
// is and how big, kept inside the window of the browser; and the questions it
// offers for the place the learner is in. No React, no DOM: tested in node.

/** The floating window, held by its bottom-right corner so it stays there when the browser is resized. */
export interface FloatBox {
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export const FLOAT_DEFAULT: FloatBox = { right: 24, bottom: 24, width: 460, height: 620 };
export const FLOAT_MIN = { width: 340, height: 280 };
const FLOAT_MAX_WIDTH = 900;
/** Kept this far from the browser's edges. */
const MARGIN = 8;

/**
 * The box kept inside a browser window of `view` (with `top` taken by the
 * header): no smaller than the least, no bigger than the window, and never
 * out of reach.
 */
export function clampFloat(box: FloatBox, view: { w: number; h: number }, top = 50): FloatBox {
  const width = Math.round(Math.max(Math.min(FLOAT_MIN.width, view.w - 2 * MARGIN), Math.min(box.width, FLOAT_MAX_WIDTH, view.w - 2 * MARGIN)));
  const room = view.h - top - 2 * MARGIN;
  const height = Math.round(Math.max(Math.min(FLOAT_MIN.height, room), Math.min(box.height, room)));
  const right = Math.round(Math.min(Math.max(MARGIN, box.right), Math.max(MARGIN, view.w - width - MARGIN)));
  const bottom = Math.round(Math.min(Math.max(MARGIN, box.bottom), Math.max(MARGIN, view.h - top - height - MARGIN)));
  return { right, bottom, width, height };
}

/** The box as stored; anything unreadable is the default. */
export function readFloat(raw: string | null): FloatBox {
  if (!raw) return FLOAT_DEFAULT;
  try {
    const v = JSON.parse(raw) as Partial<FloatBox>;
    const n = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
    return {
      right: n(v.right, FLOAT_DEFAULT.right),
      bottom: n(v.bottom, FLOAT_DEFAULT.bottom),
      width: n(v.width, FLOAT_DEFAULT.width),
      height: n(v.height, FLOAT_DEFAULT.height),
    };
  } catch {
    return FLOAT_DEFAULT;
  }
}

/** Moved by a drag of (dx, dy) from where it was: held by the bottom-right, so right and bottom go the other way. */
export function moveFloat(start: FloatBox, dx: number, dy: number): FloatBox {
  return { ...start, right: start.right - dx, bottom: start.bottom - dy };
}

/**
 * Resized from its top-left corner by a drag of (dx, dy): the bottom-right
 * corner stays put, and it stops growing at the browser's edge and the header.
 */
export function growFloat(start: FloatBox, dx: number, dy: number, view?: { w: number; h: number }, top = 50): FloatBox {
  let width = start.width - dx;
  let height = start.height - dy;
  if (view) {
    width = Math.min(width, view.w - start.right - MARGIN);
    height = Math.min(height, view.h - top - start.bottom - MARGIN);
  }
  return { ...start, width, height };
}

export type PlaceKind = 'thread' | 'source' | 'note' | 'room';

/** Questions to start from, for where the learner is; they are only words to send, nothing is done until asked. */
export function asksFor(place: PlaceKind | null, selected: boolean): string[] {
  if (selected) return ['Explain what I selected', 'What have I asked about this before?', 'Make a note of this'];
  switch (place) {
    case 'room':
      return ['What does this room add up to?', 'What is still open here?', 'Which of these should be linked?'];
    case 'source':
      return ['What are the key ideas here?', 'What have I asked about this before?', 'What did I not ask about yet?'];
    case 'thread':
      return ['Where did this thread end up?', 'What is still unclear here?', 'Make a note of what I found'];
    case 'note':
      return ['What is this note missing?', 'Which sources back this note?', 'Where did these ideas come from?'];
    default:
      return [
        'Where did I leave off?',
        'What have I asked about the most?',
        'Which side questions did I never come back to?',
        'What did my sources say that my threads never asked about?',
      ];
  }
}
