// Board presentation, local to this browser and room. The notebook owns the actual relationships.
import type { ItemLink, RoomView } from '@noema/core';

export const BOARD_SIZE = { minWidth: 220, maxWidth: 520, minHeight: 84, maxHeight: 440 };
export type CardSize = { w: number; h: number };
export type BoardPreferences = {
  mode?: 'topics' | 'free';
  /** Compact shows titles and structure only: no summaries, no counts, no words on the lines. */
  density?: 'compact' | 'normal';
  order?: string[];
  sizes?: Record<string, CardSize>;
  parents?: Record<string, string>;
  collapsed?: Record<string, boolean>;
};

type Cluster = RoomView['clusters'][number];
type BoardTopic = { id: string; title: string };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(value)));

export function resizeCard(width: number, height: number): CardSize {
  return {
    w: clamp(width, BOARD_SIZE.minWidth, BOARD_SIZE.maxWidth),
    h: clamp(height, BOARD_SIZE.minHeight, BOARD_SIZE.maxHeight),
  };
}

export function linkCardKey(ref: ItemLink['from']): string {
  return `${ref.kind}:${ref.id}`;
}

/** Containment is a Board arrangement between materials, independent of their links. */
export function boardParents(clusters: Cluster[], preferences: BoardPreferences): Map<string, string> {
  const cards = new Set(clusters.flatMap(({ cards }) => cards.map(linkCardKey)));
  const parents = new Map(Object.entries(preferences.parents ?? {})
    .filter(([child, parent]) => child !== parent && cards.has(child) && cards.has(parent)));
  return new Map([...parents].filter(([, parent]) => !parents.has(parent)));
}

export function boardTopicGroups(
  clusters: Cluster[],
  doorKeys: string[],
  topicsByCard: Map<string, BoardTopic[]>,
  order: string[],
): Array<{ id: string; title: string; keys: string[] }> {
  const loose = { id: '', title: 'Ungrouped', keys: [...doorKeys] };
  const topics = new Map<string, { id: string; title: string; keys: string[] }>();
  for (const cluster of clusters) {
    const primary = cluster.cards.flatMap((card) => topicsByCard.get(linkCardKey(card)) ?? [])[0];
    if (!primary) {
      loose.keys.push(cluster.key);
      continue;
    }
    const group = topics.get(primary.id) ?? { ...primary, keys: [] };
    group.keys.push(cluster.key);
    topics.set(primary.id, group);
  }
  const index = new Map(order.map((key, i) => [key, i]));
  const grouped = [...topics.values()].sort((a, b) => a.title.localeCompare(b.title));
  if (loose.keys.length > 0) grouped.push(loose);
  return grouped.map((group) => ({
    ...group,
    keys: group.keys.sort((a, b) => (index.get(a) ?? Infinity) - (index.get(b) ?? Infinity)),
  }));
}
