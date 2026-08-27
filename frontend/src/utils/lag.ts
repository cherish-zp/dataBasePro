import type { ConsumerGroup, PartitionLag } from '@/api/types'

// One aggregated row of the global lag overview: the total backlog of a
// consumer group on one topic.
export interface GroupTopicLag {
  group: string
  topic: string
  lag: number
}

// sumLag adds up the backlog across all partitions of one topic.
export function sumLag(partitions: PartitionLag[]): number {
  return partitions.reduce((total, p) => total + p.lag, 0)
}

// flattenGroupLag turns ListConsumerGroups' nested structure
// (group → topic → partitions) into one row per group × topic with the summed
// lag, sorted by Lag descending so the biggest backlogs surface first. No new
// backend API is needed for this view.
export function flattenGroupLag(groups: ConsumerGroup[]): GroupTopicLag[] {
  const rows = groups.flatMap((g) =>
    Object.entries(g.topics ?? {}).map(([topic, partitions]) => ({
      group: g.name,
      topic,
      lag: sumLag(partitions ?? []),
    })),
  )
  rows.sort((a, b) => b.lag - a.lag)
  return rows
}
