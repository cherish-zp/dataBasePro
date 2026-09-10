import { describe, expect, it } from 'vitest'
import { parseCHSingleTableSelect } from './chSql'

describe('parseCHSingleTableSelect 命中(单表 SELECT)', () => {
  it('裸表名:database 为空串表示连接默认库', () => {
    expect(parseCHSingleTableSelect('SELECT * FROM users')).toEqual({
      database: '',
      table: 'users',
    })
  })

  it('库名限定:database/table 正确拆分', () => {
    expect(parseCHSingleTableSelect('SELECT id, name FROM db.events WHERE ts > 1 LIMIT 100')).toEqual(
      { database: 'db', table: 'events' },
    )
  })

  it('大小写不敏感,表名保留原样', () => {
    expect(parseCHSingleTableSelect('select id from DB.Users order by id desc limit 3')).toEqual(
      { database: 'DB', table: 'Users' },
    )
  })

  it('允许前导行注释与块注释', () => {
    expect(parseCHSingleTableSelect('-- 查询明细\n/* block */ SELECT a FROM t')).toEqual({
      database: '',
      table: 't',
    })
  })

  it('允许尾部分号(前后可带空白)', () => {
    expect(parseCHSingleTableSelect('SELECT * FROM t ;')).toEqual({ database: '', table: 't' })
  })

  it('反引号标识符剥离引号(含特殊字符)', () => {
    expect(parseCHSingleTableSelect('SELECT * FROM `my-db`.`tbl` PREWHERE x = 1')).toEqual({
      database: 'my-db',
      table: 'tbl',
    })
  })

  it('AS 别名:返回真实表名而非别名', () => {
    expect(
      parseCHSingleTableSelect('SELECT e.* FROM events AS e WHERE e.id = 1 ORDER BY e.ts DESC'),
    ).toEqual({ database: '', table: 'events' })
  })

  it('裸别名:返回真实表名而非别名', () => {
    expect(parseCHSingleTableSelect('SELECT * FROM t f LIMIT 5')).toEqual({
      database: '',
      table: 't',
    })
  })

  it('ORDER BY 多键带 ASC/DESC 与逗号', () => {
    expect(parseCHSingleTableSelect('SELECT * FROM t ORDER BY a DESC, b ASC NULLS LAST')).toEqual({
      database: '',
      table: 't',
    })
  })

  it('LIMIT 逗号形式(LIMIT offset, n)', () => {
    expect(parseCHSingleTableSelect('SELECT * FROM t LIMIT 5, 10')).toEqual({
      database: '',
      table: 't',
    })
  })

  it('子句任意顺序与组合(WHERE/PREWHERE/ORDER BY/LIMIT)', () => {
    expect(parseCHSingleTableSelect('SELECT * FROM db.t LIMIT 10 PREWHERE x > 0 WHERE y = 2')).toEqual(
      { database: 'db', table: 't' },
    )
  })

  it('字段列表可含函数与括号', () => {
    expect(parseCHSingleTableSelect('SELECT count(), any(name) FROM events')).toEqual({
      database: '',
      table: 'events',
    })
  })

  it('SELECT 列表中的子查询不影响 FROM 判定', () => {
    expect(parseCHSingleTableSelect('SELECT (SELECT max(x) FROM agg) AS m FROM main')).toEqual({
      database: '',
      table: 'main',
    })
  })

  it('WHERE 中的 IN 子查询不破坏单表判定', () => {
    expect(
      parseCHSingleTableSelect('SELECT * FROM db.t WHERE id IN (SELECT id FROM other) LIMIT 10'),
    ).toEqual({ database: 'db', table: 't' })
  })

  it('字符串字面量中的关键字不参与判定', () => {
    expect(parseCHSingleTableSelect("SELECT * FROM t WHERE note = 'JOIN union from x'")).toEqual({
      database: '',
      table: 't',
    })
  })

  it('表名后跟 FINAL/SAMPLE 仍视为单表', () => {
    expect(parseCHSingleTableSelect('SELECT * FROM t FINAL SAMPLE 0.1')).toEqual({
      database: '',
      table: 't',
    })
  })
})

