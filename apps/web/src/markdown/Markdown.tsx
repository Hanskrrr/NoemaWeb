// Renders Markdown as React elements (never as raw HTML strings), with
// every text leaf wrapped in <span data-s data-e> carrying its raw range.
// selection.ts uses those spans to turn a browser selection into offsets.
//
// Safety: raw HTML in the Markdown is shown as text, links are limited to
// http(s) and mailto, images are not loaded. KaTeX is the only HTML we
// inject, and it runs with trust: false.

import katex from 'katex';
import type { Nodes, Parents } from 'mdast';
import { type ReactNode, useMemo } from 'react';
import { codeRegion, nodeRange, parseMarkdown } from './parse.ts';

const mathCache = new Map<string, string>();

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
    if (mathCache.size > 500) mathCache.clear();
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

function children(node: Parents, source: string): ReactNode[] {
  return (node.children as Nodes[]).map((child, i) => render(child, source, i));
}

function render(node: Nodes, source: string, index: number): ReactNode {
  const r = nodeRange(node);
  const key = r ? `${node.type}:${r.start}` : `${node.type}#${index}`;
  switch (node.type) {
    case 'root':
      return children(node, source);
    case 'paragraph':
      return <p key={key}>{children(node, source)}</p>;
    case 'heading': {
      const Tag = `h${Math.min(6, node.depth + 1)}` as 'h2';
      return <Tag key={key}>{children(node, source)}</Tag>;
    }
    case 'text':
      return r ? leafSpan(key, r.start, r.end, node.value) : node.value;
    case 'html':
      // Shown, never executed.
      return r ? leafSpan(key, r.start, r.end, node.value) : node.value;
    case 'emphasis':
      return <em key={key}>{children(node, source)}</em>;
    case 'strong':
      return <strong key={key}>{children(node, source)}</strong>;
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
      const items = children(node, source);
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
            {children(node, source)}
          </li>
        );
      }
      return <li key={key}>{children(node, source)}</li>;
    case 'delete':
      return <del key={key}>{children(node, source)}</del>;
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
                      {children(cell, source)}
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
                        {children(cell, source)}
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
          {children(node, source)}
        </div>
      );
    case 'blockquote':
      return <blockquote key={key}>{children(node, source)}</blockquote>;
    case 'thematicBreak':
      return <hr key={key} />;
    case 'break':
      return <br key={key} />;
    case 'link': {
      const href = safeHref(node.url);
      return href ? (
        <a key={key} href={href} target="_blank" rel="noreferrer noopener">
          {children(node, source)}
        </a>
      ) : (
        <span key={key} className="link-disabled">
          {children(node, source)}
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
      if ('children' in node) return <span key={key}>{children(node as Parents, source)}</span>;
      if ('value' in node && typeof node.value === 'string')
        return r ? leafSpan(key, r.start, r.end, node.value) : node.value;
      return null;
  }
}

export function Markdown({ source }: { source: string }) {
  const tree = useMemo(() => parseMarkdown(source), [source]);
  return <div className="md">{render(tree, source, 0)}</div>;
}
