import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demoteHeadings, notebookMarkdown } from '../src/readable.ts';

test('headings move down, but not inside code or math, and never past level 6', () => {
  const md = ['# Top', 'text # not a heading', '```py', '# a comment', '```', '$$', '# x', '$$', '#### Deep', '#NoSpace'].join(
    '\n',
  );
  assert.equal(
    demoteHeadings(md, 3),
    ['#### Top', 'text # not a heading', '```py', '# a comment', '```', '$$', '# x', '$$', '###### Deep', '#NoSpace'].join(
      '\n',
    ),
  );
});

test('a notebook reads in order: about you, notes with their citations, threads with side questions under them, sources', () => {
  const md = notebookMarkdown({
    title: 'Linear algebra',
    aboutMe: 'I know basic calculus.',
    exportedAt: '2026-11-07T10:00:00.000Z',
    notes: [
      {
        title: 'Eigenvalues',
        blocks: ['# Definition', 'An eigenvector keeps its direction [E1].'],
        cites: [{ label: 'E1', thread: 'What is an eigenvector', question: 'What is an eigenvector?' }],
      },
    ],
    threads: [
      {
        id: 'b',
        title: 'Why direction',
        createdAt: '2026-11-02',
        parentId: 'a',
        from: { quote: 'keeps its direction', in: 'an answer' },
        turns: [
          { role: 'user', content: 'Why direction?' },
          { role: 'assistant', content: 'Because scaling.' },
        ],
      },
      {
        id: 'a',
        title: 'What is an eigenvector',
        createdAt: '2026-11-01',
        parentId: null,
        turns: [
          { role: 'user', content: 'What is an eigenvector?' },
          { role: 'assistant', content: '## In short\nA vector that keeps its direction.' },
        ],
      },
    ],
    sources: [{ title: 'Notes on matrices', url: 'https://example.org/m' }, { title: 'Pasted', url: null }],
  });
  const order = ['# Linear algebra', '## About you', '## Notes', '### Eigenvalues', '#### Definition', '- [E1]', '## Threads', '### What is an eigenvector', '###### In short', '#### ↳ Why direction', '> keeps its direction', '**You asked:** Why direction?', '## Sources', '[Notes on matrices](https://example.org/m)', '- Pasted'];
  let at = -1;
  for (const part of order) {
    const i = md.indexOf(part, at + 1);
    assert.ok(i > at, `${part} comes next`);
    at = i;
  }
});
