import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  becomesConcept,
  bestMention,
  CONCEPT_SKILL,
  commonName,
  conceptKey,
  conceptLinksRequest,
  findRequest,
  joinRequest,
  knownTree,
  type MentionRole,
  type OrderConcept,
  orderRequest,
  pageAt,
  pagesOf,
  readFind,
  readOrder,
  readScope,
  scopeRequest,
  wordsFound,
  workWeight,
  pieceHashInput,
  pieceRequest,
  piecesOf,
  readConceptLinks,
  readJoin,
  readMentions,
  SKILL_VERSION,
  targetAt,
} from '../src/concepts.ts';
import type { ItemText } from '../src/gists.ts';

// The concept-reading skill (ADR 0037): pieces cut the same way every time,
// mentions only where the words are, names made plain, new names judged,
// links read. Made-up text.

const thread = (messages: string[]): ItemText => {
  let text = '';
  const segments: ItemText['segments'] = [];
  messages.forEach((m, i) => {
    if (text) text += '\n\n';
    segments.push({ start: text.length, end: text.length + m.length, target: { kind: 'thread', threadId: 't1', messageId: `m${i}`, title: 'Glow' } });
    text += m;
  });
  return { kind: 'thread', title: 'Glow', text, segments };
};
const source = (text: string): ItemText => ({
  kind: 'source',
  title: 'Moss',
  text,
  segments: [{ start: 0, end: text.length, target: { kind: 'source', sourceId: 's1', versionId: 'v1', at: 0, title: 'Moss' } }],
});

test("a thread's pieces pack its messages in order; a new question changes only the last piece", () => {
  const a = 'Q: Why does the glowfin glow? '.padEnd(60, '.');
  const b = 'A: Its scales hold luciferin. '.padEnd(60, '.');
  const before = piecesOf(thread([a, b, a, b]), 130);
  assert.deepEqual(
    before.map((p) => [p.start, p.end]),
    [
      [0, 122],
      [124, 246],
    ],
  );
  assert.equal(before[0]?.text, `${a}\n\n${b}`);
  const after = piecesOf(thread([a, b, a, b, a]), 130);
  assert.deepEqual(after[0], before[0], 'the first piece is the same');
  assert.equal(after.length, 3);
});

test("a source's pieces are cut where headings start, packed; an edit in one section leaves the others' pieces as they were", () => {
  const sec = (h: string, n: number) => `## ${h}\n\n${'Moss keeps the den warm. '.repeat(n)}\n\n`;
  const text = sec('Page 1', 3) + sec('Page 2', 3) + sec('Page 3', 3) + sec('Page 4', 3);
  const pieces = piecesOf(source(text), 200);
  // Two sections (about 90 characters each) to a piece.
  assert.equal(pieces.length, 2);
  assert.ok(pieces.every((p) => p.text.startsWith('## Page')));
  const edited = sec('Page 1', 3) + sec('Page 2', 3) + sec('Page 3', 3).replace('den', 'nest') + sec('Page 4', 3);
  const again = piecesOf(source(edited), 200);
  assert.equal(again[0]?.text, pieces[0]?.text);
  assert.notEqual(again[1]?.text, pieces[1]?.text);
  // A section longer than a piece is cut at its paragraphs, then at a space.
  const long = `## Long\n\n${'word '.repeat(30)}\n\n${'word '.repeat(30)}`;
  const cut = piecesOf(source(long), 100);
  assert.ok(cut.length >= 3);
  assert.ok(cut.every((p) => p.end - p.start <= 100));
  assert.equal(cut.map((p) => p.text).join('').replace(/\s/g, ''), long.replace(/\s/g, ''));
  // Nothing but white space: no piece.
  assert.deepEqual(piecesOf(source('  \n\n  ')), []);
});

