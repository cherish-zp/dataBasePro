import { describe, expect, it } from 'vitest'
import { commentAbove, splitSqlStatements } from './sqlSplit'

// from/to 断言辅助:直接对整个结果做快照式比对,保证 offset 语义稳定。
describe('splitSqlStatements', () => {
  it('空串不产出 segment', () => {
    expect(splitSqlStatements('')).toEqual([])
  })

  it('纯空白不产出 segment', () => {
    expect(splitSqlStatements('  \n\t  ')).toEqual([])
  })

  it('只有分号不产出 segment', () => {
    expect(splitSqlStatements(';;;')).toEqual([])
  })

  it('常规多句:按 ; 拆分,to 含分号,text 为原文切片', () => {
    const segs = splitSqlStatements('SELECT 1; SELECT 2;')
    expect(segs).toHaveLength(2)
    expect(segs[0]).toEqual({ text: 'SELECT 1;', from: 0, to: 9, startLine: 1 })
    expect(segs[1]).toEqual({ text: 'SELECT 2;', from: 10, to: 19, startLine: 1 })
  })

  it('尾句无分号:to 为末尾最后一个非空白字符之后', () => {
    const segs = splitSqlStatements('SELECT 1; SELECT 2')
    expect(segs).toHaveLength(2)
    expect(segs[1].text).toBe('SELECT 2')
    expect(segs[1].to).toBe(18)
    // 尾句后跟空白同样裁剪。
    const withWs = splitSqlStatements('SELECT 1; SELECT 2\n\n ')
    expect(withWs).toHaveLength(2)
    expect(withWs[1].text).toBe('SELECT 2')
    expect(withWs[1].to).toBe(18)
  })

  it('语句首行偏移跳过前导空白与换行(startLine 为 1 基行号)', () => {
    const segs = splitSqlStatements('SELECT 1;\n\n  SELECT 2')
    expect(segs).toHaveLength(2)
    expect(segs[1].from).toBe(13)
    expect(segs[1].startLine).toBe(3)
    expect(segs[1].text).toBe('SELECT 2')
  })

  it("单引号字符串内的分号不拆分('' 转义)", () => {
    const segs = splitSqlStatements("SELECT 'a''b;c'; SELECT 2")
    expect(segs).toHaveLength(2)
    expect(segs[0].text).toBe("SELECT 'a''b;c';")
  })

  it('反斜杠转义的引号不结束字符串', () => {
    const segs = splitSqlStatements("SELECT 'a\\'b'; SELECT 2")
    expect(segs).toHaveLength(2)
    expect(segs[0].text).toBe("SELECT 'a\\'b';")
  })

  it('双引号字符串内的分号不拆分', () => {
    const segs = splitSqlStatements('SELECT "a;b" AS x')
    expect(segs).toHaveLength(1)
    expect(segs[0].text).toBe('SELECT "a;b" AS x')
  })

  it('反引号标识符内的分号不拆分(含 `` 转义)', () => {
    const segs = splitSqlStatements('SELECT `a;b` FROM t')
    expect(segs).toHaveLength(1)
    const escaped = splitSqlStatements('SELECT `a``b;c` FROM t')
    expect(escaped).toHaveLength(1)
  })

  it('-- 行注释内的分号不拆分;段起点跳过前导注释', () => {
    const segs = splitSqlStatements('-- a;b\nSELECT 1')
    expect(segs).toHaveLength(1)
    expect(segs[0].from).toBe(7)
    expect(segs[0].startLine).toBe(2)
    expect(segs[0].text).toBe('SELECT 1')
  })

  it('# 行注释内的分号不拆分;段起点跳过前导注释', () => {
    const segs = splitSqlStatements('# a;b\nSELECT 1')
    expect(segs).toHaveLength(1)
    expect(segs[0].startLine).toBe(2)
    expect(segs[0].text).toBe('SELECT 1')
  })

  it('块注释内的分号不拆分,注释不得被字符串内容误导', () => {
    const segs = splitSqlStatements("/* a;b */ SELECT ';'")
    expect(segs).toHaveLength(1)
    // 字符串里的 /* */ 不是注释,字符串里的分号不拆分。
    const strFirst = splitSqlStatements("SELECT '/* x;y */'")
    expect(strFirst).toHaveLength(1)
    expect(strFirst[0].text).toBe("SELECT '/* x;y */'")
  })

  it('纯注释/空白尾段不产出 segment', () => {
    const segs = splitSqlStatements('SELECT 1; -- done\n/* tail */\n')
    expect(segs).toHaveLength(1)
    expect(segs[0].text).toBe('SELECT 1;')
  })

  it('跨行字符串内的分号不拆分', () => {
    const segs = splitSqlStatements("SELECT 'a\nb;c'")
    expect(segs).toHaveLength(1)
  })

  it('未闭合字符串:剩余内容视作语句(不抛错)', () => {
    const segs = splitSqlStatements("SELECT 'abc; SELECT 2")
    expect(segs).toHaveLength(1)
  })

  it('未闭合块注释:无实际语句时产出空', () => {
    expect(splitSqlStatements('/* abc;')).toEqual([])
  })

  it('行内注释后的下一条语句仍可拆分,段起点落在语句本体', () => {
    const segs = splitSqlStatements('SELECT 1; -- note\nSELECT 2')
    expect(segs).toHaveLength(2)
    expect(segs[1].from).toBe(18)
    expect(segs[1].startLine).toBe(2)
    expect(segs[1].text).toBe('SELECT 2')
  })

  it('同一行多条语句:startLine 相同,from/to 不重叠', () => {
    const segs = splitSqlStatements('A1;A2;A3;')
    expect(segs.map((s) => [s.from, s.to, s.text])).toEqual([
      [0, 3, 'A1;'],
      [3, 6, 'A2;'],
      [6, 9, 'A3;'],
    ])
    expect(segs.every((s) => s.startLine === 1)).toBe(true)
  })
})

