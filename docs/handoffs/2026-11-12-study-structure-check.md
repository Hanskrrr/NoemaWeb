# Handoff 2026-11-12: a study structure, drafted and checked

The founder asked for one reusable, well-designed structure behind "asked before", margin marks and the rest, that can be exported and used elsewhere, and then asked: are you sure it is going to work? This is the draft and a first check against a real notebook. **Nothing is built and no code changed.** The decision is the founder's.

## The answer

Not sure, but less of a guess than yesterday.

- **Holds.** Everything in the founder's notebook fits the structure, with nothing left dangling, once a fourth part is added.
- **Holds, with a limit.** A passage marked on one reading of a paper is found again on a different reading of it about 4 times in 5. Passages with a formula in them are the ones that get lost.
- **Still a bet.** Whether links the AI makes are right often enough, and whether any other tool will read the export.

## The structure: four parts

| Part | What it is | In Noema today |
| --- | --- | --- |
| **Text** | A piece of writing that never changes. It has an id, a kind, who wrote it and a hash of its words. | A version of a source, a question, an answer, a block of a note |
| **Passage** | A span of one text: the words, 32 characters before and after, and where they start and end. | A side question's passage, a pinned passage |
| **Link** | Joins two things (a passage, a text or a collection). It says what kind it is, who made it (you, a rule in Noema, the AI) and where it stands (a fact, suggested, accepted, dismissed). | Spread over many columns and tables |
| **Collection** | An ordered list. | A thread, a note, a notebook |

The draft had three parts. The check showed the fourth: the order of a thread and what belongs to a note are not links.

### Link kinds

| Kind | From → to | Who makes it | Today |
| --- | --- | --- | --- |
| answers | answer → question | Noema | kept |
| asked about | thread → passage | you | kept |
| kept in view | passage → thread | you | kept (pins) |
| continued from, merged into | thread → thread | you | kept |
| written from, cites | note → thread, note → exchange | the AI | kept |
| **same question, related question** | question → exchange | a rule, or the AI | worked out each time, then forgotten |
| **met before** | passage of a new text → exchange | the AI | not built (margin marks) |

The first five are facts: they are made by using the app. The last two are suggestions: Noema or the AI proposes, you accept or dismiss, and the answer is remembered. That is the part that is new.

An **exchange** is a question, the passage it was asked about and the answer in use. It is not a fifth part: it is what you get by following "answers" and "asked about" from a question.

### One link, written out (made-up words)

The form is the W3C annotation model: a target, a body and a reason. The `noema:` fields are ours.

```json
{
  "type": "Annotation",
  "motivation": "linking",
  "noema:kind": "met-before",
  "noema:status": "suggested",
  "creator": { "type": "Software", "name": "the chat model" },
  "target": {
    "source": "https://example.org/a-new-paper",
    "selector": {
      "type": "TextQuoteSelector",
      "exact": "the softmax turns scores into weights",
      "prefix": "In attention, ",
      "suffix": ", so each row"
    }
  },
  "body": { "source": "noema:exchange/01JEXAMPLE", "noema:label": "What does the softmax do?" }
}
```

### Why one structure

Five things in the app ask the same question, "what is joined to this passage?", in five separate pieces of code: the marks on an answer where side questions were asked, pins, a note's citations, asked before, and (if built) margin marks. With links, they are one lookup. That is also what makes it exportable: one list of links, not thirteen tables.

## The check

Run on a copy of the founder's notebook on his Mac. Only counts left the machine.

**Does everything fit?**

| | Count |
| --- | --- |
| Texts | 389 (1 source version, 52 questions and answers, 336 note blocks) |
| Passages | 12 (9 in answers, 3 in the paper) |
| Links | 86 (26 answers, 12 asked about, 9 merged into, 4 written from, 35 cites) |
| Collections | 28 (1 notebook, 18 threads, 8 notes, 1 source) |
| Passages pointing at a text that is missing | 0 |
| Passages no link uses | 0 |
| Tables the check did not look at | 0 |

Left outside on purpose, because they are the app's history and not study: what was sent with each answer (26), the log of actions (161), earlier versions of notes (21), the Trash (2). They stay in Noema's full export. Titles and one-line summaries (44) become a label on a text or a collection.

**Can a passage be found without its position?** Another tool will not have our positions, only the words. All 12 real passages were found in the right place from the words alone: 7 because the words occur once, 5 by the 32 characters around them. None wrong.

**Does a passage carry to another reading of the same paper?** The paper was read once by the first reader and again, on the copy, by the current one: 226,313 and 224,262 characters, the same only for the first 15,528. 3,000 passages were taken at random from the first reading and looked for in the second.

| Passage length | Found | In more than one place | Not found |
| --- | --- | --- | --- |
| 4 characters | 458 of 500 | 42 | 0 |
| 12 | 432 | 44 | 24 |
| 40 | 440 | 18 | 42 |
| 120 | 418 | 7 | 75 |
| 400 | 383 | 0 | 117 |
| 1,200 | 308 | 0 | 192 |
| **All** | **2,439 of 3,000 (81%)** | 111 | 450 |

Of the 450 not found, 441 had a formula in them: the two readers write the same formula differently. Of those found in a new place, 2,121 had all 64 characters around them matching; the other 111 matched on part of them and were not checked by hand. "In more than one place" is shown as unresolved, never guessed.

## What the check changed in the design

1. **Collections are a part.** See above.
2. **A passage means nothing without its text.** The founder's passages in answers are short: six of the nine are 4 characters or fewer, three are 2. So an export always carries the text a passage is in, or for a public page its address and hash. A passage in an AI answer can only be shared by sharing the answer.
3. **A question is not its words.** Two short questions occur 3 and 4 times, word for word, as different questions. So "same question" and "met before" link to exchanges, not to the question's words. The meaning check already reads them that way.
4. **Formulas need one written form** before passages with formulas can travel. Not solved.

## Not tested

- One notebook, 12 real passages, one paper. No pins and no second version of a source in it.
- The 3,000 passages were random spans, not what a learner selects.
- No link made by a real model: `pnpm asked:check` on the Mac is still to run.
- No other tool has read the JSON. The W3C form lowers that risk; it does not remove it.
- Two people's notebooks joined on the same paper: not tried.

## Next, if the founder agrees

Each step is small and can be undone. None is started.

1. **Export the study structure**: one JSON file in the form above, built from the tables as they are. No change to the store. It proves the format on real use and is the first thing another tool, or another person, could read.
2. **Remember asked-before answers as links**: "yes, the same" or "no, different", so a dismissed reminder stays dismissed. The first suggested links. One new table.
3. **Margin marks**, stored as "met before" links.

Links between passages are close to the "knowledge graphs" line in the scope fence (AGENTS.md). Steps 2 and 3 need the founder's word, like ADR 0020 did.

The check script is not in the repository. It reads a copy of the store and prints counts; it can be added as `pnpm structure:check` if wanted.