test('a piece hashes its words with the skill version; a place in the text is a message, a block or the source from an offset', () => {
  assert.equal(pieceHashInput('Moss.'), `noema-concept-reading/${SKILL_VERSION}\nMoss.`);
  const t = thread(['Q: one', 'A: two words']);
  assert.deepEqual(targetAt(t, 10, 'two'), { kind: 'thread', threadId: 't1', messageId: 'm1', title: 'Glow', quote: 'two' });
  const s = source('# Moss\n\nMoss keeps it warm.');
  assert.deepEqual(targetAt(s, 8, 'Moss keeps'), { kind: 'source', sourceId: 's1', versionId: 'v1', at: 8, title: 'Moss', quote: 'Moss keeps' });
  assert.equal(targetAt(t, 999, 'x'), null);
});

test('names made plain: case, hyphens, quotes, a leading "the", plurals', () => {
  assert.equal(conceptKey('Gradient-Checkpointing'), 'gradient checkpointing');
  assert.equal(conceptKey('the vanishing gradients problem'), 'vanishing gradient problem');
  assert.equal(conceptKey('  “Attention”  '), 'attention');
  assert.equal(conceptKey('Transformers'), 'transformer');
  assert.equal(conceptKey('Loss'), 'loss');
  assert.equal(conceptKey('Analysis'), 'analysis');
  assert.equal(conceptKey('Dynamics'), 'dynamics');
  assert.equal(conceptKey('Activation memories'), 'activation memory');
  assert.equal(conceptKey('ZeRO'), 'zero');
});

test("a piece's request carries the skill, the material and the known concepts as a tree", () => {
  const known = [{ name: 'Winter' }, { name: 'moss blanket', under: 'Winter' }, { name: 'den', under: 'Winter' }, { name: 'deep den', under: 'den' }, { name: 'ice' }];
  const [system, user] = pieceRequest({ kind: 'thread', title: 'Moss' }, 'Moss keeps it warm.', { n: 2, of: 3 }, known);
  assert.equal(system?.content, CONCEPT_SKILL);
  assert.equal(
    user?.content,
    'A thread of questions and answers, “Moss”, piece 2 of 3:\n\n<<<\nMoss keeps it warm.\n>>>\n\nKnown concepts: \n- Winter\n  - moss blanket\n  - den\n    - deep den\n- ice',
  );
  assert.match(pieceRequest({ kind: 'note', title: '' }, 'x', { n: 1, of: 1 }, [])[1]?.content ?? '', /^A note, “Untitled”:\n[\s\S]*Known concepts: none yet\.$/);
  // At most so many names: the tops first, then a level down.
  assert.equal(knownTree(known, 3), '- Winter\n  - moss blanket\n- ice');
  // What is under something not known is at the top; nothing is under itself.
  assert.equal(knownTree([{ name: 'a', under: 'zz' }, { name: 'b', under: 'b' }]), '- a\n- b');
});

test('a mention says what it is under only when the piece says so; details are not concepts', () => {
  assert.match(CONCEPT_SKILL, /Details are not concepts/);
  const piece = 'AdamW, a variant of Adam, decays the weights apart.';
  const m = readMentions(
    JSON.stringify({
      mentions: [
        { name: 'AdamW', role: 'defines', quote: 'AdamW, a variant of Adam, decays the weights apart.', under: 'Adam', how: 'kind-of' },
        { name: 'Adam', role: 'uses', quote: 'AdamW, a variant of Adam, decays the weights apart.', under: 'Adam', how: 'kind-of' },
        { name: 'decay', role: 'uses', quote: 'decays the weights apart', under: 'AdamW', how: 'sort-of' },
      ],
    }),
    piece,
  );
  assert.deepEqual(
    m?.map((x) => [x.name, x.under, x.how]),
    [
      ['AdamW', 'Adam', 'kind-of'],
      ['Adam', null, null],
      ['decay', null, null],
    ],
  );
});

