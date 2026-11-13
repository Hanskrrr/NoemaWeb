// What was sent, in words: what each part is (ContextView shows them). Pure, so it is tested in Node.

import type { SentPart } from '@noema/core';

const KIND_LABELS: Record<SentPart['kind'], string> = {
  instructions: 'Instructions to the AI',
  about_me: 'About you',
  source: 'What you are reading',
  pinned: 'Passages you pinned',
  inherited: 'From the thread this came from',
  history: 'Earlier in this thread',
  question: 'Your question',
  lookup: 'A lookup',
};

const TOOL_LABELS: Record<string, string> = { search: 'It searched', open: 'It opened', list: 'It listed' };

/** A lookup's arguments in a few words: the words searched for, the label opened, what was listed. */
export function lookupWhat(call: { name: string; arguments: string }): string {
  try {
    const args = JSON.parse(call.arguments) as { query?: unknown; ref?: unknown; page?: unknown; what?: unknown };
    if (typeof args.query === 'string') return `“${args.query}”`;
    if (args.ref !== undefined) return `[${String(args.ref)}]${args.page !== undefined ? `, page ${String(args.page)}` : ''}`;
    if (typeof args.what === 'string') return `the ${args.what}`;
  } catch {
    // shown as written
  }
  return call.arguments;
}

/** What a part is, in a few words. */
export function partLabel(p: SentPart): string {
  if (p.kind === 'inherited' || p.kind === 'history') {
    const turn = p.role === 'user' ? 'your question' : 'the answer';
    return `${KIND_LABELS[p.kind]} · ${turn}${p.merged > 0 ? ', with a merged thread' : ''}`;
  }
  if (p.kind === 'question') {
    const pictures = p.images?.length ?? 0;
    const extras = [
      p.withPassage ? 'the passage it is about' : '',
      pictures === 1 ? 'a picture of its page' : pictures > 1 ? `pictures of its ${pictures} pages` : '',
      p.merged > 0 ? 'a merged thread' : '',
    ].filter(Boolean);
    if (p.withOverview) extras.unshift('an overview of your notebook');
    return extras.length > 0 ? `${KIND_LABELS.question}, with ${extras.join(' and ')}` : KIND_LABELS.question;
  }
  if (p.kind === 'lookup' && p.call) return `${TOOL_LABELS[p.call.name] ?? `It used ${p.call.name}`} ${lookupWhat(p.call)}: what came back`;
  return KIND_LABELS[p.kind];
}
