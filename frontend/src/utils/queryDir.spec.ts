import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_QUERY_DIR, QUERY_DIR_KEY, getQueryDir, setQueryDir, withSqlExt } from './queryDir'

describe('getQueryDir/setQueryDir', () => {
  beforeEach(() => {
    localStorage.removeItem(QUERY_DIR_KEY)
  })

  it('未配置时回退默认目录', () => {
    expect(getQueryDir()).toBe(DEFAULT_QUERY_DIR)
  })

  it('setQueryDir 持久化输入的目录', () => {
    setQueryDir('~/sql-queries')
    expect(localStorage.getItem(QUERY_DIR_KEY)).toBe('~/sql-queries')
    expect(getQueryDir()).toBe('~/sql-queries')
  })

  it('空/纯空白目录移除键并回退默认', () => {
    setQueryDir('~/sql-queries')
    setQueryDir('   ')
    expect(localStorage.getItem(QUERY_DIR_KEY)).toBeNull()
    expect(getQueryDir()).toBe(DEFAULT_QUERY_DIR)
  })
})

describe('withSqlExt', () => {
  it('缺 .sql 后缀时补上', () => {
    expect(withSqlExt('我的查询')).toBe('我的查询.sql')
  })

  it('已有 .sql 后缀(任意大小写)保持原样', () => {
    expect(withSqlExt('报表.SQL')).toBe('报表.SQL')
    expect(withSqlExt('orders.Sql')).toBe('orders.Sql')
  })
})