test('mentions are kept only where their words are in the piece; three places of a concept at most; roles and names checked', () => {
  const piece = 'A moss blanket keeps the glowfin warm.\n\nThe moss blanket is woven, the den is dug. Why is the den so deep?';
  const raw = `Here: ${JSON.stringify({
    mentions: [
      { name: 'Moss Blanket', also: ['MB', 'moss-blanket'], role: 'defines', quote: 'A moss  blanket keeps the glowfin warm.', says: 'It keeps it warm.' },
      { name: 'moss blanket', role: 'uses', quote: 'The moss blanket is woven,' },
      { name: 'moss blanket', role: 'uses', quote: 'The moss blanket is woven,' },
      { name: 'den', role: 'asks', quote: 'Why is the den so deep?' },
      { name: 'den', role: 'shouts', quote: 'the den is dug' },
      { name: 'ice', role: 'uses', quote: 'Ice is cold.' },
      { name: '', role: 'uses', quote: 'the den is dug' },
    ],
  })}`;
  const m = readMentions(raw, piece);
  assert.deepEqual(
    m?.map((x) => [x.key, x.role, x.quote, x.offset, x.also]),
    [
      ['moss blanket', 'defines', 'A moss blanket keeps the glowfin warm.', 0, ['MB']],
      ['moss blanket', 'uses', 'The moss blanket is woven,', 40, []],
      ['den', 'asks', 'Why is the den so deep?', piece.indexOf('Why'), []],
    ],
  );
  assert.equal(m?.[0]?.says, 'It keeps it warm.');
  assert.equal(readMentions('no json', piece), null);
  assert.deepEqual(readMentions('{"mentions": []}', piece), []);
  // A thread's "Q: " is the reading's label, not the learner's words: the quote starts after it.
  const thread = 'Q: Why is the den so deep?\n\nA: The den is deep to stay warm.';
  const t = readMentions(JSON.stringify({ mentions: [{ name: 'den', role: 'asks', quote: 'Q: Why is the den so deep?' }, { name: 'den', role: 'explains', quote: 'The den is deep to stay warm.' }] }), thread);
  assert.deepEqual(
    t?.map((x) => [x.quote, x.offset]),
    [
      ['Why is the den so deep?', 3],
      ['The den is deep to stay warm.', thread.indexOf('The den')],
    ],
  );
});

test('the judge: each new name the same as a known one, or new; answers about names not asked are ignored', () => {
  const [, user] = joinRequest(['activation checkpointing'], ['gradient checkpointing', 'attention']);
  assert.equal(user?.content, 'Known concepts:\n- gradient checkpointing\n- attention\n\nNew names:\n- activation checkpointing');
  const r = readJoin(
    JSON.stringify({
      same: { 'Activation Checkpointing': 'Gradient checkpointing', moss: null, other: 'attention', gc: 'not known', 'moss blanket': 'moss', den: 'den' },
    }),
    ['activation checkpointing', 'moss', 'gc', 'moss blanket', 'den'],
    ['gradient checkpointing', 'attention'],
  );
  assert.deepEqual(
    [...(r ?? [])],
    [
      ['activation checkpointing', 'gradient checkpointing'],
      ['moss', null],
      ['gc', null],
      // The same as another new name; never as itself.
      ['moss blanket', 'moss'],
      ['den', null],
    ],
  );
  assert.equal(readJoin('nothing', [], []), null);
});

test('a name becomes a concept when a material defines or explains it, or two materials discuss it', () => {
  const m = (role: MentionRole, material: string) => ({ role, material });
  assert.equal(becomesConcept([m('uses', 'a')]), false);
  assert.equal(becomesConcept([m('uses', 'a'), m('asks', 'a')]), false);
  assert.equal(becomesConcept([m('explains', 'a')]), true);
  assert.equal(becomesConcept([m('uses', 'a'), m('uses', 'b')]), true);
  const best = bestMention([
    { role: 'uses' as MentionRole, at: '1' },
    { role: 'explains' as MentionRole, at: '3' },
    { role: 'explains' as MentionRole, at: '2' },
  ]);
  assert.deepEqual(best, { role: 'explains', at: '2' });
  assert.equal(commonName([{ name: 'GC' }, { name: 'gradient checkpointing' }, { name: 'gradient checkpointing' }]), 'gradient checkpointing');
});

