// A web page as Markdown: the readable part only, with headings, lists,
// tables, code and math kept. Pure (no DOM), so it runs on the server for a
// fetched page and in the browser for pasted HTML, and is tested in Node.
//
// It is built for what a learner reads: papers on arXiv (LaTeXML HTML,
// where every formula carries its LaTeX in `alttext`), documentation,
// articles and Wikipedia. It is not a browser: a tolerant tokenizer builds a
// small tree, the main content is picked (the largest <article>, else
// <main>, else the body), page furniture is dropped, and the rest is written
// out as blocks.

interface El {
  name: string;
  attrs: Record<string, string>;
  children: Child[];
  parent: El | null;
}
type Child = El | string;

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
/** Elements whose content is raw text up to their end tag. */
const RAW = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'xmp', 'template', 'iframe']);
/** Opening one of these closes an open <p>. */
const CLOSES_P = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul',
]);

// Entities --------------------------------------------------------------------

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  minus: '−',
  le: '≤',
  ge: '≥',
  ne: '≠',
  asymp: '≈',
  infin: '∞',
  sum: '∑',
  prod: '∏',
  radic: '√',
  part: '∂',
  nabla: '∇',
  isin: '∈',
  rarr: '→',
  larr: '←',
  harr: '↔',
  rArr: '⇒',
  lArr: '⇐',
  hArr: '⇔',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  theta: 'θ',
  lambda: 'λ',
  mu: 'μ',
  pi: 'π',
  sigma: 'σ',
  tau: 'τ',
  phi: 'φ',
  omega: 'ω',
  Delta: 'Δ',
  Sigma: 'Σ',
  Omega: 'Ω',
  sup1: '¹',
  sup2: '²',
  sup3: '³',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  sect: '§',
  para: '¶',
  dagger: '†',
  Dagger: '‡',
  prime: '′',
  Prime: '″',
  zwj: '',
  zwnj: '',
  shy: '',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  eacute: 'é',
  egrave: 'è',
  aacute: 'á',
  agrave: 'à',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  ccedil: 'ç',
  szlig: 'ß',
};

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      return String.fromCodePoint(code);
    }
    const named = NAMED[body];
    return named ?? whole;
  });
}

// Tokenizer and tree ----------------------------------------------------------

const TAG = /<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const CLOSE = /<\/\s*([a-zA-Z][\w:-]*)[^>]*>/y;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of text.matchAll(ATTR)) {
    const name = (m[1] as string).toLowerCase();
    if (name in attrs) continue;
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/** Parse HTML into a small tree, forgiving like a browser about unclosed tags. */
export function parseHtml(html: string): El {
  const root: El = { name: '#root', attrs: {}, children: [], parent: null };
  const lower = html.toLowerCase();
  let current = root;
  const text = (t: string) => {
    if (t) current.children.push(decodeEntities(t));
  };
  const openNames = (): string[] => {
    const names: string[] = [];
    for (let e: El | null = current; e; e = e.parent) names.push(e.name);
    return names;
  };
  const closeTo = (name: string, stopAt: string[] = []) => {
    for (let e: El | null = current; e && e !== root; e = e.parent) {
      if (stopAt.includes(e.name)) return;
      if (e.name === name) {
        current = e.parent ?? root;
        return;
      }
    }
  };
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      text(html.slice(i));
      break;
    }
    if (lt > i) text(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', lt)) {
      const end = html.indexOf(']]>', lt + 9);
      text(html.slice(lt + 9, end === -1 ? n : end));
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (html[lt + 1] === '/') {
      CLOSE.lastIndex = lt;
      const m = CLOSE.exec(html);
      if (!m) {
        text('<');
        i = lt + 1;
        continue;
      }
      const name = (m[1] as string).toLowerCase();
      if (name === 'p' && !openNames().includes('p')) {
        // A stray </p> is an empty paragraph, as in browsers.
      } else {
        closeTo(name);
      }
      i = lt + m[0].length;
      continue;
    }
    TAG.lastIndex = lt;
    const m = TAG.exec(html);
    if (!m) {
      text('<');
      i = lt + 1;
      continue;
    }
    const name = (m[1] as string).toLowerCase();
    const attrs = parseAttrs(m[2] ?? '');
    i = lt + m[0].length;
    // Implied ends, as browsers do for the common cases.
    if (CLOSES_P.has(name) && current.name === 'p') current = current.parent ?? root;
    if (name === 'li') closeTo('li', ['ul', 'ol', 'menu']);
    if (name === 'dt' || name === 'dd') {
      closeTo('dt', ['dl']);
      closeTo('dd', ['dl']);
    }
    if (name === 'td' || name === 'th') {
      closeTo('td', ['tr', 'table']);
      closeTo('th', ['tr', 'table']);
    }
    if (name === 'tr') closeTo('tr', ['table', 'tbody', 'thead', 'tfoot']);
    if (name === 'option') closeTo('option', ['select']);
    const el: El = { name, attrs, children: [], parent: current };
    current.children.push(el);
    if (VOID.has(name) || m[3] === '/') continue;
    if (RAW.has(name)) {
      const end = lower.indexOf(`</${name}`, i);
      const stop = end === -1 ? n : end;
      el.children.push(html.slice(i, stop));
      const close = end === -1 ? -1 : html.indexOf('>', end);
      i = close === -1 ? n : close + 1;
      continue;
    }
    current = el;
  }
  return root;
}

