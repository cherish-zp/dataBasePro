import { describe, expect, it } from 'vitest'
import { parsePgSingleTableSelect, splitPostgresStatements } from './postgresSql'

describe('splitPostgresStatements', () => {
  it('DO $$ 块内的分号不拆分,随后语句正常拆分', () => {
    const sql = 'DO $$ BEGIN RAISE NOTICE $$hi$$; PERFORM 1; END $$; SELECT 1;'
    const segs = splitPostgresStatements(sql)
    expect(segs.map((s) => s.text)).toEqual([
      'DO $$ BEGIN RAISE NOTICE $$hi$$; PERFORM 1; END $$;',
      'SELECT 1;',
    ])
  })

  it('$tag$ 美元引号块内的分号不拆分', () => {
    const sql = "CREATE FUNCTION f() RETURNS void AS $fn$ BEGIN PERFORM 1; END; $fn$ LANGUAGE plpgsql;\nSELECT 2;"
    const segs = splitPostgresStatements(sql)
    expect(segs.map((s) => s.text)).toEqual([
      'CREATE FUNCTION f() RETURNS void AS $fn$ BEGIN PERFORM 1; END; $fn$ LANGUAGE plpgsql;',
      'SELECT 2;',
    ])
  })

  it('标准单引号字符串只处理 \'\' 转义,反斜杠是字面量', () => {
    // \'\' 为转义引号,字符串未提前闭合,分号正常拆分。
    const segs = splitPostgresStatements("SELECT 'a\'\'b'; SELECT 3;")
    expect(segs.map((s) => s.text)).toEqual(["SELECT 'a\'\'b';", 'SELECT 3;'])
    // 反斜杠是字面量:字符串在反斜杠后的引号处提前闭合,随后分号立即拆分。
    const segs2 = splitPostgresStatements("SELECT 'a\\'; SELECT 4;")
    expect(segs2.map((s) => s.text)).toEqual(["SELECT 'a\\';", 'SELECT 4;'])
  })

  it("E'...' 反斜杠转义内的分号不拆分", () => {
    const segs = splitPostgresStatements("SELECT E'a\\';b'; SELECT 4;")
    expect(segs.map((s) => s.text)).toEqual(["SELECT E'a\\';b';", 'SELECT 4;'])
  })

  it('双引号标识符内的分号/引号不拆分,"" 转义', () => {
    const segs = splitPostgresStatements('SELECT "we;ird""name" FROM t; SELECT 5;')
    expect(segs.map((s) => s.text)).toEqual(['SELECT "we;ird""name" FROM t;', 'SELECT 5;'])
  })

  it('注释内的分号/引号不拆分', () => {
    const sql = "-- comment; with 'quote\nSELECT 6 /* block; comment */; SELECT 7;"
    const segs = splitPostgresStatements(sql)
    expect(segs.map((s) => s.text)).toEqual(['SELECT 6 /* block; comment */;', 'SELECT 7;'])
  })

  it('$1 参数占位符不是美元引号', () => {
    const segs = splitPostgresStatements('SELECT $1, $2; SELECT 8;')
    expect(segs).toHaveLength(2)
  })

  it('段定位:from 落在首个内容字符,尾句 to 裁剪尾随空白', () => {
    const sql = '  -- head\n  SELECT 1;  \n\nSELECT 2   '
    const segs = splitPostgresStatements(sql)
    expect(segs).toHaveLength(2)
    expect(segs[0].text).toBe('SELECT 1;')
    expect(segs[0].from).toBe(sql.indexOf('SELECT'))
    expect(segs[0].startLine).toBe(2)
    expect(segs[1].text).toBe('SELECT 2')
    expect(segs[1].to).toBe(sql.trimEnd().length)
  })

  it('纯注释与空白不产出段', () => {
    expect(splitPostgresStatements('-- only comment\n')).toEqual([])
    expect(splitPostgresStatements('   \n\t')).toEqual([])
  })
})

describe('parsePgSingleTableSelect', () => {
  it('普通表名使用 defaultSchema', () => {
    expect(parsePgSingleTableSelect('SELECT id FROM users WHERE id = 1', 'public')).toEqual({
      database: '',
      schema: 'public',
      table: 'users',
    })
  })

  it('支持 schema 限定名与库.表.名三级限定', () => {
    expect(parsePgSingleTableSelect('SELECT id FROM app.users', 'public')).toEqual({
      database: '',
      schema: 'app',
      table: 'users',
    })
    expect(parsePgSingleTableSelect('SELECT id FROM shop.app.users', 'public')).toEqual({
      database: 'shop',
      schema: 'app',
      table: 'users',
    })
  })

  it('双引号表名/列名且 "" 转义', () => {
    expect(
      parsePgSingleTableSelect('SELECT "odd ""name""" FROM "App"."User Table" ORDER BY "id" LIMIT 10', 'public'),
    ).toEqual({ database: '', schema: 'App', table: 'User Table' })
  })

  it('支持 WHERE/ORDER BY/LIMIT/OFFSET 尾部子句', () => {
    const sql = 'SELECT id FROM users WHERE id > 1 ORDER BY id DESC LIMIT 10 OFFSET 5'
    expect(parsePgSingleTableSelect(sql, 'public')?.table).toBe('users')
  })

  it('尾部分号可容忍', () => {
    expect(parsePgSingleTableSelect('SELECT * FROM t;', 'public')?.table).toBe('t')
  })

  it('CTE 不视为单表', () => {
    expect(parsePgSingleTableSelect('WITH x AS (SELECT 1) SELECT * FROM users', 'public')).toBeNull()
  })

  it('JOIN 只读', () => {
    expect(parsePgSingleTableSelect('SELECT * FROM users JOIN orders ON orders.uid = users.id', 'public')).toBeNull()
    expect(parsePgSingleTableSelect('SELECT * FROM users u LEFT JOIN orders o ON o.uid = u.id', 'public')).toBeNull()
  })

  it('多表逗号与子查询只读', () => {
    expect(parsePgSingleTableSelect('SELECT * FROM users, orders', 'public')).toBeNull()
    expect(parsePgSingleTableSelect('SELECT * FROM (SELECT 1) x', 'public')).toBeNull()
  })

  it('GROUP BY/HAVING/FOR UPDATE 等尾部子句只读', () => {
    expect(parsePgSingleTableSelect('SELECT id FROM users GROUP BY id', 'public')).toBeNull()
    expect(parsePgSingleTableSelect('SELECT id FROM users HAVING count(*) > 1', 'public')).toBeNull()
    expect(parsePgSingleTableSelect('SELECT id FROM users FOR UPDATE', 'public')).toBeNull()
  })

  it('UNION 只读', () => {
    expect(parsePgSingleTableSelect('SELECT id FROM users UNION SELECT id FROM orders', 'public')).toBeNull()
  })

  it('非 SELECT 语句返回 null', () => {
    expect(parsePgSingleTableSelect('INSERT INTO users VALUES (1)', 'public')).toBeNull()
    expect(parsePgSingleTableSelect('UPDATE users SET id = 1', 'public')).toBeNull()
  })

  it('注释不干扰解析', () => {
    expect(parsePgSingleTableSelect('SELECT /* c */ id FROM -- c\nusers /* t */', 'public')?.table).toBe('users')
  })
})
