// ULIDs: 48-bit millisecond time + 80 random bits, Crockford base32, 26 chars.
// They sort by creation time, so the client can make ids before the server
// sees a request (that is what makes POSTs idempotent) and ordering still holds.
// Monotonic within one process: ids made in the same millisecond still sort.

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const TIME_MAX = 2 ** 48 - 1;
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

let lastTime = -1;
let lastRandom: number[] = [];

function randomDigits(): number[] {
  const bytes = new Uint8Array(RANDOM_LEN);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b & 31);
}

function increment(digits: number[]): number[] {
  const next = digits.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    const d = next[i] as number;
    if (d < 31) {
      next[i] = d + 1;
      return next;
    }
    next[i] = 0;
  }
  throw new Error('ULID random component overflowed within one millisecond');
}

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > TIME_MAX) throw new RangeError(`bad ULID time: ${ms}`);
  let out = '';
  let t = ms;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  if (now <= lastTime) {
    lastRandom = increment(lastRandom);
  } else {
    lastTime = now;
    lastRandom = randomDigits();
  }
  return encodeTime(lastTime) + lastRandom.map((d) => ENCODING[d]).join('');
}

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_RE.test(value);
}

export function ulidTime(id: string): number {
  if (!isUlid(id)) throw new TypeError(`not a ULID: ${id}`);
  let t = 0;
  for (const ch of id.slice(0, TIME_LEN)) t = t * 32 + ENCODING.indexOf(ch);
  return t;
}