// Queries ---------------------------------------------------------------------

function* walk(el: El): Generator<El> {
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    yield c;
    yield* walk(c);
  }
}

function find(el: El, test: (e: El) => boolean): El | null {
  for (const e of walk(el)) if (test(e)) return e;
  return null;
}

function classes(el: El): string[] {
  return (el.attrs.class ?? '').split(/\s+/).filter(Boolean);
}

function hasClass(el: El, name: string): boolean {
  return classes(el).includes(name);
}

/** All text inside, as is (no whitespace folding). */
function textOf(el: Child): string {
  if (typeof el === 'string') return el;
  if (el.name === 'script' || el.name === 'style') return '';
  return el.children.map(textOf).join('');
}

// What to leave out -------------------------------------------------------------

const DROP_NAMES = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'nav',
  'footer',
  'aside',
  'form',
  'button',
  'select',
  'input',
  'textarea',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
  'video',
  'audio',
  'map',
  'head',
  'link',
  'meta',
  'title',
  'dialog',
]);
const DROP_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'menu', 'menubar']);
/** Words in a class or id that mark page furniture (split on spaces, - and _). */
const DROP_WORDS = new Set([
  'nav',
  'navbar',
  'navigation',
  'menu',
  'footer',
  'sidebar',
  'breadcrumb',
  'breadcrumbs',
  'cookie',
  'cookies',
  'share',
  'sharing',
  'social',
  'advert',
  'advertisement',
  'ads',
  'comments',
  'subscribe',
  'newsletter',
  'toc',
  'editsection',
  'skip',
  'banner',
  'popup',
  'modal',
  'toolbar',
  'navbox',
  'catlinks',
  'noprint',
  'jump',
]);

function dropped(el: El): boolean {
  if (DROP_NAMES.has(el.name)) {
    // A <script> holding TeX (MathJax 2) is math, not furniture.
    return !(el.name === 'script' && /^math\/tex/i.test(el.attrs.type ?? ''));
  }
  if (el.attrs.hidden !== undefined) return true;
  if (el.attrs['aria-hidden'] === 'true' && !hasClass(el, 'katex-html')) return true;
  if (DROP_ROLES.has((el.attrs.role ?? '').toLowerCase())) return true;
  if (el.name === 'header' && !find(el, (e) => e.name === 'h1')) return true;
  const words = `${el.attrs.class ?? ''} ${el.attrs.id ?? ''}`.toLowerCase().split(/[\s_-]+/);
  return words.some((w) => DROP_WORDS.has(w));
}

// Writing Markdown --------------------------------------------------------------

