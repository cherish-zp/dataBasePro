import { describe, expect, it } from 'vitest'
import { moveId, reorderIds } from './connReorder'

describe('moveId', () => {
  it('moves a middle connection up by one', () => {
    expect(moveId(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
  })

  it('moves a middle connection down by one', () => {
    expect(moveId(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
  })

  it('returns the original order when moving the first connection up', () => {
    expect(moveId(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c'])
  })

  it('returns the original order when moving the last connection down', () => {
    expect(moveId(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c'])
  })

  it('returns the original order when the id does not exist', () => {
    expect(moveId(['a', 'b'], 'x', -1)).toEqual(['a', 'b'])
  })
})

describe('reorderIds', () => {
  it('inserts before the target connection', () => {
    expect(reorderIds(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b'])
  })

  it('inserts after the target connection', () => {
    expect(reorderIds(['a', 'b', 'c'], 'a', 'c', 'after')).toEqual(['b', 'c', 'a'])
  })

  it('returns the original order when source equals target', () => {
    expect(reorderIds(['a', 'b', 'c'], 'b', 'b', 'after')).toEqual(['a', 'b', 'c'])
  })

  it('returns the original order when source or target is missing', () => {
    expect(reorderIds(['a', 'b'], 'x', 'a', 'before')).toEqual(['a', 'b'])
    expect(reorderIds(['a', 'b'], 'a', 'x', 'before')).toEqual(['a', 'b'])
  })

  it('keeps the relative order of untouched connections', () => {
    expect(reorderIds(['a', 'b', 'c', 'd'], 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd'])
  })
})