describe('parseCHSingleTableSelect 拒绝(返回 null)', () => {
  it('显式 JOIN', () => {
    expect(parseCHSingleTableSelect('SELECT * FROM t JOIN u ON t.id = u.id')).toBeNull()
  })

  it('LEFT JOIN + USING', () => {
    expect(parseCHSingleTableSelect('SELECT * FROM t LEFT JOIN u USING (id)')).toBeNull()
  })

  it('FROM 后逗号多表', () => {
    expect(parseCHSingleTableSelect('SELECT * FROM t, u WHERE t.id = u.id')).toBeNull()
  })

  it('别名后逗号接第二张表', () => {
    expect(parseCHSingleTableSelect('SELECT * FROM t AS a, u AS b')).toBeNull()
  })

  it('FROM 子查询', () => {
    expect(parseCHSingleTableSelect('SELECT * FROM (SELECT 1) AS sub')).toBeNull()
    expect(parseCHSingleTableSelect('SELECT * FROM ((SELECT 1))')).toBeNull()
  })

  it('GROUP BY / HAVING', () => {
    expect(parseCHSingleTableSelect('SELECT x, count() FROM t GROUP BY x')).toBeNull()
    expect(parseCHSingleTableSelect('SELECT x FROM t GROUP BY x HAVING count() > 1')).toBeNull()
  })

  it('UNION(含前置 UNION 组合语句)', () => {
    expect(parseCHSingleTableSelect('SELECT a FROM t1 UNION ALL SELECT b FROM t2')).toBeNull()
    expect(parseCHSingleTableSelect('SELECT 1 UNION SELECT * FROM t')).toBeNull()
  })

  it('WITH(开头 CTE 与尾句均拒绝)', () => {
    expect(parseCHSingleTableSelect('WITH x AS (SELECT 1) SELECT * FROM t')).toBeNull()
  })

  it('SETTINGS', () => {
    expect(parseCHSingleTableSelect('SELECT * FROM t SETTINGS max_threads = 8')).toBeNull()
  })

  it('INTO OUTFILE', () => {
    expect(parseCHSingleTableSelect("SELECT * FROM t INTO OUTFILE 'a.csv'")).toBeNull()
  })

  it('OFFSET 不在允许子句内', () => {
    expect(parseCHSingleTableSelect('SELECT * FROM t LIMIT 10 OFFSET 5')).toBeNull()
  })

  it('非 SELECT 开头(INSERT/ALTER/SET/UPDATE)', () => {
    expect(parseCHSingleTableSelect('INSERT INTO t (a) VALUES (1)')).toBeNull()
    expect(parseCHSingleTableSelect('ALTER TABLE t DELETE WHERE id = 1')).toBeNull()
    expect(parseCHSingleTableSelect('SET max_threads = 8')).toBeNull()
    expect(parseCHSingleTableSelect('UPDATE t SET a = 1')).toBeNull()
  })

  it('缺少 FROM 或表名不完整', () => {
    expect(parseCHSingleTableSelect('SELECT 1')).toBeNull()
    expect(parseCHSingleTableSelect('SELECT * FROM')).toBeNull()
    expect(parseCHSingleTableSelect('SELECT * FROM db.')).toBeNull()
  })

  it('多语句拼接', () => {
    expect(parseCHSingleTableSelect('SELECT 1; SELECT * FROM t')).toBeNull()
  })

  it('括号不配对', () => {
    expect(parseCHSingleTableSelect('SELECT * FROM t WHERE x IN (1, 2')).toBeNull()
  })

  it('空输入', () => {
    expect(parseCHSingleTableSelect('')).toBeNull()
    expect(parseCHSingleTableSelect('   \n  ')).toBeNull()
  })
})