interface Ctx {
  base: URL | null;
  /** Footnotes met inside the current block, written right after it. */
  notes: string[];
  /** Blocks met inside inline content (display math, a list in a span), held out of the text by index. */
  held: string[];
}

/** Marks a held block in an inline run: written on its own between blank lines. */
const HELD = '\u0001';

function hold(ctx: Ctx, block: string): string {
  ctx.held.push(block);
  return `\n\n${HELD}${ctx.held.length - 1}${HELD}\n\n`;
}

/** Inline text where blocks can't go (a heading, a table cell): held blocks back in the line, display math as inline math. */
function flat(text: string, ctx: Ctx): string {
  return text
    .replace(new RegExp(`\\s*${HELD}(\\d+)${HELD}\\s*`, 'g'), (_, i: string) => {
      const block = ctx.held[Number(i)] ?? '';
      const math = /^\$\$\n([\s\S]*?)\n\$\$$/.exec(block);
      return ` ${math ? `$${(math[1] as string).replace(/\s*\\tag\{[^}]*\}$/, '').replace(/\s+/g, ' ')}$` : block.replace(/\s+/g, ' ')} `;
    })
    .replace(/\n{2,}/g, ' ');
}

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
};
const superscript = (s: string) => [...s].map((c) => SUPERSCRIPT[c] ?? c).join('');

