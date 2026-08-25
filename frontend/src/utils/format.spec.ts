import { describe, expect, it } from 'vitest'
import { prettyJSON, formatTime, displayValue } from './format'

describe('prettyJSON', () => {
  it('formats valid JSON with indentation', () => {
    expect(prettyJSON('{"a":1,"b":[1,2]}')).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}')
  })
  it('returns the raw string for invalid JSON', () => {
    expect(prettyJSON('not json')).toBe('not json')
  })
})

describe('formatTime', () => {
  it('formats a unix-ms timestamp', () => {
    expect(formatTime(0)).toBe('-')
    expect(formatTime(1700000000000)).toMatch(/2023|2024|2025/)
  })
})

describe('displayValue', () => {
  it('falls back for empty values', () => {
    expect(displayValue('')).toBe('(empty)')
    expect(displayValue(null)).toBe('(empty)')
    expect(displayValue(undefined)).toBe('(empty)')
    expect(displayValue('hello')).toBe('hello')
  })
})
