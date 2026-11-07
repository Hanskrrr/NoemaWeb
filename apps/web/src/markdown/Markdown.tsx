// Renders Markdown as React elements (never as raw HTML strings), with
// every text leaf wrapped in <span data-s data-e> carrying its raw range.
// selection.ts uses those spans to turn a browser selection into offsets.
//
// Safety: raw HTML in the Markdown is shown as text, links are limited to
// http(s) and mailto, images are not loaded. KaTeX is the only HTML we
// inject, and it runs with trust: false.

import { type CiteRefs, splitCitations } from '@noema/core';
import katex from 'katex';
import type { Nodes, Parents } from 'mdast';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { codeRegion, nodeRange, parseMarkdown } from './parse.ts';

/**
 * Citations: in a note, [E3] labels become buttons that open the exact
 * message they cite. Notes provide this; in chat there is none and [E3] is
 * just text. A note opens the exchange beside it (`open`); a merge card goes
 * to it (`go`).
 */
export interface Cites {
  refs: CiteRefs;
  go: (threadId: string, messageId: string) => void;
  /** Open the exchange beside the text instead, given the citation and the button clicked. */
  open?: (label: string, button: HTMLElement) => void;
  /** The citation open beside the text, if any. */
  current?: string | undefined;
}
export const CiteContext = createContext<Cites | null>(null);

function withCites(key: string | number, text: string, cites: Cites): ReactNode {
  const parts = splitCitations(text, (label) => label in cites.refs);
  if (parts.length === 1 && typeof parts[0] === 'string') return text;
  return (
    <span key={key}>
      {parts.map((part, i) => {
        if (typeof part === 'string') return part;
        const ref = cites.refs[part.label];
        if (!ref) return null;
        return (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string
            key={i}
            type="button"
            className={`cite${cites.current === part.label ? ' current' : ''}`}
            onClick={(e) =>
              cites.open ? cites.open(part.label, e.currentTarget) : cites.go(ref.threadId, ref.messageId)
            }
            title={cites.open ? 'Show the exchange this comes from, beside the note' : 'Open the exchange this comes from'}
            aria-pressed={cites.open ? cites.current === part.label : undefined}
            data-testid="cite"
            data-label={part.label}
          >
            {part.label}
          </button>
        );
      })}
    </span>
  );
}

const mathCache = new Map<string, string>();

/**
 * A numbered display equation: the formula wrapped apart from its number, so
 * the number can follow it instead of being pinned over it (styles.css,
 * .eq-body). Numbers of aligned rows (`eq-rows`) stay level with their rows;
 * a single equation's number may go below it, as in LaTeX, when the line is
 * too long.
 */
export function numberAside(html: string): string {
  const open = '<span class="katex-html" aria-hidden="true">';
  const a = html.indexOf(open);
  const t = html.lastIndexOf('<span class="tag">');
  if (a < 0 || t < a) return html;
  const s = a + open.length;
  const rows = html.indexOf('vlist', t) >= 0 ? ' eq-rows' : '';
  return `${html.slice(0, s)}<span class="eq-body${rows}">${html.slice(s, t)}</span>${html.slice(t)}`;
}

function renderMath(value: string, display: boolean): string {
  const key = `${display ? 'D' : 'I'}${value}`;
  let html = mathCache.get(key);
  if (html === undefined) {
    html = katex.renderToString(value, {
      displayMode: display,
      throwOnError: false,
      trust: false,
      strict: 'ignore',
      output: 'htmlAndMathml',
    });
    if (display) html = numberAside(html);
    if (mathCache.size > 5000) mathCache.clear(); // a long paper has many formulas
    mathCache.set(key, html);
  }
  return html;
}

