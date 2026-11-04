// Search text for SQLite FTS5 with the unicode61 tokenizer.
//
// unicode61 splits on spaces and punctuation, which works for English but
// treats a whole run of Chinese or Japanese as one token, so "学习" would not
// match inside "机器学习". FTS5's trigram tokenizer fixes that but cannot match
// queries shorter than three characters, which is most CJK words.
//
// So before indexing and before querying we rewrite CJK runs into unigrams
// and overlapping bigrams: "机器学习" -> "机 器 学 习 机器 器学 学习".
// A query of one CJK character matches a unigram; longer CJK queries become
// an AND of their bigrams. Everything else passes through to unicode61.
// The FTS table stores only this rewritten text; snippets are cut from the
// original text with makeSnippet().

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// A run of CJK characters, or a run of other letters and digits.
const RUN =
  /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+)|((?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}])+)/gu;

function bigrams(chars: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i++) out.push((chars[i] as string) + (chars[i + 1] as string));
  return out;
}

/** Text to store in the FTS index. */
export function searchText(input: string): string {
  const parts: string[] = [];
  for (const m of input.normalize('NFKC').matchAll(RUN)) {
    if (m[1]) {
      const chars = Array.from(m[1]);
      parts.push(...chars, ...bigrams(chars));
    } else if (m[2]) {
      parts.push(m[2]);
    }
  }
  return parts.join(' ');
}

export interface ParsedQuery {
  /** Tokens the FTS row must contain (AND). */
  tokens: string[];
  /** The user's words, for snippets and highlighting. */
  terms: string[];
}

export function parseQuery(input: string): ParsedQuery {
  const tokens: string[] = [];
  const terms: string[] = [];
  for (const m of input.normalize('NFKC').matchAll(RUN)) {
    if (m[1]) {
      const chars = Array.from(m[1]);
      terms.push(m[1]);
      tokens.push(...(chars.length === 1 ? chars : bigrams(chars)));
    } else if (m[2]) {
      terms.push(m[2]);
      tokens.push(m[2]);
    }
  }
  return { tokens: [...new Set(tokens)], terms };
}

/**
 * An FTS5 MATCH expression, or null when the query has nothing searchable.
 * Every token is quoted, so user input can never inject FTS syntax. The last
 * non-CJK token is a prefix match, so results appear while typing.
 */
export function ftsQuery(input: string): string | null {
  const { tokens } = parseQuery(input);
  if (tokens.length === 0) return null;
  return tokens
    .map((t, i) => {
      const quoted = `"${t.replaceAll('"', '""')}"`;
      return i === tokens.length - 1 && !CJK_CHAR.test(t) ? `${quoted}*` : quoted;
    })
    .join(' AND ');
}

export interface Snippet {
  text: string;
  /** Match ranges inside `text`, for highlighting. */
  matches: Array<{ start: number; end: number }>;
}

/** A short window of the original text around the first match of any term. */
export function makeSnippet(original: string, query: string, radius = 60): Snippet {
  const { terms } = parseQuery(query);
  const lower = original.toLowerCase();
  let first = -1;
  let firstLen = 0;
  for (const term of terms) {
    const i = lower.indexOf(term.toLowerCase());
    if (i !== -1 && (first === -1 || i < first)) {
      first = i;
      firstLen = term.length;
    }
  }
  const from = first === -1 ? 0 : Math.max(0, first - radius);
  const to = Math.min(original.length, first === -1 ? radius * 2 : first + firstLen + radius);
  const lead = from > 0 ? '…' : '';
  const tail = to < original.length ? '…' : '';
  const body = original.slice(from, to).replace(/\s+/g, ' ');
  const text = lead + body + tail;
  const matches: Array<{ start: number; end: number }> = [];
  const textLower = text.toLowerCase();
  for (const term of terms) {
    const t = term.toLowerCase();
    let i = textLower.indexOf(t);
    while (i !== -1) {
      matches.push({ start: i, end: i + t.length });
      i = textLower.indexOf(t, i + t.length);
    }
  }
  matches.sort((a, b) => a.start - b.start);
  return { text, matches };
}