test('links between concepts: kinds concepts use, a pair once, none between two kept ones', () => {
  const [, user] = conceptLinksRequest('Glowfin', [
    { name: 'moss blanket', says: ['It keeps it warm.'] },
    { name: 'den', says: [] },
  ]);
  assert.equal(user?.content, 'The subject “Glowfin”:\n1. moss blanket: It keeps it warm.\n2. den');
  const raw = JSON.stringify({
    links: [
      { from: 2, to: 1, kind: 'builds-on', why: 'Needs it.' },
      { from: 1, to: 2, kind: 'part-of' },
      { from: 3, to: 1, kind: 'builds-on' },
      { from: 1, to: 3, kind: 'related' },
      { from: 3, to: 4, kind: 'builds-on' },
    ],
  });
  assert.deepEqual(readConceptLinks(raw, 4, new Set([3, 4])), [
    { from: 2, to: 1, kind: 'builds-on', why: 'Needs it.' },
    { from: 3, to: 1, kind: 'builds-on', why: '' },
  ]);
  assert.equal(readConceptLinks('{}', 2), null);
});

test('putting a room in order: places for concepts without one, under a concept of the list or a topic; no circles', () => {
  const concepts: OrderConcept[] = [
    { name: 'Adam', says: ['Keeps two moments.'], materials: 2, work: 5, home: null },
    { name: 'AdamW', says: [], materials: 1, work: 1, home: null },
    { name: 'SGD', says: [], materials: 1, work: 3, home: 'Optimization' },
    { name: 'momentum', says: [], materials: 1, work: 1, home: null },
    { name: 'activations', says: [], materials: 1, work: 1, home: null },
  ];
  const [, user] = orderRequest({ title: 'Training' }, concepts, ['Optimization']);
  assert.match(user?.content ?? '', /^The room “Training”\. Its concepts:\n1\. Adam: Keeps two moments\. · 2 materials · work 5\n2\. AdamW · 1 material · work 1\n3\. SGD · 1 material · work 3 · in Optimization\n/);
  assert.match(user?.content ?? '', /Topics the notebook has: “Optimization”\.$/);
  const raw = JSON.stringify({
    topics: [
      { name: 'Training memory', says: 'What a model keeps while it trains.' },
      { name: 'Unused', says: 'Nothing goes here.' },
      { name: 'adam', says: 'A concept, not a topic.' },
    ],
    places: [
      { n: 1, under: 'optimization', how: 'in' },
      { n: 2, under: 'Adam', how: 'kind-of' },
      { n: 3, under: 'Training memory', how: 'in' },
      { n: 4, under: 2, how: 'part-of' },
      { n: 5, under: 'Training memory', how: 'in' },
      { n: 1, under: 'Training memory', how: 'in' },
      { n: 9, under: 'Optimization', how: 'in' },
      { n: 5, under: 'Nowhere', how: 'in' },
    ],
  });
  const order = readOrder(raw, concepts, ['Optimization']);
  // New topics as the reply gave them, then those the notebook had; one nothing went in is not made.
  assert.deepEqual(order?.topics, [
    { name: 'Training memory', says: 'What a model keeps while it trains.' },
    { name: 'Optimization', says: '' },
  ]);
  assert.deepEqual(order?.places, [
    { n: 1, under: { topic: 'Optimization' }, how: 'in' },
    { n: 2, under: { concept: 1 }, how: 'kind-of' },
    { n: 4, under: { concept: 2 }, how: 'part-of' },
    { n: 5, under: { topic: 'Training memory' }, how: 'in' },
  ]);
  // A place that would go round: Adam under AdamW, when AdamW is under Adam.
  const circle = readOrder(
    JSON.stringify({ places: [{ n: 2, under: 'Adam', how: 'kind-of' }, { n: 1, under: 'AdamW', how: 'kind-of' }] }),
    concepts,
    [],
  );
  assert.deepEqual(circle?.places, [{ n: 2, under: { concept: 1 }, how: 'kind-of' }]);
  assert.equal(readOrder('nothing', concepts, []), null);
});

