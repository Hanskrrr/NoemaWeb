// "Asked before": does a question the learner is about to ask repeat one
// already in the notebook? If so the app can point at the earlier exchange
// before a new thread, side question or note is made.
//
// No embeddings (out of scope for v0.1): this compares words. Three things
// make that work on real questions:
// - What a question is about is often not in its words ("what is this?" on
//   a selected passage), so a question is its text plus the passage it was
//   asked about, and an earlier exchange also counts its thread's title and
//   its one-line headline.
// - Question words and politeness ("what is", "explain", 是什么, 一下) say
//   nothing about the subject and are dropped.
// - A word found all over the notebook says less than a rare one (IDF).
//
// A wrong reminder costs more than a missed one, so matches must cover most
// of what was typed, and at most a few are returned.

import { plainText } from './search.ts';

export interface AskedCandidate {
  /** The earlier question (its message id). */
  id: string;
  threadId: string;
  question: string;
  /** The passage it was asked about, if any. */
  passage?: string | null | undefined;
  /** The title of its thread. */
  title?: string | null | undefined;
  /** The one-line headline of the exchange. */
  headline?: string | null | undefined;
}

export interface AskedMatch {
  id: string;
  threadId: string;
  /** 0 to 1: how much of the question is in the earlier exchange, and how much that exchange is about it. */
  score: number;
  /** `same`: the same question, as far as words can tell. `related`: the question's subject was asked about there. */
  strength: 'same' | 'related';
  /** The subject words they share, as typed, for showing why. */
  terms: string[];
}

const RUN =
  /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+)|((?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}])+)/gu;

// Words that ask, point or are polite, in English and Chinese. They say how
// something is asked, not what about.
const STOP_WORDS = new Set(
  (
    'a an the is are was were be been am of in on at to for and or but if so as by with from into about than then ' +
    'what whats why how when where which who whom whose does do did done can could would should will shall may might must ' +
    'i you me my your we our us it its this that these those there here he she they them his her their ' +
    'explain tell show give please want wanna like learn know understand mean means meaning say says help ' +
    'more some any all very just also not no yes ok okay hello hi thanks thank vs versus between again further detail details ' +
    'difference different example examples simple simply briefly short ' +
    'use used using uses work works working get gets got make makes made need needs thing things way ways kind kinds ' +
    'really actually exactly basically generally often usually always never still even much many most other another ' +
    'same such each every only own too now one out up down over under after before while because since though however ' +
    'had has have having being go goes going come comes take takes put see look let try'
  ).split(' '),
);

// Longest first, so 为什么 goes before 什么.
const STOP_PHRASES = [
  '有什么区别',
  '是什么意思',
  '什么意思',
  '有什么',
  '是什么',
  '什么是',
  '为什么',
  '怎么样',
  '哪一个',
  '我想要',
  '详细一点',
  '再详细',
  '是啥',
  '啥是',
  '为啥',
  '什么',
  '怎么',
  '怎样',
  '如何',
  '这是',
  '这个',
  '这段',
  '这里',
  '这些',
  '那个',
  '哪个',
  '一下',
  '一点',
  '解释',
  '讲解',
  '讲讲',
  '讲了',
  '说说',
  '请问',
  '可以',
  '能否',
  '能不能',
  '我想',
  '想要',
  '继续',
  '进行',
  '一个',
  '关于',
  '以及',
  '还有',
  '你会',
];
const STOP_CHARS = /[的了吗呢吧啊呀么啥和与或是在对把被让你我他她它这那哪请再很也都就还有]/u;

/** One subject token, with the text it came from (for showing). */
interface Token {
  key: string;
  shown: string;
}

/** English words without a plural s, so "gradients" meets "gradient". */
function stem(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

/**
 * The subject of a text as tokens: lower-cased words (question words and
 * politeness dropped), and for Chinese and Japanese the overlapping pairs of
 * each run left after cutting at question phrases and particles.
 */
export function subjectTokens(text: string): Token[] {
  const out: Token[] = [];
  const seen = new Set<string>();
  const add = (key: string, shown: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, shown });
  };
  let clean = plainText(text).normalize('NFKC').toLowerCase();
  for (const phrase of STOP_PHRASES) clean = clean.split(phrase).join(' ');
  for (const m of clean.matchAll(RUN)) {
    if (m[2]) {
      const word = m[2];
      if (STOP_WORDS.has(word) || (word.length < 2 && !/\d/.test(word))) continue;
      add(stem(word), word);
      continue;
    }
    if (!m[1]) continue;
    // Cut the run at particles, then pair up what is left. A single character
    // counts only when it stood alone (熵), not as a leftover of cutting.
    const chars = Array.from(m[1]);
    let piece: string[] = [];
    const flush = () => {
      if (piece.length === 1 && chars.length === 1) add(piece[0] as string, piece[0] as string);
      for (let i = 0; i + 1 < piece.length; i++) add(`${piece[i]}${piece[i + 1]}`, piece.join(''));
      piece = [];
    };
    for (const ch of chars) {
      if (STOP_CHARS.test(ch)) flush();
      else piece.push(ch);
    }
    flush();
  }
  return out;
}

