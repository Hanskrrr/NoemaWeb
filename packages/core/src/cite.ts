// Citations in notes. A note cites the exchanges it came from as plain text
// labels, [E3], one label per bracket; the note keeps a map from each label
// to the exact message. Plain labels keep the note readable when edited, and
// a label the learner types or moves still works.

/** The one form notes use. */
const LABEL = /\[(E\d{1,4})\]/g;

/** The model's variants ([E1, E3], 【E1】, ［E1］) in the one form: [E1][E3]. */
export function normalizeCitations(text: string): string {
  return text.replace(
    /[[【［]\s*(E\d{1,4}(?:\s*[,，、;；]\s*E\d{1,4})*)\s*[\]】］](?!\()/g,
    (_whole, inner: string) =>
      inner
        .split(/\s*[,，、;；]\s*/)
        .map((label) => `[${label}]`)
        .join(''),
  );
}

/** Text split into plain runs and the labels that have a target. */
export function splitCitations(text: string, known: (label: string) => boolean): Array<string | { label: string }> {
  const out: Array<string | { label: string }> = [];
  let last = 0;
  for (const m of text.matchAll(LABEL)) {
    const label = m[1] as string;
    if (!known(label)) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ label });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
