import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cleanPdfText,
  EMPTY_PAGE,
  escapePdfText,
  MAX_PDF_CHARS,
  type PdfPageText,
  type PdfTextItem,
  pageHeading,
  pageOfHeading,
  pdfToMarkdown,
  sourceSection,
} from '../src/index.ts';

// Pages are built from text items the way pdf.js gives them: in drawing
// order, y from the bottom, about 0.5 of the size per character wide.
const item = (str: string, x: number, y: number, size = 10): PdfTextItem => ({ str, x, y, width: str.length * size * 0.5, size });
const portrait = (items: PdfTextItem[]): PdfPageText => ({ width: 600, height: 800, items });
const landscape = (items: PdfTextItem[]): PdfPageText => ({ width: 960, height: 540, items });
/** Lines of body text at the left margin, 12 apart, starting at y. */
const lines = (texts: string[], y = 700, x = 72, size = 10) => texts.map((t, i) => item(t, x, y - i * 12, size));
const body = (md: string) => md.replace(/^## Page \d+\n\n/gm, '').trim();

test('every page starts with its heading, and a page heading says which page it is', () => {
  const r = pdfToMarkdown([portrait(lines(['One.'])), portrait(lines(['Two.']))]);
  assert.equal(r.markdown, '## Page 1\n\nOne.\n\n## Page 2\n\nTwo.');
  assert.equal(pageHeading(12), '## Page 12');
  assert.equal(pageOfHeading('Page 12'), 12);
  assert.equal(pageOfHeading('Page twelve'), null);
  assert.equal(r.pages, 2);
});

test('lines of a paragraph are joined; a gap, an indented first line or a short line starts a new one', () => {
  const full = 'x'.repeat(90); // 450 wide
  const r = pdfToMarkdown([
    portrait([
      ...lines([`${full} a`, `${full} b`, 'end of the first.'], 700),
      // a gap of two lines
      ...lines([`${full} c`, 'end of the second.'], 640),
      // no gap, but this line stops short, so the next is a new paragraph
      ...lines([`${full} d`, 'short.', `${full} e`], 604),
      // an indented first line
      item(`${full} f`, 90, 568),
      item(`${full} g`, 72, 556),
    ]),
  ]);
  assert.deepEqual(body(r.markdown).split('\n\n'), [
    `${full} a ${full} b end of the first.`,
    `${full} c end of the second.`,
    `${full} d short.`,
    `${full} e`,
    `${full} f ${full} g`,
  ]);
});

test('a word broken at the end of a line is joined again; Chinese lines join without a space', () => {
  const full = 'x'.repeat(90);
  const r = pdfToMarkdown([
    portrait([
      ...lines([`${full} represen-`, `tations ${full} well-`, `Known ${full} Jean-`, 'Paul.'], 700),
      ...lines(['梯度下降在每一步沿着负梯度方向更新参数学习率决定步长如果学习率太大损失会来回振荡甚至发散如果太小训练会非常缓慢这一段话故意写', '得比较长。'], 600),
      ...lines(['做 soft\u2011', 'max。'], 500),
    ]),
  ]);
  const [a, b, c] = body(r.markdown).split('\n\n');
  assert.equal(a, `${full} representations ${full} well-Known ${full} Jean-Paul.`);
  assert.ok(b?.endsWith('这一段话故意写得比较长。'));
  assert.equal(c, '做 softmax。');
});

test('a short line clearly larger than the text is a heading; heading sizes become levels', () => {
  const r = pdfToMarkdown([
    portrait([
      item('A Title Over', 72, 760, 24),
      item('Two Lines', 72, 736, 24),
      item('1 Introduction', 72, 700, 14),
      ...lines(['Some text.', 'More text.', 'Even more.'], 680),
      item('1.1 Detail', 72, 630, 12),
      ...lines(['Text again.'], 610),
    ]),
  ]);
  assert.equal(
    body(r.markdown),
    '### A Title Over Two Lines\n\n#### 1 Introduction\n\nSome text. More text. Even more.\n\n##### 1.1 Detail\n\nText again.',
  );
  assert.equal(r.title, 'A Title Over Two Lines');
  // A numbered section is not a title: the caller falls back to the file's name.
  const untitled = pdfToMarkdown([portrait([item('1 Introduction', 72, 700, 14), ...lines(['Text.'], 680)])]);
  assert.equal(untitled.title, '');
});

test('lines starting with a bullet are a list; a wrapped item goes on; a glyph with no text is a bullet only when aligned twice', () => {
  const r = pdfToMarkdown([
    landscape([
      item('Gradient descent', 200, 456, 44),
      item('\u2022', 43, 380, 32),
      item('Step against the gradient', 70, 378, 32),
      item('\u2022', 43, 335, 32),
      item('Too large a rate makes the loss bounce', 70, 334, 32),
      item('between the walls and diverge', 70, 295, 32),
    ]),
    portrait([
      ...lines(['Intro.'], 700),
      item('\ufffc', 82, 680),
      item(' ', 87, 680),
      item('Train with and without it.', 92, 680),
      item('\u0088', 82, 668),
      item(' ', 87, 668),
      item('Measure the entropy.', 92, 668),
      // alone: a bracket in a formula, not a bullet
      item('\u0012', 300, 600),
      item(' ', 306, 600),
      item('QK', 310, 600),
    ]),
  ]);
  const [one, two] = r.markdown.split('## Page 2');
  assert.equal(
    body(one as string),
    '### Gradient descent\n\n- Step against the gradient\n- Too large a rate makes the loss bounce between the walls and diverge',
  );
  assert.equal(body(two as string), 'Intro.\n\n- Train with and without it.\n- Measure the entropy.\n\nQK');
});

test('on a slide, a line starting with a capital starts a new paragraph; in a page of prose it does not', () => {
  const slide = pdfToMarkdown([landscape(lines(['Queries, keys and values', 'A softmax over the scores gives', 'the weights'], 400, 40, 28))]);
  assert.equal(body(slide.markdown), 'Queries, keys and values\n\nA softmax over the scores gives the weights');
  const prose = pdfToMarkdown([portrait(lines(['x'.repeat(90), 'The next sentence.']))]);
  assert.equal(body(prose.markdown), `${'x'.repeat(90)} The next sentence.`);
});

/** A line of body text 60 characters long (300 wide): a full line of a column. */
const fill = (s: string) => s.padEnd(60, 'z');

test('a paragraph goes on in the next column unless its sentence ended', () => {
  const r = pdfToMarkdown([
    portrait([
      ...lines([fill('one'), fill('and it goes')], 200, 72),
      ...lines([fill('on in the next column'), fill('two'), 'and ends here.'], 700, 320),
      // after a gap, a new paragraph; then up into a third column after a full stop
      ...lines([`${fill('three')}.`], 650, 320),
      ...lines([fill('four')], 700, 568),
    ]),
  ]);
  assert.deepEqual(body(r.markdown).split('\n\n'), [
    `${fill('one')} ${fill('and it goes')} ${fill('on in the next column')} ${fill('two')} and ends here.`,
    `${fill('three')}.`,
    fill('four'),
  ]);
});

const WORDS = ['one', 'two', 'three'];

test('page numbers and running heads and feet are dropped; the same line in the text is kept', () => {
  const page = (n: number) =>
    portrait([
      item(`Course notes, week ${n + 4}`, 72, 770, 8),
      ...lines([fill(`Page ${WORDS[n - 1]} begins`), fill('Course notes, week 5'), `ends on page ${WORDS[n - 1]}.`], 700),
      item(String(n), 300, 40, 8),
    ]);
  const r = pdfToMarkdown([page(1), page(2), page(3)]);
  assert.equal(
    r.markdown,
    WORDS.map((w, i) => `## Page ${i + 1}\n\n${fill(`Page ${w} begins`)} ${fill('Course notes, week 5')} ends on page ${w}.`).join('\n\n'),
  );
  // One page: only a number alone at the top or bottom goes.
  const one = pdfToMarkdown([portrait([...lines(['Only page.', '12 apples'], 700), item('- 1 -', 300, 40, 8)])]);
  assert.equal(body(one.markdown), 'Only page. 12 apples');
});

test('raised and lowered pieces stay on their line; pieces far apart get a space, touching ones none', () => {
  const r = pdfToMarkdown([
    portrait([
      item('Dividing by', 72, 700),
      { str: '\u221a', x: 136, y: 708, width: 8.5, size: 10 },
      item('d', 145, 700),
      item('k', 150, 698, 7),
      item('brings it back.', 160, 700),
      item('next', 72, 670),
    ]),
  ]);
  assert.equal(body(r.markdown), 'Dividing by \u221adk brings it back.\n\nnext');
});

test('text that would read as Markdown is escaped, so it shows as printed', () => {
  assert.equal(escapePdfText('costs $5 and $10, a*b*c, `x`, [1], ~2~'), 'costs \\$5 and \\$10, a\\*b\\*c, \\`x\\`, \\[1\\], \\~2\\~');
  assert.equal(escapePdfText('max_seq_len but _this_'), 'max_seq_len but \\_this\\_');
  assert.equal(escapePdfText('# not a heading'), '\\# not a heading');
  assert.equal(escapePdfText('> not a quote'), '\\> not a quote');
  assert.equal(escapePdfText('+ not a list'), '\\+ not a list');
  assert.equal(escapePdfText('a\\b &amp; c & d'), 'a\\\\b \\&amp; c & d');
  const r = pdfToMarkdown([portrait(lines(['# Price: $5 per *run*']))]);
  assert.equal(body(r.markdown), '\\# Price: \\$5 per \\*run\\*');
});

test('ligatures, radicals and control characters are cleaned; full-width punctuation stays', () => {
  assert.equal(cleanPdfText('\ufb01nd the \ufb02ow'), 'find the flow');
  assert.equal(cleanPdfText('\u2f12量、步\u2ed3：'), '力量、步长：');
  assert.equal(cleanPdfText('a\u00a0b\u00adc\u0012'), 'a bc\ufffc');
  const r = pdfToMarkdown([portrait(lines(['a\u0013 formula\ue000 mark']))]);
  assert.equal(body(r.markdown), 'a formula mark');
});

test('a page with no text says so; a file title is used unless it is a placeholder', () => {
  const r = pdfToMarkdown([portrait(lines(['Words.'])), portrait([])], { title: 'Microsoft Word - week5.docx' });
  assert.equal(r.markdown, `## Page 1\n\nWords.\n\n## Page 2\n\n${EMPTY_PAGE}`);
  assert.equal(r.emptyPages, 1);
  assert.equal(r.title, 'week5');
  assert.equal(pdfToMarkdown([portrait(lines(['Words.']))], { title: 'Untitled' }).title, '');
});

test('a very long PDF is cut at a page', () => {
  const page = portrait(lines(Array.from({ length: 50 }, () => 'y'.repeat(1000))));
  const r = pdfToMarkdown(Array.from({ length: 60 }, () => page));
  assert.equal(r.truncated, true);
  assert.ok(r.markdown.length <= MAX_PDF_CHARS);
  assert.ok(r.markdown.endsWith('y'));
});

test('the section sent with a question about a PDF passage is not cut at page headings', () => {
  const md = pdfToMarkdown([
    portrait([item('Results', 72, 760, 16), ...lines(['The first finding, which goes on'])]),
    portrait(lines(['onto the next page.', 'A second paragraph.'])),
  ]).markdown;
  const at = md.indexOf('onto the next page');
  const section = sourceSection(md, at, at + 4);
  assert.ok(section.startsWith('### Results'), section);
  assert.ok(section.includes('The first finding') && section.includes('A second paragraph.'), section);
});
