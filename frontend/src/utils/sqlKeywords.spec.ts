import { describe, expect, it } from 'vitest'
import { SQL_EXTRA_KEYWORDS, dedupeSqlKeywords } from './sqlKeywords'

describe('SQL_EXTRA_KEYWORDS', () => {
  it('包含 lang-sql 默认方言缺失的常用 MySQL 语句关键词(含 TRUNCATE)', () => {
    for (const kw of [
      'TRUNCATE',
      'SHOW',
      'EXPLAIN',
      'USE',
      'RENAME',
      'OPTIMIZE',
      'ANALYZE',
      'KILL',
    ]) {
      expect(SQL_EXTRA_KEYWORDS, `清单应包含 ${kw}`).toContain(kw)
    }
  })

  it('不含 lang-sql 默认词表已有的关键词(避免补全重复)', () => {
    for (const kw of [
      'SELECT',
      'FROM',
      'WHERE',
      'ALTER',
      'CREATE',
      'DROP',
      'INSERT',
      'UPDATE',
      'DELETE',
      'DESCRIBE',
      'COMMIT',
      'ROLLBACK',
    ]) {
      expect(SQL_EXTRA_KEYWORDS, `清单不应包含内置已有的 ${kw}`).not.toContain(kw)
    }
  })

  it('所有词条大写且清单内部无重复', () => {
    const upper = SQL_EXTRA_KEYWORDS.map((kw) => kw.toUpperCase())
    expect(SQL_EXTRA_KEYWORDS).toEqual(upper)
    expect(new Set(SQL_EXTRA_KEYWORDS).size).toBe(SQL_EXTRA_KEYWORDS.length)
  })
})

describe('dedupeSqlKeywords', () => {
  it('按大写归一去重,保留首次出现顺序', () => {
    expect(dedupeSqlKeywords(['show', 'TRUNCATE', 'SHOW', 'truncate', 'KILL'])).toEqual([
      'SHOW',
      'TRUNCATE',
      'KILL',
    ])
  })

  it('过滤空串与纯空白词条', () => {
    expect(dedupeSqlKeywords(['', '  ', 'USE', ''])).toEqual(['USE'])
  })

  it('不修改入参,返回新数组', () => {
    const input = ['show', 'SHOW']
    const out = dedupeSqlKeywords(input)
    expect(input).toEqual(['show', 'SHOW'])
    expect(out).not.toBe(input)
  })
})
