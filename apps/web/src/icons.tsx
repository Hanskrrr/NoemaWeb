// Line icons for the sidebar's rail, drawn in the text colour.

import type { ReactNode } from 'react';

const Svg = ({ children }: { children: ReactNode }) => (
  <svg
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
);

/** Threads: a conversation. */
export const ThreadsIcon = () => (
  <Svg>
    <path d="M4 5.5h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-3.5 3v-3H4a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z" />
    <path d="M17 9.5h3a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-1v2.5L16 18.5h-3" />
  </Svg>
);

/** Sources: an open book. */
export const SourcesIcon = () => (
  <Svg>
    <path d="M12 6.5C10.3 5.2 7.8 4.6 4 4.6v13.6c3.8 0 6.3.6 8 1.9 1.7-1.3 4.2-1.9 8-1.9V4.6c-3.8 0-6.3.6-8 1.9Z" />
    <path d="M12 6.5v13.6" />
  </Svg>
);

/** Notes: a page with lines. */
export const NotesIcon = () => (
  <Svg>
    <path d="M6 3h8.5L19 7.5V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
    <path d="M14 3v5h5M8.5 12h7M8.5 15.5h7M8.5 9h3" />
  </Svg>
);

/** Files: a folder. */
export const FilesIcon = () => (
  <Svg>
    <path d="M3 6.5a1.5 1.5 0 0 1 1.5-1.5h4.3l2 2.2h8.7A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z" />
    <path d="M3 10h18" />
  </Svg>
);

/** The Trash. */
export const TrashIcon = () => (
  <Svg>
    <path d="M4 6.5h16M9.5 6.5V4.5h5v2M6.5 6.5l.9 13a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-13" />
    <path d="M10 10.5v6.5M14 10.5v6.5" />
  </Svg>
);
