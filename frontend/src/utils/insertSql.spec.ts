import { describe, expect, it } from 'vitest'
import { buildInsertStatement, type InsertTarget } from './insertSql'

const target: InsertTarget = { database: 'logs', table: 'events' }

// 列与行的便捷构造。
const cols = (...defs: Array<[name: string, type?: string]>) =>
  defs.map(([name, type]) => ({ name, type }))

describe('buildInsertStatement', () => {
  it('基础输出:反引号库表与列名,多行一语句', () => {
    const sql = buildInsertStatement(target, cols(['id', 'Int32'], ['name', 'String']), [
      ['1', 'alice'],
      ['2', 'bob'],
    ])
    expect(sql).toBe(
      'INSERT INTO `logs`.`events` (`id`, `name`) VALUES\n(1, \'alice\'), (2, \'bob\');',
    )
  })

  it('null 值输出 NULL(数值列同样适用)', () => {
    const sql = buildInsertStatement(target, cols(['id', 'UInt64'], ['note', 'String']), [
      [null, 'x'],
      ['3', null],
    ])
    expect(sql).toBe('INSERT INTO `logs`.`events` (`id`, `note`) VALUES\n(NULL, \'x\'), (3, NULL);')
  })

  it('数值族前缀类型原样输出、大小写不敏感', () => {
    const numericTypes = ['int', 'UInt8', 'INT64', 'float', 'Float64', 'double', 'decimal', 'bool']
    for (const type of numericTypes) {
      const sql = buildInsertStatement(target, cols(['v', type]), [['42']])
      expect(sql, `type=${type}`).toBe('INSERT INTO `logs`.`events` (`v`) VALUES\n(42);')
    }
  })

  it('type 缺失或空串按字符串加引号', () => {
    const noType = buildInsertStatement(target, cols(['v']), [['7']])
    expect(noType).toBe('INSERT INTO `logs`.`events` (`v`) VALUES\n(\'7\');')
    const emptyType = buildInsertStatement(target, cols(['v', '']), [['7']])
    expect(emptyType).toBe('INSERT INTO `logs`.`events` (`v`) VALUES\n(\'7\');')
  })

  it('非数值类型(type 指定)同样加引号', () => {
    const sql = buildInsertStatement(target, cols(['v', 'String']), [['42']])
    expect(sql).toBe('INSERT INTO `logs`.`events` (`v`) VALUES\n(\'42\');')
  })

  it('字符串转义:单引号翻倍,反斜杠翻倍', () => {
    const sql = buildInsertStatement(target, cols(['v']), [["it's a \\ path"]])
    expect(sql).toBe('INSERT INTO `logs`.`events` (`v`) VALUES\n(\'it\'\'s a \\\\ path\');')
  })

  it('行数超 maxRows 截断并追加注释行', () => {
    const rows = [['1'], ['2'], ['3'], ['4'], ['5']]
    const sql = buildInsertStatement(target, cols(['v', 'Int32']), rows, 2)
    expect(sql).toBe(
      [
        'INSERT INTO `logs`.`events` (`v`) VALUES',
        '(1), (2);',
        '-- 已截断:共 5 行,仅复制前 2 行',
      ].join('\n'),
    )
  })

  it('不超过 maxRows 不追加截断注释', () => {
    const rows = [['1'], ['2']]
    const sql = buildInsertStatement(target, cols(['v']), rows, 2)
    expect(sql.endsWith(';')).toBe(true)
    expect(sql).not.toContain('已截断')
  })

  it('maxRows 默认 1000:1001 行触发截断,1000 行不触发', () => {
    const rows = Array.from({ length: 1001 }, (_, k) => [String(k)])
    expect(buildInsertStatement(target, cols(['v']), rows)).toContain('-- 已截断:共 1001 行,仅复制前 1000 行')
    expect(buildInsertStatement(target, cols(['v']), rows.slice(0, 1000))).not.toContain('已截断')
  })

  it('空行集:仅表头语句,VALUES 后无行', () => {
    const sql = buildInsertStatement(target, cols(['a'], ['b']), [])
    expect(sql).toBe('INSERT INTO `logs`.`events` (`a`, `b`) VALUES\n;')
  })

  it('行值少于列数:缺失槽位按 NULL 补齐', () => {
    const sql = buildInsertStatement(target, cols(['a'], ['b']), [['x']])
    expect(sql).toBe('INSERT INTO `logs`.`events` (`a`, `b`) VALUES\n(\'x\', NULL);')
  })

  it('行值多于列数:多余值忽略', () => {
    const sql = buildInsertStatement(target, cols(['a']), [['x', 'y']])
    expect(sql).toBe('INSERT INTO `logs`.`events` (`a`) VALUES\n(\'x\');')
  })

  it('数值类型下空串按 NULL 输出,避免生成非法 SQL', () => {
    const sql = buildInsertStatement(target, cols(['v', 'Int32']), [['']])
    expect(sql).toBe('INSERT INTO `logs`.`events` (`v`) VALUES\n(NULL);')
  })

  it('库表名与列名参与反引号包裹(与输入原样)', () => {
    const sql = buildInsertStatement(
      { database: 'my db', table: 'order' },
      cols(['select', 'String'], ['from', 'String']),
      [['1', '2']],
    )
    expect(sql).toBe('INSERT INTO `my db`.`order` (`select`, `from`) VALUES\n(\'1\', \'2\');')
  })
})