export interface AskedOptions {
  /** At most this many matches (default 2). */
  limit?: number;
  /** Threads whose own questions are not reminders: the one being asked in, and those it came from. */
  exceptThreads?: readonly string[] | undefined;
}

/** Most of what was asked must be in the earlier exchange. */
const MIN_COVER = 0.75;
/** And the earlier question (or its headline or title) must be about it, not just mention it. */
const MIN_FOCUS = 0.4;
/** At this focus, it reads as the same question. */
const SAME_FOCUS = 0.7;
/** Or: the whole earlier question is inside the new one, and makes up at least half of it. */
const WHOLE_BACK = 0.9;
const WHOLE_COVER = 0.5;

/**
 * Earlier exchanges that already asked this, best first. `cover` is the
 * share (by rarity) of the question's subject words found in the earlier
 * exchange; `focus` is how much of one part of that exchange (its question
 * and passage, its headline, or its title) those words make up.
 */
export function askedBefore(
  query: { text: string; passage?: string | null | undefined },
  candidates: AskedCandidate[],
  options: AskedOptions = {},
): AskedMatch[] {
  const asked = subjectTokens(`${query.passage ?? ''}\n${query.text}`);
  if (asked.length === 0 || candidates.length === 0) return [];
  const except = new Set(options.exceptThreads ?? []);
  const pool = candidates.filter((c) => !except.has(c.threadId));
  if (pool.length === 0) return [];

  const parts = pool.map((c) => ({
    asked: new Set(subjectTokens(`${c.passage ?? ''}\n${c.question}`).map((t) => t.key)),
    headline: new Set(subjectTokens(c.headline ?? '').map((t) => t.key)),
    title: new Set(subjectTokens(c.title ?? '').map((t) => t.key)),
  }));
  // How rare each token is among the earlier exchanges.
  const df = new Map<string, number>();
  for (const p of parts) {
    for (const key of new Set([...p.asked, ...p.headline, ...p.title])) df.set(key, (df.get(key) ?? 0) + 1);
  }
  const n = pool.length;
  // A word in no earlier exchange weighs like a typical one there: new words should not drown the rest.
  const known = [...df.values()].map((d) => Math.log(1 + n / d)).sort((a, b) => a - b);
  const typical = known[Math.floor(known.length / 2)] ?? 1;
  const weight = (key: string) => {
    const d = df.get(key);
    return d ? Math.log(1 + n / d) : typical;
  };
  const total = asked.reduce((sum, t) => sum + weight(t.key), 0);

  const matches: AskedMatch[] = [];
  pool.forEach((c, i) => {
    const p = parts[i];
    if (!p) return;
    const shared = asked.filter((t) => p.asked.has(t.key) || p.headline.has(t.key) || p.title.has(t.key));
    if (shared.length === 0) return;
    const cover = shared.reduce((sum, t) => sum + weight(t.key), 0) / total;
    if (cover < WHOLE_COVER) return;
    // How much of the earlier question (with its passage) is in the new one.
    const earlier = [...p.asked].reduce((sum, key) => sum + weight(key), 0);
    const back = earlier > 0 ? asked.filter((t) => p.asked.has(t.key)).reduce((sum, t) => sum + weight(t.key), 0) / earlier : 0;
    // How much one part of the earlier exchange is about these words (weighted Dice).
    const focus = Math.max(
      ...[p.asked, p.headline, p.title].map((part) => {
        if (part.size === 0) return 0;
        const both = asked.filter((t) => part.has(t.key)).reduce((sum, t) => sum + weight(t.key), 0);
        const whole = [...part].reduce((sum, key) => sum + weight(key), 0);
        return (2 * both) / (total + whole);
      }),
    );
    const most = cover >= MIN_COVER && focus >= MIN_FOCUS;
    const whole = back >= WHOLE_BACK;
    if (!most && !whole) return;
    matches.push({
      id: c.id,
      threadId: c.threadId,
      score: Math.round(cover * focus * 1000) / 1000,
      strength: most && focus >= SAME_FOCUS ? 'same' : 'related',
      terms: [...new Set(shared.map((t) => t.shown))],
    });
  });
  matches.sort((a, b) => b.score - a.score);
  // One reminder per thread: its best exchange.
  const perThread = new Set<string>();
  return matches
    .filter((m) => (perThread.has(m.threadId) ? false : (perThread.add(m.threadId), true)))
    .slice(0, options.limit ?? 2);
}
