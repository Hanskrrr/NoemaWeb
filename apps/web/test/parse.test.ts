import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codeRegion, type Leaf, leafToSource, leaves, parseMarkdown, sourceToLeaf } from '../src/markdown/parse.ts';

const SRC = [
  'Gradient **descent** takes $x_{t+1} = x_t - \\eta \\nabla f$ steps.',
  '',
  '- item with `inline code` here',
  '  and a continuation line',
  '',
  '```py',
  'def step(x):',
  '    return x - lr * grad(x)',
  '```',
  '',
  '> quoted line',
  '> second line',
  '',
  'escaped \\* star, &amp; entity, emoji 😀 end',
].join('\n');

const all = leaves(parseMarkdown(SRC), SRC);

function find(kind: Leaf['kind'], contains: string): Leaf {
  const leaf = all.find((l) => l.kind === kind && l.value.includes(contains));
  assert.ok(leaf, `no ${kind} leaf containing ${contains}`);
  return leaf;
}

function select(leaf: Leaf, part: string): string {
  const from = leaf.value.indexOf(part);
  const r = leafToSource(leaf.value, SRC.slice(leaf.start, leaf.end), leaf.start, from, from + part.length);
  assert.ok(r);
  return SRC.slice(r.start, r.end);
}

test('selecting plain text maps to the same characters in the raw Markdown', () => {
  assert.equal(select(find('text', 'Gradient'), 'Gradient'), 'Gradient');
  assert.equal(select(find('text', 'descent'), 'scen'), 'scen');
});

test('continuation lines and quote markers are skipped, not counted', () => {
  assert.equal(select(find('text', 'continuation'), 'continuation line'), 'continuation line');
  assert.equal(select(find('text', 'quoted'), 'second'), 'second');
  // A selection across the line break keeps the raw marker between: anchors are over the source.
  assert.equal(select(find('text', 'quoted'), 'line\nsecond'), 'line\n> second');
});

test('inline code and fenced code map inside their delimiters', () => {
  assert.equal(select(find('inlineCode', 'inline'), 'code'), 'code');
  const code = find('code', 'def step');
  assert.equal(SRC.slice(code.start, code.end), 'def step(x):\n    return x - lr * grad(x)');
  assert.equal(select(code, 'lr * grad'), 'lr * grad');
});

test('escapes and character references still land on the right characters', () => {
  assert.equal(select(find('text', 'escaped'), '* star'), '* star');
  assert.equal(select(find('text', 'escaped'), 'entity'), 'entity');
  assert.equal(select(find('text', 'emoji'), '😀'), '😀');
});

test('math is one atomic unit covering its delimiters', () => {
  const m = find('inlineMath', 'eta');
  assert.equal(m.atomic, true);
  assert.equal(SRC.slice(m.start, m.end), '$x_{t+1} = x_t - \\eta \\nabla f$');
});

test('raw ranges map back onto the rendered text (for highlighting)', () => {
  const leaf = find('text', 'continuation');
  const raw = SRC.slice(leaf.start, leaf.end);
  const at = SRC.indexOf('continuation');
  const back = sourceToLeaf(leaf.value, raw, leaf.start, at, at + 'continuation'.length);
  assert.deepEqual(back && leaf.value.slice(back.from, back.to), 'continuation');
  assert.equal(sourceToLeaf(leaf.value, raw, leaf.start, 0, 3), null);
});

test('round trip: every rendered span of every leaf maps to raw text and back', () => {
  for (const leaf of all.filter((l) => !l.atomic)) {
    const raw = SRC.slice(leaf.start, leaf.end);
    for (let from = 0; from < leaf.value.length; from += 3) {
      const to = Math.min(leaf.value.length, from + 5);
      const r = leafToSource(leaf.value, raw, leaf.start, from, to);
      assert.ok(r && r.start >= leaf.start && r.end <= leaf.end && r.start < r.end);
      const back = sourceToLeaf(leaf.value, raw, leaf.start, r.start, r.end);
      assert.ok(back && back.from <= from && back.to >= to, `${leaf.kind} ${from}-${to}`);
    }
  }
});

test('half-streamed Markdown still parses into sensible leaves', () => {
  const partial = 'Answer:\n\n```ts\nconst a = 1;\ncon';
  const code = leaves(parseMarkdown(partial), partial).find((l) => l.kind === 'code');
  assert.ok(code);
  assert.equal(partial.slice(code.start, code.end), 'const a = 1;\ncon');
  const openMath = 'Then $$\n\\frac{1}{';
  assert.doesNotThrow(() => leaves(parseMarkdown(openMath), openMath));
});

test('code regions for fences, empty blocks and indented code', () => {
  const s = '```\n```';
  assert.deepEqual(codeRegion(s, 0, s.length), { start: 4, end: 4 });
  const t = '~~~~\nx\n~~~~';
  const r = codeRegion(t, 0, t.length);
  assert.equal(t.slice(r.start, r.end), 'x');
  const i = '    indented';
  assert.deepEqual(codeRegion(i, 0, i.length), { start: 0, end: i.length });
});

test('tables: every cell maps back to its raw characters', () => {
  const md = 'Compare:\n\n| 方法 | Cost |\n|---|---:|\n| **SGD** | $O(n)$ |\n| a \\| b | `x` |\n';
  const tree = parseMarkdown(md);
  assert.equal(tree.children[1]?.type, 'table');
  const cells = leaves(tree, md);
  const raw = (l: Leaf) => md.slice(l.start, l.end);
  assert.deepEqual(
    cells.map((l) => [l.kind, l.value]),
    [
      ['text', 'Compare:'],
      ['text', '方法'],
      ['text', 'Cost'],
      ['text', 'SGD'],
      ['inlineMath', 'O(n)'],
      ['text', 'a | b'],
      ['inlineCode', 'x'],
    ],
  );
  const escaped = cells[5] as Leaf;
  assert.equal(raw(escaped), 'a \\| b');
  const r = leafToSource(escaped.value, raw(escaped), escaped.start, 2, 3);
  assert.equal(r && md.slice(r.start, r.end), '|');
});

test('single tildes stay text (Chinese ranges like 3~5); double tildes strike through', () => {
  const md = '大约 3~5 天，或者 4~6 天。~~old~~';
  const tree = parseMarkdown(md);
  const para = tree.children[0];
  assert.equal(para?.type, 'paragraph');
  const types = para && 'children' in para ? para.children.map((c) => c.type) : [];
  assert.deepEqual(types, ['text', 'delete']);
});

test('task lists and footnotes parse', () => {
  const md = '- [x] done\n- [ ] todo\n\nSee note[^1].\n\n[^1]: The note.\n';
  const tree = parseMarkdown(md);
  const list = tree.children[0];
  assert.ok(list?.type === 'list');
  assert.deepEqual(
    list.children.map((i) => i.checked),
    [true, false],
  );
  assert.ok(tree.children.some((n) => n.type === 'footnoteDefinition'));
});