// —— commentAbove:语句前置注释标签提取 ——
describe('commentAbove', () => {
  it('紧邻注释:返回去掉注释前缀后的文本', () => {
    const sql = '-- 查询用户\nSELECT 1'
    expect(commentAbove(sql, sql.indexOf('SELECT'))).toBe('查询用户')
  })

  it('隔空行注释:跳过空白行向上找最近的非空行', () => {
    const sql = '-- 查询用户\n\n \t\nSELECT 1'
    expect(commentAbove(sql, sql.indexOf('SELECT'))).toBe('查询用户')
  })

  it('上方是代码(非注释)→ null', () => {
    const sql = 'CREATE TABLE t(a int);\nSELECT 1'
    expect(commentAbove(sql, sql.indexOf('SELECT'))).toBeNull()
  })

  it('无上方行 / 空文件 → null', () => {
    expect(commentAbove('SELECT 1', 0)).toBeNull()
    expect(commentAbove('', 0)).toBeNull()
  })

  it('# 形式注释同样识别', () => {
    const sql = '# 查询用户\nSELECT 1'
    expect(commentAbove(sql, sql.indexOf('SELECT'))).toBe('查询用户')
  })

  it('注释含文本:仅去前缀并 trim,保留冒号等其余内容', () => {
    const sql = '-- 标签: 用户表全量导出\nSELECT * FROM users'
    expect(commentAbove(sql, sql.indexOf('SELECT'))).toBe('标签: 用户表全量导出')
  })

  it('带缩进的注释同样识别;光杆注释返回空串', () => {
    const sql = '  -- 缩进注释\nSELECT 1'
    expect(commentAbove(sql, sql.indexOf('SELECT'))).toBe('缩进注释')
    expect(commentAbove('--\nSELECT 1', 3)).toBe('')
    expect(commentAbove('#\nSELECT 1', 2)).toBe('')
  })

  it('语句前是注释 → 命中;同行紧邻内容是代码则不跨行找注释', () => {
    const sql = '-- 头注释\nSELECT 1; SELECT 2'
    expect(commentAbove(sql, sql.indexOf('SELECT'))).toBe('头注释')
    // 第二条语句与第一条同行:语句之前已是代码,不跨行找注释 → null。
    expect(commentAbove(sql, sql.lastIndexOf('SELECT'))).toBeNull()
  })
})
