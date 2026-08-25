import { describe, expect, it } from 'vitest'
import type { Message } from '@/api/types'
import { parseSelect, matchesWhere, type WhereClause } from './sql'

describe('parseSelect', () => {
  it('parses a bare SELECT * FROM topic', () => {
    expect(parseSelect('SELECT * FROM user-log')).toEqual({
      topic: 'user-log',
      where: [],
      limit: null,
      error: null,
    })
  })

  it('is case-insensitive and trims whitespace', () => {
    expect(parseSelect('  select * from orders  ').topic).toBe('orders')
  })

  it('parses an equality condition on key', () => {
    const r = parseSelect("SELECT * FROM orders WHERE key = 'abc'")
    expect(r.where).toEqual([{ field: 'key', op: 'eq', value: 'abc' }])
  })

  it('parses an equality condition on value', () => {
    const r = parseSelect("SELECT * FROM orders WHERE value = '{}'")
    expect(r.where).toEqual([{ field: 'value', op: 'eq', value: '{}' }])
  })

  it('parses LIKE conditions and LIMIT', () => {
    const r = parseSelect("SELECT * FROM orders WHERE value LIKE '%hello%' LIMIT 10")
    expect(r.where).toEqual([{ field: 'value', op: 'like', value: '%hello%' }])
    expect(r.limit).toBe(10)
  })

  it('parses multiple AND conditions', () => {
    const r = parseSelect("SELECT * FROM t WHERE key = 'k' AND value LIKE '%v%'")
    expect(r.where).toEqual([
      { field: 'key', op: 'eq', value: 'k' },
      { field: 'value', op: 'like', value: '%v%' },
    ])
  })

  it('rejects unsupported statements', () => {
    expect(parseSelect('INSERT INTO t VALUES (1)').error).toBeTruthy()
    expect(parseSelect('').error).toBeTruthy()
  })

  it('rejects unsupported operators and fields', () => {
    expect(parseSelect("SELECT * FROM t WHERE offset > 3").error).toBeTruthy()
    expect(parseSelect("SELECT * FROM t WHERE key = 123").error).toBeTruthy()
  })
})

describe('matchesWhere', () => {
  const msg = (key: string, value: string): Message => ({
    partition: 0, offset: 1, timestamp: 0, key, value, headers: [],
  })

  it('matches equality on key', () => {
    const clauses: WhereClause[] = [{ field: 'key', op: 'eq', value: 'k1' }]
    expect(matchesWhere(msg('k1', 'v'), clauses)).toBe(true)
    expect(matchesWhere(msg('k2', 'v'), clauses)).toBe(false)
  })

  it('matches LIKE on value with wildcards', () => {
    const clauses: WhereClause[] = [{ field: 'value', op: 'like', value: '%ell%' }]
    expect(matchesWhere(msg('k', 'hello world'), clauses)).toBe(true)
    expect(matchesWhere(msg('k', 'bye'), clauses)).toBe(false)
  })

  it('combines multiple clauses with AND', () => {
    const clauses: WhereClause[] = [
      { field: 'key', op: 'eq', value: 'k1' },
      { field: 'value', op: 'like', value: '%x%' },
    ]
    expect(matchesWhere(msg('k1', 'x'), clauses)).toBe(true)
    expect(matchesWhere(msg('k1', 'y'), clauses)).toBe(false)
  })

  it('matches everything when there are no clauses', () => {
    expect(matchesWhere(msg('a', 'b'), [])).toBe(true)
  })
})
