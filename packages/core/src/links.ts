// The kinds of link between two things of a notebook (ADR 0027), read from one end: "A explains B".

export const LINK_KINDS = ['explains', 'example-of', 'builds-on', 'contrasts-with', 'same-question', 'part-of', 'related'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** A link read from one end to the other: "A explains B". */
export const LINK_WORDS: Record<LinkKind, string> = {
  explains: 'explains',
  'example-of': 'is an example of',
  'builds-on': 'builds on',
  'contrasts-with': 'contrasts with',
  'same-question': 'asks the same as',
  'part-of': 'is part of',
  related: 'is related to',
};