function safeHref(url: string): string | undefined {
  try {
    const u = new URL(url, 'https://invalid.local/');
    if (u.origin === 'https://invalid.local') return undefined; // relative links lead nowhere here
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function leafSpan(key: string | number, start: number, end: number, text: string): ReactNode {
  return (
    <span key={key} data-s={start} data-e={end}>
      {text}
    </span>
  );
}

function children(node: Parents, source: string, cites: Cites | null): ReactNode[] {
  return (node.children as Nodes[]).map((child, i) => render(child, source, i, cites));
}

function render(node: Nodes, source: string, index: number, cites: Cites | null): ReactNode {
  const r = nodeRange(node);
  const key = r ? `${node.type}:${r.start}` : `${node.type}#${index}`;
  switch (node.type) {
    case 'root':
      return children(node, source, cites);
    case 'paragraph':
      return <p key={key}>{children(node, source, cites)}</p>;
    case 'heading': {
      const Tag = `h${Math.min(6, node.depth + 1)}` as 'h2';
      return <Tag key={key}>{children(node, source, cites)}</Tag>;
    }
    case 'text':
      if (cites && node.value.includes('[E')) return withCites(key, node.value, cites);
      return r ? leafSpan(key, r.start, r.end, node.value) : node.value;
    case 'html':
      // Shown, never executed.
      return r ? leafSpan(key, r.start, r.end, node.value) : node.value;
    case 'emphasis':
      return <em key={key}>{children(node, source, cites)}</em>;
    case 'strong':
      return <strong key={key}>{children(node, source, cites)}</strong>;
    case 'inlineCode':
      return <code key={key}>{r ? leafSpan('v', r.start, r.end, node.value) : node.value}</code>;
    case 'code': {
      const region = r ? codeRegion(source, r.start, r.end) : null;
      return (
        <pre key={key} data-lang={node.lang ?? undefined}>
          <code>{region ? leafSpan('v', region.start, region.end, node.value) : node.value}</code>
        </pre>
      );
    }
    case 'inlineMath':
      // Written \[ … \] on one line with text: drawn displayed, still inside its paragraph.
      if (r && source.startsWith('\\[', r.start)) {
        return (
          <span
            key={key}
            className="math math-display math-display-inline"
            data-s={r.start}
            data-e={r.end}
            data-atomic=""
            // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX output, trust disabled
            dangerouslySetInnerHTML={{ __html: renderMath(node.value, true) }}
          />
        );
      }
      return (
        <span
          key={key}
          className="math math-inline"
          data-s={r?.start}
          data-e={r?.end}
          data-atomic=""
          // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX output, trust disabled
          dangerouslySetInnerHTML={{ __html: renderMath(node.value, false) }}
        />
      );
    case 'math':
      return (
        <div
          key={key}
          className="math math-display"
          data-s={r?.start}
          data-e={r?.end}
          data-atomic=""
          // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX output, trust disabled
          dangerouslySetInnerHTML={{ __html: renderMath(node.value, true) }}
        />
      );
    case 'list': {
      const items = children(node, source, cites);
      const cls = node.spread ? 'spread' : 'tight';
      return node.ordered ? (
        <ol key={key} start={node.start ?? undefined} className={cls}>
          {items}
        </ol>
      ) : (
        <ul key={key} className={cls}>
          {items}
        </ul>
      );
    }
    case 'listItem':
      if (typeof node.checked === 'boolean') {
        return (
          <li key={key} className="task">
            <input type="checkbox" checked={node.checked} disabled readOnly aria-label={node.checked ? 'done' : 'not done'} />
            {children(node, source, cites)}
          </li>
        );
      }
      return <li key={key}>{children(node, source, cites)}</li>;
    case 'delete':
      return <del key={key}>{children(node, source, cites)}</del>;
    case 'table': {
      const [head, ...rows] = node.children;
      const align = (i: number) => {
        const a = node.align?.[i];
        return a ? { textAlign: a } : undefined;
      };
      return (
        <div key={key} className="table-wrap">
          <table>
            {head && (
              <thead>
                <tr>
                  {head.children.map((cell, i) => (
                    <th key={`h${nodeRange(cell)?.start ?? i}`} style={align(i)}>
                      {children(cell, source, cites)}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            {rows.length > 0 && (
              <tbody>
                {rows.map((row, r) => (
                  <tr key={`r${nodeRange(row)?.start ?? r}`}>
                    {row.children.map((cell, i) => (
                      <td key={`c${nodeRange(cell)?.start ?? i}`} style={align(i)}>
                        {children(cell, source, cites)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
      );
    }
    case 'footnoteReference':
      return (
        <sup key={key} className="fnref" data-s={r?.start} data-e={r?.end} data-atomic="">
          [{node.label ?? node.identifier}]
        </sup>
      );
    case 'footnoteDefinition':
      return (
        <div key={key} className="footnote">
          <span className="fn-label">[{node.label ?? node.identifier}]</span>
          {children(node, source, cites)}
        </div>
      );
    case 'blockquote':
      return <blockquote key={key}>{children(node, source, cites)}</blockquote>;
    case 'thematicBreak':
      return <hr key={key} />;
    case 'break':
      return <br key={key} />;
    case 'link': {
      const href = safeHref(node.url);
      return href ? (
        <a key={key} href={href} target="_blank" rel="noreferrer noopener">
          {children(node, source, cites)}
        </a>
      ) : (
        <span key={key} className="link-disabled">
          {children(node, source, cites)}
        </span>
      );
    }
    case 'image':
      return (
        <span key={key} className="image-alt" data-s={r?.start} data-e={r?.end} data-atomic="">
          [image: {node.alt || 'untitled'}]
        </span>
      );
    case 'definition':
    case 'yaml':
      return null;
    default:
      if ('children' in node) return <span key={key}>{children(node as Parents, source, cites)}</span>;
      if ('value' in node && typeof node.value === 'string')
        return r ? leafSpan(key, r.start, r.end, node.value) : node.value;
      return null;
  }
}

/**
 * Something shown inside the text, after the top-level block (paragraph,
 * list, table…) that holds raw offset `at`. Marked foreign, so selecting
 * in it is never taken for a passage of this text.
 */
export interface Slot {
  key: string;
  at: number;
  node: ReactNode;
}

/**
 * `tex` (on by default): also read \( … \) and \[ … \] as math, as models
 * write it. Off for sources, whose pages escape brackets as \[ and \].
 */
export function Markdown({ source, slots, tex = true }: { source: string; slots?: Slot[]; tex?: boolean }) {
  const tree = useMemo(() => parseMarkdown(source, { tex }), [source, tex]);
  const cites = useContext(CiteContext);
  if (!slots || slots.length === 0) return <div className="md">{render(tree, source, 0, cites)}</div>;
  const blocks = tree.children as Nodes[];
  const out: ReactNode[] = [];
  blocks.forEach((block, i) => {
    out.push(render(block, source, i, cites));
    const from = i === 0 ? Number.NEGATIVE_INFINITY : (nodeRange(block)?.start ?? 0);
    const next = blocks[i + 1];
    const to = next ? (nodeRange(next)?.start ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
    for (const slot of slots) {
      if (slot.at >= from && slot.at < to) {
        out.push(
          <div key={`slot:${slot.key}`} className="md-slot" data-foreign="">
            {slot.node}
          </div>,
        );
      }
    }
  });
  if (blocks.length === 0) for (const slot of slots) out.push(<div key={`slot:${slot.key}`}>{slot.node}</div>);
  return <div className="md">{out}</div>;
}
