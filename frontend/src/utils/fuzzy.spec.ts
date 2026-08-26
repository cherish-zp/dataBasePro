import { describe, expect, it } from 'vitest'
import { fuzzyMatch } from './fuzzy'

describe('fuzzyMatch', () => {
  it('matches exact substring case-insensitively', () => {
    expect(fuzzyMatch('user', 'User-Log')).toBe(true)
  })

  it('matches characters in order (subsequence / fuzzy)', () => {
    expect(fuzzyMatch('ul', 'user-log')).toBe(true)
    expect(fuzzyMatch('usr', 'user-log')).toBe(true)
    expect(fuzzyMatch('usg', 'user-log')).toBe(true)
  })

  it('rejects characters out of order', () => {
    expect(fuzzyMatch('lu', 'user-log')).toBe(false)
  })

  it('matches when query equals the text', () => {
    expect(fuzzyMatch('user-log', 'user-log')).toBe(true)
  })

  it('empty query matches everything', () => {
    expect(fuzzyMatch('', 'anything')).toBe(true)
    expect(fuzzyMatch('   ', 'anything')).toBe(true)
  })

  it('rejects when characters are missing', () => {
    expect(fuzzyMatch('xyz', 'user-log')).toBe(false)
    expect(fuzzyMatch('userlogx', 'user-log')).toBe(false)
  })

  it('matches a single character', () => {
    expect(fuzzyMatch('g', 'user-log')).toBe(true)
  })
})