/** Plain text made safe in Markdown: characters that would start markup are escaped. */
function escapeText(text: string): string {
  return text.replace(/([\\`*_[\]$<])/g, '\\$1');
}

/** A text node: folded whitespace, escaped, with TeX written as \(…\) or \[…\] (MathJax pages) kept as math. */
function textRun(text: string, ctx: Ctx): string {
  const folded = text.replace(/\s+/g, ' ');
  if (!folded.includes('\\(') && !folded.includes('\\[')) return escapeText(folded);
  let out = '';
  let at = 0;
  for (const m of folded.matchAll(/\\\((.+?)\\\)|\\\[(.+?)\\\]/g)) {
    out += escapeText(folded.slice(at, m.index));
    out += m[1] !== undefined ? `$${m[1].trim()}$` : hold(ctx, displayMath(m[2] as string));
    at = (m.index as number) + m[0].length;
  }
  return out + escapeText(folded.slice(at));
}

const BLOCK_START = /^(#{1,6}\s|[-+*]\s|>|\d{1,9}[.)]\s|={3,}|-{3,}|```|~~~)/;

function absolute(href: string, ctx: Ctx): string | null {
  const h = href.trim();
  if (!h || h.startsWith('#') || /^(javascript|data|mailto|tel):/i.test(h)) return null;
  try {
    return ctx.base ? new URL(h, ctx.base).href : /^https?:\/\//i.test(h) ? h : null;
  } catch {
    return null;
  }
}

/** LaTeX of a math element: LaTeXML's alttext, a TeX annotation, or its text. */
function texOf(el: El): string {
  const alt = el.attrs.alttext;
  if (alt?.trim()) return alt.trim();
  const ann = find(el, (e) => e.name === 'annotation' && /tex/i.test(e.attrs.encoding ?? ''));
  if (ann) return textOf(ann).trim();
  return textOf(el).replace(/\s+/g, ' ').trim();
}

function displayMath(tex: string, tag?: string): string {
  const t = tex.replace(/\n{2,}/g, '\n').trim();
  return `$$\n${t}${tag ? ` \\tag{${tag}}` : ''}\n$$`;
}

/** Inline Markdown for an element's children. Display math and breaks between blocks come out as "\n\n". */
function inline(el: El, ctx: Ctx): string {
  let out = '';
  for (const c of el.children) out += typeof c === 'string' ? textRun(c, ctx) : inlineEl(c, ctx);
  return out;
}

function wrap(mark: string, inner: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner) as RegExpExecArray;
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner;
}

function inlineEl(el: El, ctx: Ctx): string {
  if (dropped(el)) return '';
  // Footnotes inside a paragraph (LaTeXML): a superscript mark here, the note after the block.
  if (hasClass(el, 'ltx_note')) {
    const markEl = find(el, (e) => hasClass(e, 'ltx_note_mark'));
    const mark = markEl ? textOf(markEl).trim() : '';
    const content = find(el, (e) => hasClass(e, 'ltx_note_content'));
    if (content) {
      const copy: El = {
        ...content,
        children: content.children.filter((c) => typeof c === 'string' || !hasClass(c, 'ltx_note_mark')),
      };
      const text = collapse(flat(inline(copy, ctx), ctx));
      if (text) ctx.notes.push(`> ${superscript(mark)} ${text}`);
    }
    return mark ? superscript(mark) : '';
  }
  switch (el.name) {
    case 'br':
      return '\\\n';
    case 'img':
      return '';
    case 'math': {
      const tex = texOf(el);
      if (!tex) return '';
      return el.attrs.display === 'block' ? hold(ctx, displayMath(tex)) : `$${tex}$`;
    }
    case 'script': {
      const tex = textOf(el).trim();
      if (!tex) return '';
      return /mode\s*=\s*display/i.test(el.attrs.type ?? '') ? hold(ctx, displayMath(tex)) : `$${tex}$`;
    }
    case 'code':
    case 'kbd':
    case 'samp':
    case 'tt': {
      const code = textOf(el).replace(/\s+/g, ' ');
      if (!code.trim()) return code;
      const ticks = code.includes('`') ? '``' : '`';
      return `${ticks}${code}${ticks}`;
    }
    case 'em':
    case 'i':
    case 'dfn':
      return wrap('*', inline(el, ctx));
    case 'strong':
    case 'b':
      return wrap('**', inline(el, ctx));
    case 'a': {
      const inner = inline(el, ctx);
      const href = absolute(el.attrs.href ?? '', ctx);
      if (!href || !inner.trim()) return inner;
      return `[${inner.trim()}](${href.replace(/[()\s]/g, (c) => encodeURIComponent(c))})`;
    }
    case 'span':
      if (hasClass(el, 'katex-display') || hasClass(el, 'katex')) {
        const ann = find(el, (e) => e.name === 'annotation');
        if (ann) {
          const tex = textOf(ann).trim();
          return hasClass(el, 'katex-display') ? hold(ctx, displayMath(tex)) : `$${tex}$`;
        }
      }
      if (hasClass(el, 'katex-html')) return '';
      return inline(el, ctx);
    default:
      if (isBlock(el)) return blocks(el, ctx).map((b) => hold(ctx, b)).join('');
      return inline(el, ctx);
  }
}

const BLOCKS = new Set([
  ...CLOSES_P,
  'body',
  'html',
  'li',
  'dd',
  'dt',
  'tbody',
  'thead',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
  'center',
  'hgroup',
]);
const isBlock = (el: El) => BLOCKS.has(el.name);

/** Fold whitespace in an inline run, keeping hard breaks. */
function collapse(text: string): string {
  return text
    .split('\\\n')
    .map((part) => part.replace(/[ \t\n\r\f\v]+/g, ' ').trim())
    .filter((part, i, all) => part !== '' || (i > 0 && i < all.length - 1))
    .join('\\\n')
    .trim();
}

/** Inline text as paragraph blocks: held blocks (display math, nested blocks) split it. */
function paragraphs(text: string, ctx: Ctx): string[] {
  const out: string[] = [];
  for (const piece of text.split(/\n{2,}/)) {
    const held = new RegExp(`^\\s*${HELD}(\\d+)${HELD}\\s*$`).exec(piece);
    if (held) {
      out.push(ctx.held[Number(held[1])] as string);
      continue;
    }
    const p = collapse(piece);
    if (!p) continue;
    out.push(BLOCK_START.test(p) ? `\\${p}` : p);
  }
  return out;
}

function fence(code: string, lang: string): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${code.replace(/\n+$/, '')}\n${ticks}`;
}

function languageOf(el: El): string {
  for (const e of [el, ...walk(el)]) {
    const m = /(?:^|\s)(?:language|lang|highlight-source)-([\w+#-]+)/.exec(e.attrs.class ?? '');
    if (m) return (m[1] as string).toLowerCase();
  }
  return '';
}

function list(el: El, ctx: Ctx): string {
  const ordered = el.name === 'ol';
  let n = Number.parseInt(el.attrs.start ?? '1', 10) || 1;
  const items: string[] = [];
  for (const c of el.children) {
    if (typeof c === 'string') {
      if (c.trim()) items.push(`- ${escapeText(c.trim())}`);
      continue;
    }
    if (dropped(c)) continue;
    const marker = ordered ? `${n++}. ` : '- ';
    const body = c.name === 'li' ? blocks(c, ctx) : [collapse(flat(inlineEl(c, ctx), ctx))].filter(Boolean);
    if (body.length === 0) continue;
    const pad = ' '.repeat(marker.length);
    // A nested list follows its item's text directly, so the list stays tight.
    const joined = body.reduce((acc, b) => (acc ? `${acc}${/^([-+*]|\d{1,9}[.)]) /.test(b) ? '\n' : '\n\n'}${b}` : b), '');
    const text = joined
      .split('\n')
      .map((line, i) => (i === 0 ? marker + line : line ? pad + line : ''))
      .join('\n');
    items.push(text);
  }
  return items.join('\n');
}

function cellText(el: El, ctx: Ctx): string {
  return collapse(flat(inline(el, ctx), ctx))
    .replace(/\\\n/g, ' ')
    .replace(/\|/g, '\\|');
}

function table(el: El, ctx: Ctx): string[] {
  // An equation laid out in a table (LaTeXML): the formula, with its number.
  const formulas = [...walk(el)].filter((e) => e.name === 'math' && e.attrs.display === 'block');
  if (formulas.length > 0) {
    const tag = /^\((\d+(?:\.\d+)*[a-z]?)\)$/.exec(textOf(find(el, (e) => hasClass(e, 'ltx_tag')) ?? el).trim())?.[1];
    return formulas.map((f, i) => displayMath(texOf(f), i === formulas.length - 1 ? tag : undefined));
  }
  const rows = [...walk(el)].filter((e) => e.name === 'tr');
  // A layout table (a table inside, or no rows): just its content.
  if (rows.length === 0 || find(el, (e) => e !== el && e.name === 'table')) {
    return el.children.flatMap((c) => (typeof c === 'string' ? paragraphs(textRun(c, ctx), ctx) : blockOf(c, ctx)));
  }
  const cells = rows.map((r) => r.children.filter((c): c is El => typeof c !== 'string' && (c.name === 'td' || c.name === 'th')));
  const width = Math.max(...cells.map((r) => r.length));
  if (width === 0) return [];
  const line = (r: El[]) => `| ${Array.from({ length: width }, (_, i) => (r[i] ? cellText(r[i] as El, ctx) : '')).join(' | ')} |`;
  const [head = [], ...body] = cells;
  const out = [line(head), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...body.map(line)];
  const caption = find(el, (e) => e.name === 'caption');
  return caption ? [`*${collapse(flat(inline(caption, ctx), ctx))}*`, out.join('\n')] : [out.join('\n')];
}

/** Markdown blocks for one element at block level. */
function blockOf(el: El, ctx: Ctx): string[] {
  if (dropped(el)) return [];
  const h = /^h([1-6])$/.exec(el.name);
  if (h) {
    const text = collapse(flat(inline(el, ctx), ctx).replace(/\\\n/g, ' '));
    return text ? [`${'#'.repeat(Number(h[1]))} ${text}`] : [];
  }
  switch (el.name) {
    case 'pre': {
      const code = textOf(el);
      return code.trim() ? [fence(code, languageOf(el))] : [];
    }
    case 'ul':
    case 'ol':
    case 'menu': {
      const l = list(el, ctx);
      return l ? [l] : [];
    }
    case 'blockquote': {
      const inner = blocks(el, ctx);
      if (inner.length === 0) return [];
      return [
        inner
          .join('\n\n')
          .split('\n')
          .map((l) => (l ? `> ${l}` : '>'))
          .join('\n'),
      ];
    }
    case 'table':
      return table(el, ctx);
    case 'hr':
      return ['---'];
    case 'img':
    case 'br':
      return [];
    case 'figure':
      return blocks(el, ctx);
    case 'figcaption':
    case 'caption': {
      const text = collapse(flat(inline(el, ctx), ctx));
      return text ? [`*${text}*`] : [];
    }
    case 'dt': {
      const text = collapse(flat(inline(el, ctx), ctx));
      return text ? [`**${text}**`] : [];
    }
    default:
      if (isBlock(el) && el.name !== 'p') return blocks(el, ctx);
      return paragraphs(inline(el, ctx), ctx);
  }
}

/** Markdown blocks for an element's children: inline runs become paragraphs. */
function blocks(el: El, ctx: Ctx): string[] {
  const out: string[] = [];
  let run = '';
  const flush = () => {
    out.push(...paragraphs(run, ctx));
    run = '';
    if (ctx.notes.length > 0) {
      out.push(...ctx.notes);
      ctx.notes = [];
    }
  };
  for (const c of el.children) {
    if (typeof c === 'string') {
      run += textRun(c, ctx);
    } else if (isBlock(c) && !dropped(c)) {
      flush();
      out.push(...blockOf(c, ctx));
      if (ctx.notes.length > 0) {
        out.push(...ctx.notes);
        ctx.notes = [];
      }
    } else {
      run += inlineEl(c, ctx);
    }
  }
  flush();
  return out;
}

// The page ------------------------------------------------------------------------

function meta(root: El, ...names: string[]): string | null {
  for (const name of names) {
    const m = find(
      root,
      (e) => e.name === 'meta' && (e.attrs.name === name || e.attrs.property === name) && Boolean(e.attrs.content?.trim()),
    );
    if (m) return (m.attrs.content as string).trim();
  }
  return null;
}

/** The part of the page that is the thing being read. */
function mainOf(root: El): El {
  const articles = [...walk(root)].filter((e) => e.name === 'article' && !dropped(e));
  if (articles.length > 0) {
    return articles.reduce((best, a) => (textOf(a).length > textOf(best).length ? a : best));
  }
  return (
    find(root, (e) => e.name === 'main' || e.attrs.role === 'main') ??
    find(root, (e) => hasClass(e, 'mw-parser-output')) ??
    find(root, (e) => e.name === 'body') ??
    root
  );
}

export interface ReadablePage {
  title: string;
  markdown: string;
}

/** Longest Markdown kept from one page. */
export const MAX_PAGE_CHARS = 2_000_000;

/**
 * The readable part of an HTML page (or a pasted fragment) as Markdown.
 * `url` resolves relative links. Headings, paragraphs, lists, tables, code
 * and math survive; navigation, footers, scripts and the like do not.
 */
export function htmlToMarkdown(html: string, options: { url?: string } = {}): ReadablePage {
  const root = parseHtml(html);
  let base: URL | null = null;
  try {
    const href = find(root, (e) => e.name === 'base' && Boolean(e.attrs.href))?.attrs.href;
    base = options.url ? new URL(href ?? options.url, options.url) : null;
  } catch {
    base = null;
  }
  const main = mainOf(root);
  const ctx: Ctx = { base, notes: [], held: [] };
  const markdown = blocks(main, ctx)
    .filter((b) => b.trim() !== '')
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, MAX_PAGE_CHARS)
    .trim();
  const h1 = find(main, (e) => e.name === 'h1');
  const titleTag = find(root, (e) => e.name === 'title');
  const title =
    meta(root, 'citation_title', 'og:title', 'twitter:title') ??
    (h1 ? collapse(textOf(h1)) : null) ??
    (titleTag ? textOf(titleTag).replace(/\s+/g, ' ').trim() : '') ??
    '';
  return { title: title.replace(/\s+/g, ' ').trim(), markdown };
}