test("a concept's scope is one plain line", () => {
  const [, user] = scopeRequest({ name: 'Optimizers', also: ['optimiser'], says: ['They update the weights.'] });
  assert.equal(user?.content, 'The concept “Optimizers”, also called “optimiser”.\nWhat the learner\'s materials say of it:\n- They update the weights.');
  assert.equal(readScope('  “Methods that update the weights: SGD, Adam.”\n'), 'Methods that update the weights: SGD, Adam.');
});

test('filling a concept: concepts inside it, and materials whose words are in what was given', () => {
  const materials = [
    { kind: 'thread' as const, title: 'Why Adam', snippets: ['Adam keeps two moments of the gradient.', 'It scales each step.'] },
    { kind: 'note' as const, title: 'Week 3', snippets: ['SGD with momentum smooths the steps.'] },
  ];
  const [, user] = findRequest({ name: 'Optimizers', also: [], scope: 'Methods that update the weights.' }, [{ name: 'Adam', says: ['Two moments.'] }, { name: 'dropout', says: [] }], materials);
  assert.match(user?.content ?? '', /^The concept “Optimizers”\. It covers: Methods that update the weights\.\n\nConcepts:\nC1\. Adam: Two moments\.\nC2\. dropout\n\nMaterials:\nM1\. A thread of questions and answers, “Why Adam”:\n<<<\nAdam keeps two moments of the gradient\.\n>>>/);
  const found = readFind(
    JSON.stringify({
      inside: [{ c: 'C1', how: 'kind-of' }, { c: 7 }, { c: 1 }],
      materials: [
        { m: 'M1', quote: 'It scales  each step.', says: 'Adam scales steps.' },
        { m: 2, quote: 'Words that are not there.' },
        { m: 2, quote: 'SGD with momentum smooths the steps.' },
        { m: 1, quote: 'Adam keeps two moments of the gradient.' },
      ],
    }),
    2,
    materials,
  );
  assert.deepEqual(found?.inside, [{ c: 1, how: 'kind-of' }]);
  assert.deepEqual(
    found?.materials.map((f) => [f.m, f.snippet, f.quote, f.says]),
    [
      [1, 1, 'It scales each step.', 'Adam scales steps.'],
      [2, 0, 'SGD with momentum smooths the steps.', ''],
    ],
  );
  assert.equal(readFind('no', 1, materials), null);
});

test("words found in a source: a concept's names, whole, any case, plurals; pages of a PDF", () => {
  const text = '## Page 1\n\nGradient checkpointing saves memory.\n\n## Page 2\n\nCheckpointing again; the gradients flow. A checkpointer is not it. GC too.';
  const found = wordsFound(text, ['gradient checkpointing', 'checkpointing', 'GC', 'x']).map((r) => text.slice(r.start, r.end));
  assert.deepEqual(found, ['Gradient checkpointing', 'Checkpointing', 'GC']);
  assert.deepEqual(
    wordsFound(text, ['gradient']).map((r) => text.slice(r.start, r.end)),
    ['Gradient', 'gradients'],
  );
  assert.deepEqual(wordsFound(text, []), []);
  const pages = pagesOf(text);
  assert.deepEqual(pages.map((p) => p.page), [1, 2]);
  assert.equal(pageAt(pages, text.indexOf('saves')), 1);
  assert.equal(pageAt(pages, text.indexOf('GC')), 2);
  assert.equal(pageAt(pagesOf('no pages'), 3), null);
});

test("a concept's size is the learner's work on it: questions most, then notes, then materials", () => {
  assert.equal(workWeight({ questions: 2, notes: 1, materials: 3 }), 11);
  assert.equal(workWeight({ questions: 0, notes: 0, materials: 1 }), 1);
});
