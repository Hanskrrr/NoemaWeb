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
  history: HistoryItem[];
  question: { id: string; content: string };
  /** Prompt budget in tokens, excluding the room kept for the answer. */
  budgetTokens: number;
}

export type ManifestPart =
  | { kind: 'system'; tokens: number }
  | { kind: 'about_me'; tokens: number }
  | { kind: 'history'; id: string; role: 'user' | 'assistant'; tokens: number }
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

export function assembleContext(input: ContextInput): AssembledContext {
  const aboutMe = input.aboutMe?.trim();
  const systemContent = aboutMe ? `${input.system}\n\n## About the learner\n${aboutMe}` : input.system;
  const systemTokens = estimateTokens(input.system);
  const aboutTokens = aboutMe ? estimateTokens(systemContent) - systemTokens : 0;
  const questionTokens = estimateTokens(input.question.content);
  const fixed = systemTokens + aboutTokens + questionTokens;
  if (fixed > input.budgetTokens) throw new ContextBudgetError(fixed, input.budgetTokens);

  // Walk history newest to oldest, keeping what fits.
  let used = fixed;
  const kept: Array<HistoryItem & { tokens: number }> = [];
  const omitted: ContextManifest['omitted'] = [];
  let full = false;
  for (let i = input.history.length - 1; i >= 0; i--) {
    const item = input.history[i] as HistoryItem;
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
    const orphan = kept.shift() as HistoryItem & { tokens: number };
    used -= orphan.tokens;
    omitted.push({ id: orphan.id, tokens: orphan.tokens, reason: 'budget' });
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: systemContent },
    ...kept.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: input.question.content },
  ];
  const parts: ManifestPart[] = [{ kind: 'system', tokens: systemTokens }];
  if (aboutMe) parts.push({ kind: 'about_me', tokens: aboutTokens });
  for (const h of kept) parts.push({ kind: 'history', id: h.id, role: h.role, tokens: h.tokens });
  parts.push({ kind: 'question', id: input.question.id, tokens: questionTokens });

  return { messages, manifest: { parts, omitted, estimatedTokens: used, budgetTokens: input.budgetTokens } };
}
