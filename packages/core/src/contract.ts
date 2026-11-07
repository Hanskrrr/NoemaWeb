// The HTTP contract between apps/web and apps/server, as Zod schemas.
// The server validates every request body with these; the client parses
// every response with them, so a drift between the two fails loudly.

import { z } from 'zod';
import { isUlid } from './ids.ts';

export const Id = z.string().refine(isUlid, 'expected a ULID');

export const MessageStatus = z.enum(['pending', 'streaming', 'done', 'failed', 'interrupted', 'stopped']);
export type MessageStatus = z.infer<typeof MessageStatus>;

export const ErrorKind = z.enum([
  'auth',
  'rate_limit',
  'quota',
  'unavailable',
  'bad_request',
  'timeout',
  'network',
  'aborted',
  'context_too_large',
  'not_configured',
  'internal',
]);
export type ErrorKind = z.infer<typeof ErrorKind>;

export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

export const Notebook = z.object({
  id: Id,
  title: z.string(),
  aboutMe: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Notebook = z.infer<typeof Notebook>;

export const Thread = z.object({
  id: Id,
  notebookId: Id,
  /** Set for a branch: the thread it was asked from. */
  parentThreadId: Id.nullable(),
  /** For a branch: the passage it started from, shortened. */
  originQuote: z.string().nullable(),
  /**
   * When a branch was made its own thread: it is listed at the top level, has
   * its own map and notes, and no longer sends the parent conversation to the
   * model, only the passage it came from. Null for a branch still in place.
   */
  splitAt: z.string().nullable(),
  /** The thread this one was last merged into (and not undone), if any. */
  mergedIntoId: Id.nullable(),
  /** "New thread from here": the thread this one was split off from, at one of its questions. */
  continuedFromId: Id.nullable(),
  /** In the Trash since then; restoring brings it back as it was. */
  deletedAt: z.string().nullable(),
  /** Asked about a passage of a source: that source, the version it was asked about, and the passage, shortened. */
  sourceId: Id.nullable(),
  sourceVersionId: Id.nullable(),
  sourceQuote: z.string().nullable(),
  title: z.string(),
  /** question: the first question; model: written by the AI; user: renamed by the learner. */
  titleSource: z.enum(['question', 'model', 'user']),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Thread = z.infer<typeof Thread>;

export const MessageError = z.object({ kind: ErrorKind, message: z.string() });
export type MessageError = z.infer<typeof MessageError>;

export const Message = z.object({
  id: Id,
  threadId: Id,
  role: z.enum(['user', 'assistant']),
  seq: z.number().int().nonnegative(),
  /** For an assistant message: the user message it answers. */
  replyTo: Id.nullable(),
  revisionId: Id,
  /** 1 for the first answer, 2+ after regenerate. Old revisions are kept. */
  revision: z.number().int().positive(),
  content: z.string(),
  status: MessageStatus,
  error: MessageError.nullable(),
  model: z.string().nullable(),
  /**
   * For a finished answer: one short line, written by the model, saying what
   * the exchange established. Shown on the map and in the catalog; null until written.
   */
  headline: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Message = z.infer<typeof Message>;

/** Where a branch starts: a span of one immutable message revision (W3C quote + position). */
export const AnchorRef = z.object({
  messageId: Id,
  revisionId: Id,
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  exact: z.string(),
  prefix: z.string(),
  suffix: z.string(),
});
export type AnchorRef = z.infer<typeof AnchorRef>;

export const BranchSummary = z.object({
  threadId: Id,
  title: z.string(),
  createdAt: z.string(),
  anchor: AnchorRef,
});
export type BranchSummary = z.infer<typeof BranchSummary>;

export const Origin = z.object({ parentThreadId: Id, parentTitle: z.string(), anchor: AnchorRef });
export type Origin = z.infer<typeof Origin>;

// Sources: what the learner reads. Its text is an immutable Markdown version;
// a passage is anchored into the version that was shown.

/** A passage of one version of a source (W3C quote and position selectors). */
export const SourcePassage = z.object({
  versionId: Id,
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  exact: z.string(),
  prefix: z.string(),
  suffix: z.string(),
});
export type SourcePassage = z.infer<typeof SourcePassage>;

export const Source = z.object({
  id: Id,
  notebookId: Id,
  title: z.string(),
  /** Where it was fetched from (as the learner gave it), or null when pasted. */
  url: z.string().nullable(),
  latestVersionId: Id,
  versions: z.number().int().positive(),
  /** Threads asked about its passages (not in the Trash). */
  threads: z.number().int().nonnegative(),
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Source = z.infer<typeof Source>;

export const SourceList = z.object({ sources: z.array(Source) });
export type SourceList = z.infer<typeof SourceList>;

export const SourceVersion = z.object({
  id: Id,
  sourceId: Id,
  seq: z.number().int().positive(),
  /** The Markdown shown and anchored into. Never changes. */
  content: z.string(),
  origin: z.enum(['paste', 'url']),
  /** The address actually read (after redirects, or an arXiv paper's HTML), if fetched. */
  fetchedUrl: z.string().nullable(),
  createdAt: z.string(),
});
export type SourceVersion = z.infer<typeof SourceVersion>;

export const SourceDetail = z.object({
  source: Source,
  version: SourceVersion,
  /** Every version, newest first. */
  versions: z.array(z.object({ id: Id, seq: z.number().int(), createdAt: z.string() })),
  /** Threads asked about passages of this version, in the order asked. */
  threads: z.array(
    z.object({
      threadId: Id,
      title: z.string(),
      createdAt: z.string(),
      passage: SourcePassage,
      /** Questions asked in it and in its side questions: how hard the passage was. */
      questions: z.number().int().nonnegative(),
    }),
  ),
  /** Threads asked about other versions of it. */
  elsewhere: z.number().int().nonnegative(),
});
export type SourceDetail = z.infer<typeof SourceDetail>;

/** Paste text (Markdown, or HTML already turned into it), or give an address to fetch. */
export const CreateSourceRequest = z
  .object({
    id: Id,
    title: z.string().trim().max(300).optional(),
    text: z.string().max(2_000_000).optional(),
    url: z.string().trim().url().max(2000).optional(),
  })
  .refine((r) => (r.text !== undefined && r.text.trim() !== '') !== (r.url !== undefined), {
    message: 'give either text or an address',
  });
export type CreateSourceRequest = z.infer<typeof CreateSourceRequest>;

export const RenameSourceRequest = z.object({ title: z.string().trim().min(1).max(300) });

/** Fetch a source again: a new version if its text changed. */
export const RefetchResponse = z.object({ source: Source, changed: z.boolean() });
export type RefetchResponse = z.infer<typeof RefetchResponse>;

/** For a thread asked about a passage of a source: where, in which version. */
export const SourceOrigin = z.object({
  sourceId: Id,
  sourceTitle: z.string(),
  url: z.string().nullable(),
  passage: SourcePassage,
  /** The version shown now; when it differs, the passage was asked about an earlier one. */
  latestVersionId: Id,
  deleted: z.boolean(),
});
export type SourceOrigin = z.infer<typeof SourceOrigin>;


/** Where a citation label in a note or a merge ([E3]) points: the exact message it came from. */
export const CiteRef = z.object({ threadId: Id, messageId: Id });
export const CiteRefs = z.record(z.string().regex(/^E\d{1,4}$/), CiteRef);
export type CiteRefs = z.infer<typeof CiteRefs>;

// Merges: one thread carried into another, like a merge commit. Nothing is
// rewritten: the AI drafts a summary (or the exchanges are taken as they
// are), the learner edits and accepts it, and from then on it goes in front
// of the target's next question. The card is shown where the source left
// from (for a side question) or where the merge happened.
export const MergeStatus = z.enum(['drafting', 'draft', 'failed', 'merged', 'undone', 'discarded']);
export const MergeMode = z.enum(['summary', 'full']);
export type MergeMode = z.infer<typeof MergeMode>;
export const Merge = z.object({
  id: Id,
  sourceThreadId: Id,
  targetThreadId: Id,
  sourceTitle: z.string(),
  targetTitle: z.string(),
  mode: MergeMode,
  /** Markdown with [E#] citations into the source. */
  summary: z.string(),
  refs: CiteRefs,
  status: MergeStatus,
  error: z.string().nullable(),
  /** When reading the target, the card sits after this message (null: before the first). */
  afterMessageId: Id.nullable(),
  /** For a side question merged back: the passage it came from. */
  quote: z.string().nullable(),
  /** ...and where that passage is, so the card can sit right after it. */
  anchor: AnchorRef.nullable(),
  /** An earlier merge of the same thread into the same target, which accepting this one replaces. */
  replaces: Id.nullable(),
  createdAt: z.string(),
  mergedAt: z.string().nullable(),
});
export type Merge = z.infer<typeof Merge>;
export const StartMergeRequest = z.object({ id: Id, into: Id, mode: MergeMode.default('summary') });
export const EditMergeRequest = z.object({ summary: z.string().trim().min(1).max(20_000) });
export const RedraftMergeRequest = z.object({ mode: MergeMode });

/** One thread split off from another at a question ("New thread from here"). */
export const Continuation = z.object({ threadId: Id, title: z.string() });
export type Continuation = z.infer<typeof Continuation>;

export const ContinuedFrom = Continuation.extend({
  /** Joining back puts the questions back where they were; only while the original has nothing newer. */
  canJoinBack: z.boolean(),
  /** Why not, in a sentence, when it can't. */
  joinBackBlocked: z.string().nullable(),
});
export type ContinuedFrom = z.infer<typeof ContinuedFrom>;

/** "New thread from here": the question `messageId` and everything after it move into a new thread `id`. */
export const SplitOffRequest = z.object({ id: Id, messageId: Id });
export type SplitOffRequest = z.infer<typeof SplitOffRequest>;

export const ThreadDetail = z.object({
  thread: Thread,
  messages: z.array(Message),
  /** Branches that start in this thread's messages. */
  branches: z.array(BranchSummary),
  /** For a branch: where it starts. */
  origin: Origin.nullable(),
  /** Ancestors, outermost first, for the breadcrumb. */
  path: z.array(z.object({ id: Id, title: z.string() })),
  /** Threads merged into this one. */
  merges: z.array(Merge),
  /** This thread's merges into others: a draft being prepared, and merges done. */
  outgoing: z.array(Merge),
  /** Split off from another thread: that thread, and whether it can join back now. */
  continuedFrom: ContinuedFrom.nullable(),
  /** Threads split off from this one: they continue where it ends. */
  continuedIn: z.array(Continuation),
  /** Asked about a passage of a source. */
  sourceOrigin: SourceOrigin.nullable(),
});
export type ThreadDetail = z.infer<typeof ThreadDetail>;

export const NotebookList = z.object({ notebooks: z.array(Notebook) });
export const ThreadList = z.object({ threads: z.array(Thread) });

export const CreateThreadRequest = z.object({ id: Id, title: z.string().max(200).default('') });
export type CreateThreadRequest = z.infer<typeof CreateThreadRequest>;

export const RenameThreadRequest = z.object({ title: z.string().trim().min(1).max(200) });
export type RenameThreadRequest = z.infer<typeof RenameThreadRequest>;

/** Make a branch its own thread (split: true), or put it back (split: false). */
export const SplitThreadRequest = z.object({ split: z.boolean() });

// The map of a thread: every exchange in order, with the branches that left
// from it hung on the exact message and passage, nested. Built from stored
// content only; no model involved.
export interface MapExchange {
  index: number;
  questionId: string;
  question: string;
  answerId: string | null;
  /** What the exchange established, in a line (the model's); null until written. */
  headline: string | null;
  /** The start of the answer, as plain text. */
  gist: string;
  status: MessageStatus;
  branches: MapNode[];
}
export interface MapNode {
  threadId: string;
  title: string;
  /** For a branch: where it left from. */
  origin: { messageId: string; exact: string } | null;
  /** A branch made its own thread: shown as a link, its exchanges are on its own map. */
  split: boolean;
  /** Merged into another thread (its summary is there). */
  mergedIntoId: string | null;
  exchanges: MapExchange[];
}
const MapExchangeSchema: z.ZodType<MapExchange> = z.lazy(() =>
  z.object({
    index: z.number().int(),
    questionId: Id,
    question: z.string(),
    answerId: Id.nullable(),
    headline: z.string().nullable(),
    gist: z.string(),
    status: MessageStatus,
    branches: z.array(MapNodeSchema),
  }),
);
export const MapNodeSchema: z.ZodType<MapNode> = z.lazy(() =>
  z.object({
    threadId: Id,
    title: z.string(),
    origin: z.object({ messageId: Id, exact: z.string() }).nullable(),
    split: z.boolean(),
    mergedIntoId: Id.nullable(),
    exchanges: z.array(MapExchangeSchema),
  }),
);
/**
 * The map of one thread and the branches below it. `path` is the threads
 * above it, outermost first, up to the top or to a thread made its own; each
 * has its own map.
 */
export const ThreadMap = z.object({
  root: MapNodeSchema,
  path: z.array(z.object({ threadId: Id, title: z.string() })),
  /** Where the root came from, when it is a branch or was one. */
  parent: z.object({ threadId: Id, title: z.string() }).nullable(),
  /** The thread the root was split off from, and the threads split off from it. */
  continuedFrom: Continuation.nullable(),
  continuedIn: z.array(Continuation),
});
export type ThreadMap = z.infer<typeof ThreadMap>;

// Notes: a document of blocks (paragraphs, lists, tables, formulas, code)
// that the learner edits in place. The AI can write a whole note from a
// thread, or suggest one block, which the learner accepts or discards. It
// never replaces the chat; every version is kept.
export const NoteStatus = z.enum(['generating', 'done', 'failed']);
export const NoteAuthor = z.enum(['ai', 'user', 'ai+user']);
export type NoteAuthor = z.infer<typeof NoteAuthor>;
export const ProposalStatus = z.enum(['generating', 'ready', 'failed']);
/** An AI suggestion for a block, waiting for the learner. It never changes the block by itself. */
export const Proposal = z.object({
  status: ProposalStatus,
  text: z.string(),
  /** What the learner asked for. */
  instruction: z.string(),
  error: z.string().nullable(),
});
export type Proposal = z.infer<typeof Proposal>;
export const NoteBlock = z.object({
  id: Id,
  /** Markdown. Empty only for a new block whose AI suggestion is not yet accepted. */
  content: z.string(),
  /** ai: written by the model; user: by the learner; ai+user: AI text the learner edited (or the reverse). */
  author: NoteAuthor,
  proposal: Proposal.nullable(),
});
export type NoteBlock = z.infer<typeof NoteBlock>;
export const Note = z.object({
  id: Id,
  notebookId: Id,
  threadId: Id.nullable(),
  title: z.string(),
  /** The blocks joined as one Markdown document (for export, and while the AI writes the whole note). */
  content: z.string(),
  /** In order. Empty while the AI writes the whole note. */
  blocks: z.array(NoteBlock),
  /** Citation labels in the content and the exchanges they point at. */
  refs: CiteRefs,
  status: NoteStatus,
  error: z.string().nullable(),
  /** ai: as written by the model; user: written by the learner; ai+user: both. */
  author: NoteAuthor,
  revision: z.number().int().nonnegative(),
  /** In the Trash since then; restoring brings it back as it was. */
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Note = z.infer<typeof Note>;
export const NoteSummary = Note.omit({ content: true, blocks: true, refs: true });

/** What is in the Trash: threads (each with the side questions that went with it) and notes, last deleted first. */
export const Trash = z.object({
  threads: z.array(
    z.object({ threadId: Id, title: z.string(), deletedAt: z.string(), sideQuestions: z.number().int().nonnegative() }),
  ),
  notes: z.array(z.object({ noteId: Id, title: z.string(), deletedAt: z.string() })),
  sources: z.array(z.object({ sourceId: Id, title: z.string(), deletedAt: z.string() })),
});
export type Trash = z.infer<typeof Trash>;

export const DeleteThreadResponse = z.object({
  ok: z.literal(true),
  /** The thread and the side questions that went to the Trash with it. */
  deleted: z.number().int().nonnegative(),
});
export type DeleteThreadResponse = z.infer<typeof DeleteThreadResponse>;
export type NoteSummary = z.infer<typeof NoteSummary>;
export const NoteList = z.object({ notes: z.array(NoteSummary) });
export const RewriteRequest = z.object({ id: Id });
/** A note the learner starts from nothing. */
export const CreateNoteRequest = z.object({ id: Id, title: z.string().trim().max(200).default('') });
const BlockText = z.string().max(100_000);
const Instruction = z.string().trim().min(1).max(1000);
/**
 * Add a block after `after` (null: at the top). Either the learner's own
 * `content`, or `ask`: the AI writes a suggestion for this place.
 */
export const InsertBlockRequest = z
  .object({ id: Id, after: Id.nullable(), content: BlockText.optional(), ask: Instruction.optional() })
  .refine((v) => (v.content === undefined) !== (v.ask === undefined), 'give content or ask, not both');
export type InsertBlockRequest = z.infer<typeof InsertBlockRequest>;
export const EditBlockRequest = z.object({ content: BlockText });
export const MoveBlockRequest = z.object({ after: Id.nullable() });
/** Ask the AI to suggest a new version of a block. */
export const SuggestRequest = z.object({ instruction: Instruction });
/** Move blocks out into a new note (a section, or everything from one block down). */
export const MoveOutRequest = z.object({ id: Id, blockIds: z.array(Id).min(1).max(5000) });
/** Bring every block of another note into this one, after `after` (null: at the end). The other note is removed. */
export const MergeNoteRequest = z.object({ from: Id, after: Id.nullable().default(null) });
/** Rename a note. Its text changes block by block. */
export const UpdateNoteRequest = z.object({ title: z.string().trim().min(1).max(200) });
export type UpdateNoteRequest = z.infer<typeof UpdateNoteRequest>;
export const NoteRevision = z.object({
  n: z.number().int(),
  author: z.string(),
  /** What happened, in a few words: "edited a block", "accepted a suggestion". */
  change: z.string(),
  createdAt: z.string(),
  chars: z.number().int(),
});
export const NoteHistory = z.object({ revisions: z.array(NoteRevision) });

/** What was sent to the model for one answer (its latest call): the manifest, and the exact messages when recorded. */
export const MessageContext = z.object({
  messageId: Id,
  revisionId: Id,
  provider: z.string(),
  model: z.string(),
  startedAt: z.string(),
  finishReason: z.string().nullable(),
  usage: z.object({
    promptTokens: z.number().int().nullable(),
    completionTokens: z.number().int().nullable(),
    cacheHitTokens: z.number().int().nullable(),
    cacheMissTokens: z.number().int().nullable(),
  }),
  manifest: z.object({
    parts: z.array(
      z.object({
        kind: z.enum(['system', 'about_me', 'source', 'inherited', 'history', 'origin', 'merged', 'question']),
        id: z.string().optional(),
        role: z.enum(['user', 'assistant']).optional(),
        tokens: z.number(),
      }),
    ),
    omitted: z.array(z.object({ id: z.string(), tokens: z.number(), reason: z.literal('budget') })),
    estimatedTokens: z.number(),
    budgetTokens: z.number(),
  }),
  /** Null for answers from before the exact messages were recorded. */
  request: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() })).nullable(),
});
export type MessageContext = z.infer<typeof MessageContext>;

export const UpdateNotebookRequest = z
  .object({ title: z.string().min(1).max(200), aboutMe: z.string().max(4000) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type UpdateNotebookRequest = z.infer<typeof UpdateNotebookRequest>;

/** The client makes the user message id, so a retried POST cannot ask twice. */
export const AskRequest = z.object({
  id: Id,
  content: z.string().trim().min(1).max(100_000),
});
export type AskRequest = z.infer<typeof AskRequest>;
export const SourceThreadRequest = z.object({
  id: Id,
  passage: z.object({ versionId: Id, start: z.number().int().nonnegative(), end: z.number().int().positive() }),
  question: AskRequest,
});
export type SourceThreadRequest = z.infer<typeof SourceThreadRequest>;

/**
 * Open a branch from a passage and ask its first question, in one request.
 * The server computes the quote from the stored revision; the client only
 * says which message and which offsets.
 */
export const CreateBranchRequest = z.object({
  id: Id,
  anchor: z.object({
    messageId: Id,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  }),
  question: AskRequest,
});
export type CreateBranchRequest = z.infer<typeof CreateBranchRequest>;

export const AskResponse = z.object({ user: Message, assistant: Message });
export type AskResponse = z.infer<typeof AskResponse>;

export const CreateBranchResponse = z.object({ thread: Thread, user: Message, assistant: Message });
export type CreateBranchResponse = z.infer<typeof CreateBranchResponse>;

export const StopResponse = z.object({ stopping: z.boolean(), message: Message });
export type StopResponse = z.infer<typeof StopResponse>;

export const SearchHit = z.object({
  /** A thread's title, a question or answer, a note's title, or a block of a note. */
  kind: z.enum(['message', 'thread', 'note', 'block', 'source', 'passage']),
  threadId: Id.nullable(),
  messageId: Id.nullable(),
  noteId: Id.nullable(),
  blockId: Id.nullable(),
  /** For a source or a passage of it: the version, and where the passage starts in it. */
  sourceId: Id.nullable(),
  versionId: Id.nullable(),
  offset: z.number().int().nonnegative().nullable(),
  /** For a message: the learner's question or the AI's answer. */
  role: z.enum(['user', 'assistant']).nullable(),
  /** The thread's or the note's title. */
  title: z.string(),
  /** The threads above a side question, top first: where it is. */
  path: z.array(z.object({ threadId: Id, title: z.string() })),
  /** For an answer: its one-line headline, if written. */
  headline: z.string().nullable(),
  /** When it was asked, answered or last changed. */
  at: z.string(),
  snippet: z.string(),
  matches: z.array(z.object({ start: z.number().int(), end: z.number().int() })),
});
export type SearchHit = z.infer<typeof SearchHit>;

/** Logged when a search hit is opened: what kind, at what rank, how long the query was. Never its words. */
export const SearchOpenedRequest = z.object({
  kind: z.enum(['message', 'thread', 'note', 'block', 'source', 'passage']),
  rank: z.number().int().nonnegative().max(100),
  queryChars: z.number().int().nonnegative().max(200),
});
export type SearchOpenedRequest = z.infer<typeof SearchOpenedRequest>;

export const SearchResponse = z.object({
  query: z.string(),
  /** The words searched for, to mark them where a hit opens. */
  terms: z.array(z.string()),
  hits: z.array(SearchHit),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

/** A side question with no way back taken after its last exchange: no return, no later question above it, not set aside. */
export const OpenBranch = z.object({
  threadId: Id,
  title: z.string(),
  parentThreadId: Id,
  parentTitle: z.string(),
  quote: z.string().nullable(),
  lastAt: z.string(),
});
export type OpenBranch = z.infer<typeof OpenBranch>;

export const OpenBranchesResponse = z.object({ branches: z.array(OpenBranch) });
export type OpenBranchesResponse = z.infer<typeof OpenBranchesResponse>;

export const Health = z.object({
  ok: z.literal(true),
  version: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  /** False until an API key is saved: the app shows the connect screen. */
  configured: z.boolean(),
});
export type Health = z.infer<typeof Health>;

// Model settings. The API key goes to the server once and never comes back:
// the view only says whether a key is saved and shows its last characters.
export const ModelSettingsView = z.object({
  provider: z.enum(['openai-compatible', 'fake']),
  baseUrl: z.string(),
  model: z.string(),
  hasKey: z.boolean(),
  keyHint: z.string().nullable(),
  /** saved: entered in the app. environment: from .env or the defaults. */
  source: z.enum(['saved', 'environment']),
  configured: z.boolean(),
});
export type ModelSettingsView = z.infer<typeof ModelSettingsView>;

export const UpdateModelSettingsRequest = z.object({
  baseUrl: z
    .string()
    .trim()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), 'must start with http:// or https://'),
  model: z.string().trim().min(1).max(200),
  /** Omit to keep the key that is already saved. */
  apiKey: z.string().trim().min(1).max(1000).optional(),
});
export type UpdateModelSettingsRequest = z.infer<typeof UpdateModelSettingsRequest>;

export const ModelSettingsResponse = z.object({
  settings: ModelSettingsView,
  /** Model ids the provider listed when the key was checked; may be empty. */
  available: z.array(z.string()),
});
export type ModelSettingsResponse = z.infer<typeof ModelSettingsResponse>;

// Server-sent events on GET /api/messages/:id/events.
// Every connection starts with a snapshot of everything so far, then deltas,
// so a reload or a dropped connection can never duplicate or lose text.
export const StreamSnapshot = z.object({ message: Message });
export const StreamDelta = z.object({ text: z.string() });
export const StreamStatus = z.object({ status: MessageStatus, error: MessageError.nullable() });
export type StreamSnapshot = z.infer<typeof StreamSnapshot>;
export type StreamDelta = z.infer<typeof StreamDelta>;
export type StreamStatus = z.infer<typeof StreamStatus>;
export const STREAM_EVENTS = ['snapshot', 'delta', 'status', 'end'] as const;

/** Sent on every state-changing request; the server rejects requests without it. */
export const CLIENT_HEADER = 'x-noema-client';
export const CLIENT_HEADER_VALUE = 'web';
