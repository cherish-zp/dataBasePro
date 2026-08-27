import { describe, expect, it } from 'vitest'
import type { ConsumerGroup, PartitionLag } from '@/api/types'
import { flattenGroupLag, sumLag } from './lag'

const part = (lag: number): PartitionLag => ({
  partition: 0,
  current_offset: 0,
  log_end_offset: lag,
  lag,
})

describe('sumLag', () => {
  it('sums the lag of all partitions', () => {
    const parts: PartitionLag[] = [part(10), part(1), part(89)]
    expect(sumLag(parts)).toBe(100)
  })

  it('returns 0 for an empty partition list', () => {
    expect(sumLag([])).toBe(0)
  })
})

describe('flattenGroupLag', () => {
  it('flattens groups into one summed row per group × topic', () => {
    const groups: ConsumerGroup[] = [
      {
        name: 'grp-1',
        state: 'Stable',
        topics: {
          orders: [part(70), part(40)],
          payments: [part(1)],
        },
      },
    ]
    expect(flattenGroupLag(groups)).toEqual([
      { group: 'grp-1', topic: 'orders', lag: 110 },
      { group: 'grp-1', topic: 'payments', lag: 1 },
    ])
  })

  it('sorts rows by lag descending so the biggest backlogs come first', () => {
    const groups: ConsumerGroup[] = [
      {
        name: 'g-a',
        state: 'Stable',
        topics: { orders: [part(150)], events: [part(2)] },
      },
      {
        name: 'g-b',
        state: 'Empty',
        topics: { payments: [part(2000)] },
      },
    ]
    expect(flattenGroupLag(groups).map((r) => r.lag)).toEqual([2000, 150, 2])
    expect(flattenGroupLag(groups)[2]).toEqual({ group: 'g-a', topic: 'events', lag: 2 })
  })

  it('keeps the same group × topic pair of different groups distinct', () => {
    const groups: ConsumerGroup[] = [
      { name: 'g-a', state: 'Stable', topics: { orders: [part(3)] } },
      { name: 'g-b', state: 'Stable', topics: { orders: [part(9)] } },
    ]
    expect(flattenGroupLag(groups)).toEqual([
      { group: 'g-b', topic: 'orders', lag: 9 },
      { group: 'g-a', topic: 'orders', lag: 3 },
    ])
  })

  it('yields no rows for groups without topics', () => {
    const groups: ConsumerGroup[] = [
      { name: 'g-empty', state: 'Empty', topics: {} },
    ]
    expect(flattenGroupLag(groups)).toEqual([])
  })
})
