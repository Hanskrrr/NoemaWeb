// Context assembly: which text goes to the model, in what order, and a record
// of what was left out.
//
// Order matters for cost. DeepSeek (and most OpenAI-compatible providers)
// cache identical prompt prefixes automatically, so the stable parts go first:
// system prompt, then About me, then history oldest-to-newest, then the new
// question. When the budget is tight the oldest history goes first, never the
// question and never About me. The manifest is stored with every model call
// so "what did the model see?" always has an answer.

export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface HistoryItem {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface ContextInput {
  system: string;
  aboutMe?: string;
  /** For a branch: the visible conversation of its ancestors up to where it left. */
  inherited?: HistoryItem[];
  /** For a branch: the passage it was asked about. Attached to every question in the branch. */
  origin?: { quote: string };
  history: HistoryItem[];
  question: { id: string; content: string };
  /** Prompt budget in tokens, excluding the room kept for the answer. */
  budgetTokens: number;
}

export type ManifestPart =
  | { kind: 'system'; tokens: number }
  | { kind: 'about_me'; tokens: number }
  | { kind: 'inherited'; id: string; role: 'user' | 'assistant'; tokens: number }
  | { kind: 'history'; id: string; role: 'user' | 'assistant'; tokens: number }
  | { kind: 'origin'; tokens: number }
  | { kind: 'question'; id: string; tokens: number };

export interface ContextManifest {
  parts: ManifestPart[];
  omitted: Array<{ id: string; tokens: number; reason: 'budget' }>;
  estimatedTokens: number;
  budgetTokens: number;
}

export interface AssembledContext {
  messages: ChatMessage[];
  manifest: ContextManifest;
}

export class ContextBudgetError extends Error {
  readonly kind = 'context_too_large';
  readonly neededTokens: number;
  readonly budgetTokens: number;
  constructor(neededTokens: number, budgetTokens: number) {
    super(`the question and fixed context need about ${neededTokens} tokens; the budget is ${budgetTokens}`);
    this.name = 'ContextBudgetError';
    this.neededTokens = neededTokens;
    this.budgetTokens = budgetTokens;
  }
}

const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/g;
const PER_MESSAGE_OVERHEAD = 4;

/**
 * A deliberately cautious estimate: about 0.6 tokens per CJK character and
 * 0.3 per other character (DeepSeek's published rule of thumb), plus a few
 * tokens per message. Real counts come back in the provider's usage report.
 */
export function estimateTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const other = text.length - cjk;
  return Math.ceil(cjk * 0.6 + other * 0.3) + PER_MESSAGE_OVERHEAD;
}

/** Longest origin quote sent to the model; the full quote stays in the anchor. */
export const MAX_ORIGIN_CHARS = 4000;

/** The passage a branch was asked about, as it is put in front of each question in the branch. */
export function formatOrigin(quote: string): string {
  const chars = Array.from(quote.trim());
  const text = chars.length > MAX_ORIGIN_CHARS ? `${chars.slice(0, MAX_ORIGIN_CHARS).join('')}…` : chars.join('');
  const quoted = text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
  return `About this passage from earlier in the conversation:\n\n${quoted}`;
}

export function assembleContext(input: ContextInput): AssembledContext {
  const aboutMe = input.aboutMe?.trim();
  const systemContent = aboutMe ? `${input.system}\n\n## About the learner\n${aboutMe}` : input.system;
  const systemTokens = estimateTokens(input.system);
  const aboutTokens = aboutMe ? estimateTokens(systemContent) - systemTokens : 0;
  const originText = input.origin ? formatOrigin(input.origin.quote) : null;
  const originTokens = originText ? estimateTokens(originText) : 0;
  const questionTokens = estimateTokens(input.question.content);
  const fixed = systemTokens + aboutTokens + originTokens + questionTokens;
  if (fixed > input.budgetTokens) throw new ContextBudgetError(fixed, input.budgetTokens);

  // Inherited turns come first, then the thread's own; walk newest to oldest, keeping what fits.
  type Turn = HistoryItem & { tokens: number; inherited: boolean };
  const all: Array<HistoryItem & { inherited: boolean }> = [
    ...(input.inherited ?? []).map((h) => ({ ...h, inherited: true })),
    ...input.history.map((h) => ({ ...h, inherited: false })),
  ];
  let used = fixed;
  const kept: Turn[] = [];
  const omitted: ContextManifest['omitted'] = [];
  let full = false;
  for (let i = all.length - 1; i >= 0; i--) {
    const item = all[i] as HistoryItem & { inherited: boolean };
    const tokens = estimateTokens(item.content);
    if (!full && used + tokens <= input.budgetTokens) {
      kept.unshift({ ...item, tokens });
      used += tokens;
    } else {
      full = true; // once something is dropped, drop everything older: no gaps
      omitted.unshift({ id: item.id, tokens, reason: 'budget' });
    }
  }
  // History must not open with an assistant turn that lost its question.
  while (kept[0]?.role === 'assistant') {
    const orphan = kept.shift() as Turn;
    used -= orphan.tokens;
    omitted.push({ id: orphan.id, tokens: orphan.tokens, reason: 'budget' });
  }

  // The origin goes with the question, not before the history, so the
  // history prefix stays identical across a branch's turns (prompt cache).
  const question = originText ? `${originText}\n\n${input.question.content}` : input.question.content;
  const messages: ChatMessage[] = [
    { role: 'system', content: systemContent },
    ...kept.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: question },
  ];
  const parts: ManifestPart[] = [{ kind: 'system', tokens: systemTokens }];
  if (aboutMe) parts.push({ kind: 'about_me', tokens: aboutTokens });
  for (const h of kept) {
    parts.push({ kind: h.inherited ? 'inherited' : 'history', id: h.id, role: h.role, tokens: h.tokens });
  }
  if (originText) parts.push({ kind: 'origin', tokens: originTokens });
  parts.push({ kind: 'question', id: input.question.id, tokens: questionTokens });

  return { messages, manifest: { parts, omitted, estimatedTokens: used, budgetTokens: input.budgetTokens } };
}
