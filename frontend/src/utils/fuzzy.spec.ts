import { describe, expect, it } from 'vitest'
import { fuzzyMatch, fuzzyScore } from './fuzzy'

describe('fuzzyMatch', () => {
  it('matches exact substring case-insensitively', () => {
    expect(fuzzyMatch('user', 'User-Log')).toBe(true)
  })

  it('matches characters in order (dense subsequence / fuzzy)', () => {
    expect(fuzzyMatch('us', 'user-log')).toBe(true)
    expect(fuzzyMatch('usr', 'user-log')).toBe(true)
    expect(fuzzyMatch('srl', 'user-log')).toBe(true)
    expect(fuzzyMatch('tst', 'test_01')).toBe(true)
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

  it('does not treat a far-apart subsequence as a match', () => {
    expect(fuzzyMatch('test', 'test_01')).toBe(true)
    expect(fuzzyMatch('test', 'activeInfoResult')).toBe(false)
    expect(fuzzyMatch('test', 'ods_illegal_tyqresult')).toBe(false)
    expect(fuzzyMatch('ul', 'user-log')).toBe(false)
    expect(fuzzyMatch('usg', 'user-log')).toBe(false)
  })

  it('ranks contiguous substring matches better than loose subsequences', () => {
    expect(fuzzyScore('test', 'test_01')).toBeLessThan(fuzzyScore('usr', 'user-log'))
    expect(fuzzyScore('usr', 'user-log')).toBeLessThan(fuzzyScore('srl', 'user-log'))
    expect(fuzzyScore('test', 'ods_illegal_tyqresult')).toBe(Infinity)
  })
})
