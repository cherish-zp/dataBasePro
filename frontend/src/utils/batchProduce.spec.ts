import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildBatchMessages,
  clampCount,
  loadTemplates,
  randomKey,
  saveTemplate,
} from './batchProduce'

describe('clampCount', () => {
  it('keeps values within 1..1000', () => {
    expect(clampCount(1)).toBe(1)
    expect(clampCount(50)).toBe(50)
    expect(clampCount(0)).toBe(1)
    expect(clampCount(-5)).toBe(1)
    expect(clampCount(1001)).toBe(1000)
    expect(clampCount(3.7)).toBe(3)
    expect(clampCount(Number.NaN)).toBe(1)
  })
})

describe('randomKey', () => {
  it('uses the key- prefix and yields distinct values', () => {
    const a = randomKey()
    const b = randomKey()
    expect(a).toMatch(/^key-[0-9a-z]+$/)
    expect(b).toMatch(/^key-[0-9a-z]+$/)
    expect(a).not.toBe(b)
  })
})

describe('buildBatchMessages', () => {
  it('repeats the same value count times in loop mode', () => {
    const msgs = buildBatchMessages({ value: 'payload', key: 'k', count: 3, randomKey: false, loop: true })
    expect(msgs).toEqual([
      { key: 'k', value: 'payload' },
      { key: 'k', value: 'payload' },
      { key: 'k', value: 'payload' },
    ])
  })

  it('assigns a distinct random key to every message when randomKey is on', () => {
    const msgs = buildBatchMessages({ value: 'v', key: '', count: 3, randomKey: true, loop: true })
    expect(msgs).toHaveLength(3)
    const keys = msgs.map((m) => m.key)
    for (const k of keys) expect(k).toMatch(/^key-/)
    expect(new Set(keys).size).toBe(3)
  })

  it('expands a JSON array value into one message per element', () => {
    const msgs = buildBatchMessages({
      value: '["plain", {"x":1}]',
      key: 'k',
      count: 5,
      randomKey: false,
      loop: false,
    })
    expect(msgs).toEqual([
      { key: 'k', value: 'plain' },
      { key: 'k', value: '{"x":1}' },
    ])
  })

  it('keeps the plain value as a single message when count is 1 without loop', () => {
    const msgs = buildBatchMessages({ value: 'plain text', key: 'k', count: 1, randomKey: false, loop: false })
    expect(msgs).toEqual([{ key: 'k', value: 'plain text' }])
  })

  it('rejects non-array values in JSON array mode', () => {
    expect(() => buildBatchMessages({ value: 'nope', key: '', count: 2, randomKey: false, loop: false })).toThrow()
    expect(() => buildBatchMessages({ value: '{"a":1}', key: '', count: 2, randomKey: false, loop: false })).toThrow()
  })

  it('rejects an empty JSON array', () => {
    expect(() => buildBatchMessages({ value: '[]', key: '', count: 2, randomKey: false, loop: false })).toThrow()
  })
})

describe('recent templates', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns an empty list when nothing was stored', () => {
    expect(loadTemplates()).toEqual([])
  })

  it('keeps the most recent value first, deduped and capped at 5', () => {
    let list: string[] = []
    for (const v of ['a', 'b', 'c']) list = saveTemplate(list, v)
    expect(list).toEqual(['c', 'b', 'a'])
    list = saveTemplate(list, 'b')
    expect(list).toEqual(['b', 'c', 'a'])
    for (const v of ['d', 'e', 'f']) list = saveTemplate(list, v)
    expect(list).toEqual(['f', 'e', 'd', 'b', 'c'])
    expect(list).toHaveLength(5)
  })

  it('persists templates to localStorage and reloads them', () => {
    let list: string[] = []
    list = saveTemplate(list, 'hello')
    list = saveTemplate(list, 'world')
    expect(loadTemplates()).toEqual(['world', 'hello'])
  })
})
