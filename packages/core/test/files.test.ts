import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanFilePath, fileMarkdown, fileName, isMarkdownFile, noteFile } from '../src/index.ts';

test('a Markdown file is read as it is; any other text as one code block in its language', () => {
  assert.equal(fileMarkdown('notes/week4.md', '# Week 4\r\n\r\nText.'), '# Week 4\n\nText.');
  assert.equal(fileMarkdown('src/a.py', 'print(1)\n'), '```python\nprint(1)\n```');
  assert.equal(fileMarkdown('README', 'plain'), '```\nplain\n```');
  // A fence longer than any run of backticks inside.
  assert.equal(fileMarkdown('x.ts', 'const s = ```x```;'), '````ts\nconst s = ```x```;\n````');
  assert.equal(isMarkdownFile('A.MD'), true);
  assert.equal(fileName('a/b/c.pdf'), 'c.pdf');
});

test('a path inside a folder: parts with /, never leaving it', () => {
  assert.equal(cleanFilePath('Week 4/slides.pdf'), 'Week 4/slides.pdf');
  assert.equal(cleanFilePath('/a//b/./c.md'), 'a/b/c.md');
  assert.equal(cleanFilePath('a\\b.txt'), 'a/b.txt');
  assert.equal(cleanFilePath('../secret'), null);
  assert.equal(cleanFilePath('a/../../b'), null);
  assert.equal(cleanFilePath(''), null);
});

test('a note as a Markdown file: its title, its blocks, no citation labels', () => {
  assert.equal(noteFile('Attention', ['The scale is √d [E2].', '- point [E1][E3]']), '# Attention\n\nThe scale is √d.\n\n- point\n');
  assert.equal(noteFile('X', ['# Own heading', 'Body']), '# Own heading\n\nBody\n');
});
