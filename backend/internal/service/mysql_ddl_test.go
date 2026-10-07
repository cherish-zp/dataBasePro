package service

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"sheng-shou-yun-he/backend/internal/model"
)

// --- 纯函数:ALTER 语句拼装 ---

func TestBuildMysqlColumnDefinition(t *testing.T) {
	str := func(s string) *string { return &s }
	cases := []struct {
		name string
		def  MysqlColumnDef
		want string
	}{
		{
			"可空无默认无注释",
			MysqlColumnDef{Name: "c", ColumnType: "int", Nullable: true},
			"`c` int DEFAULT NULL COMMENT ''",
		},
		{
			"NOT NULL 与字符串默认值(引号双写)",
			MysqlColumnDef{Name: "note", ColumnType: "varchar(8)", DefaultValue: str("x'y"), Comment: "备注"},
			"`note` varchar(8) NOT NULL DEFAULT 'x''y' COMMENT '备注'",
		},
		{
			"CURRENT_TIMESTAMP 裸写(大小写不敏感)",
			MysqlColumnDef{Name: "created", ColumnType: "timestamp", Nullable: true, DefaultValue: str("CURRENT_TIMESTAMP")},
			"`created` timestamp DEFAULT CURRENT_TIMESTAMP COMMENT ''",
		},
		{
			"current_timestamp() 同样裸写",
			MysqlColumnDef{Name: "created", ColumnType: "timestamp", Nullable: true, DefaultValue: str("current_timestamp()")},
			"`created` timestamp DEFAULT current_timestamp() COMMENT ''",
		},
		{
			"CURRENT_TIMESTAMP(6) 带精度同样裸写",
			MysqlColumnDef{Name: "created", ColumnType: "datetime(6)", Nullable: true, DefaultValue: str("CURRENT_TIMESTAMP(6)")},
			"`created` datetime(6) DEFAULT CURRENT_TIMESTAMP(6) COMMENT ''",
		},
		{
			"current_date 裸写",
			MysqlColumnDef{Name: "d", ColumnType: "date", Nullable: true, DefaultValue: str("current_date")},
			"`d` date DEFAULT current_date COMMENT ''",
		},
		{
			"注入形态默认值按字面量转义(不裸写)",
			MysqlColumnDef{Name: "c", ColumnType: "varchar(64)", Nullable: true, DefaultValue: str("CURRENT_TIMESTAMP(6), DROP COLUMN x")},
			"`c` varchar(64) DEFAULT 'CURRENT_TIMESTAMP(6), DROP COLUMN x' COMMENT ''",
		},
		{
			"AUTO_INCREMENT",
			MysqlColumnDef{Name: "id", ColumnType: "bigint", Nullable: true, AutoIncrement: true},
			"`id` bigint DEFAULT NULL COMMENT '' AUTO_INCREMENT",
		},
		{
			"标识符内部反引号双写",
			MysqlColumnDef{Name: "a`b", ColumnType: "int", Nullable: true},
			"`a``b` int DEFAULT NULL COMMENT ''",
		},
	}
	for _, tc := range cases {
		if got := buildMysqlColumnDefinition(tc.def); got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.name, got, tc.want)
		}
	}
}

// validateMysqlColumnType 白名单:类型名 + 可选数字括号参数 + unsigned/zerofill。
func TestValidateMysqlColumnType(t *testing.T) {
	for _, v := range []string{
		"int", "varchar(64)", "decimal(10,2)", "decimal(10, 2)",
		"int(11) unsigned", "bigint unsigned zerofill", "datetime(6)", "  int  ",
	} {
		if err := validateMysqlColumnType(v); err != nil {
			t.Errorf("validateMysqlColumnType(%q) must pass, got %v", v, err)
		}
	}
	for _, v := range []string{
		"varchar(10) DEFAULT 'x', DROP COLUMN secret", // 注入:追加子句
		"CURRENT_TIMESTAMP(6), DROP COLUMN x",         // 注入:追加子句
		"int; DROP TABLE users",                       // 注入:分号
		"int DEFAULT 0",                               // 注入:DEFAULT 片段
		"int(10) unsigned DROP COLUMN x",              // 注入:修饰后追加子句
		"enum('a','b')",                               // 引号参数不支持
		"set('a','b')",                                // 引号参数不支持
		"varchar(10) 'x'",                             // 裸引号
		"",                                            // 空类型
	} {
		if err := validateMysqlColumnType(v); err == nil || !strings.Contains(err.Error(), "列类型不合法") {
			t.Errorf("validateMysqlColumnType(%q) must be rejected with 列类型不合法, got %v", v, err)
		}
	}
}

func TestIsMysqlCurrentDefault(t *testing.T) {
	for _, v := range []string{"CURRENT_TIMESTAMP", "current_timestamp", "CURRENT_TIMESTAMP()", "current_timestamp(3)", "CURRENT_TIMESTAMP(6)", "CURRENT_DATE", "current_date()"} {
		if !isMysqlCurrentDefault(v) {
			t.Errorf("isMysqlCurrentDefault(%q) must be true", v)
		}
	}
	for _, v := range []string{"", "NULL", "NOW()", "2020-01-01", "CURRENT_TIME", "x_current_timestamp", "CURRENT_TIMESTAMP(6), DROP COLUMN x", "CURRENT_TIMESTAMP NOW()"} {
		if isMysqlCurrentDefault(v) {
			t.Errorf("isMysqlCurrentDefault(%q) must be false", v)
		}
	}
}

func TestBuildMysqlAlterStatements(t *testing.T) {
	str := func(s string) *string { return &s }
	add := []MysqlColumnDef{
		{Name: "c1", ColumnType: "int", Nullable: true},
		{Name: "c2", ColumnType: "varchar(4)", Nullable: true, After: str("c1")},
	}
	modify := []MysqlColumnDef{{Name: "c1", ColumnType: "bigint", Nullable: true, After: str("zz")}} // After 对修改列无效
	drop := []string{"d1", "d2"}
	stmts := buildMysqlAlterStatements("app", "users", add, modify, drop)
	want := []string{
		"ALTER TABLE `app`.`users` ADD COLUMN `c1` int DEFAULT NULL COMMENT ''",
		"ALTER TABLE `app`.`users` ADD COLUMN `c2` varchar(4) DEFAULT NULL COMMENT '' AFTER `c1`",
		"ALTER TABLE `app`.`users` MODIFY COLUMN `c1` bigint DEFAULT NULL COMMENT ''",
		"ALTER TABLE `app`.`users` DROP COLUMN `d1`",
		"ALTER TABLE `app`.`users` DROP COLUMN `d2`",
	}
	if !reflect.DeepEqual(stmts, want) {
		t.Fatalf("unexpected statements:\n got %+v\nwant %+v", stmts, want)
	}
}

func TestValidateMysqlAlterSpec(t *testing.T) {
	if err := validateMysqlAlterSpec(MysqlAlterTableSpec{Table: "t"}); err == nil {
		t.Fatal("empty change set must be rejected")
	}
	if err := validateMysqlAlterSpec(MysqlAlterTableSpec{}); err == nil || !strings.Contains(err.Error(), "表名") {
		t.Fatal("empty table must be rejected")
	}
	if err := validateMysqlAlterSpec(MysqlAlterTableSpec{Table: "t", AddColumns: []MysqlColumnDef{{ColumnType: "int"}}}); err == nil {
		t.Fatal("add column without a name must be rejected")
	}
	if err := validateMysqlAlterSpec(MysqlAlterTableSpec{Table: "t", AddColumns: []MysqlColumnDef{{Name: "c"}}}); err == nil {
		t.Fatal("add column without a type must be rejected")
	}
	if err := validateMysqlAlterSpec(MysqlAlterTableSpec{Table: "t", DropColumns: []string{" "}}); err == nil {
		t.Fatal("blank drop name must be rejected")
	}
	if err := validateMysqlAlterSpec(MysqlAlterTableSpec{Table: "t", DropColumns: []string{"c"}}); err != nil {
		t.Fatalf("valid spec must pass: %v", err)
	}
}

// --- 离线 fake 驱动:实现 QueryerContext/ExecerContext,绕开
// fakeMysqlDrvConn 的 information_schema 主键桩(那里只回 4 列形状),
// 按查询文本路由全量列元数据与 SHOW CREATE TABLE。 ---

type ddlFakeDriver struct{}

func (ddlFakeDriver) Open(string) (driver.Conn, error) { return nil, errors.New("use sql.OpenDB") }

type ddlFakeConn struct {
	execs    []string
	queries  []string
	execErr  error // 非空时所有 Exec 失败
	respond  func(query string) (driver.Rows, error)
	closeErr error
	closedN  int
}

func (c *ddlFakeConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("prepare unsupported")
}
func (c *ddlFakeConn) Close() error              { c.closedN++; return c.closeErr }
func (c *ddlFakeConn) Begin() (driver.Tx, error) { return nil, errors.New("transactions unsupported") }

func (c *ddlFakeConn) ExecContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	if c.execErr != nil {
		return nil, c.execErr
	}
	c.execs = append(c.execs, query)
	return driver.RowsAffected(0), nil
}

func (c *ddlFakeConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	c.queries = append(c.queries, query)
	if c.respond == nil {
		return &ddlFakeRows{cols: []string{"x"}}, nil
	}
	return c.respond(query)
}

type ddlFakeRows struct {
	cols []string
	vals [][]driver.Value
	pos  int
}

func (r *ddlFakeRows) Columns() []string { return r.cols }
func (r *ddlFakeRows) Close() error      { return nil }
func (r *ddlFakeRows) Next(dest []driver.Value) error {
	if r.pos >= len(r.vals) {
		return io.EOF
	}
	copy(dest, r.vals[r.pos])
	r.pos++
	return nil
}

type ddlFakeConnector struct{ conn *ddlFakeConn }

func (c ddlFakeConnector) Connect(context.Context) (driver.Conn, error) { return c.conn, nil }
func (c ddlFakeConnector) Driver() driver.Driver                        { return ddlFakeDriver{} }

// newDDLFakeClient 基于 fake 驱动构造客户端(不拨号),供本文件专用。
func newDDLFakeClient(t *testing.T, conn *ddlFakeConn) *MysqlClient {
	t.Helper()
	db := sql.OpenDB(ddlFakeConnector{conn: conn})
	t.Cleanup(func() { _ = db.Close() })
	return &MysqlClient{db: db, connType: model.ConnectionTypeMySQL}
}

// --- DropTable ---

func TestMysqlClientDropTable(t *testing.T) {
	conn := &ddlFakeConn{}
	c := newDDLFakeClient(t, conn)
	if err := c.DropTable(context.Background(), "app", "users"); err != nil {
		t.Fatalf("DropTable: %v", err)
	}
	if len(conn.execs) != 1 || conn.execs[0] != "DROP TABLE `app`.`users`" {
		t.Fatalf("unexpected execs: %+v", conn.execs)
	}
	// 库名内部反引号双写。
	conn2 := &ddlFakeConn{}
	c2 := newDDLFakeClient(t, conn2)
	if err := c2.DropTable(context.Background(), "a`b", "t"); err != nil {
		t.Fatalf("DropTable: %v", err)
	}
	if conn2.execs[0] != "DROP TABLE `a``b`.`t`" {
		t.Fatalf("embedded backtick must be doubled, got %q", conn2.execs[0])
	}
	// 失败透出。
	conn3 := &ddlFakeConn{execErr: errors.New("boom")}
	c3 := newDDLFakeClient(t, conn3)
	if err := c3.DropTable(context.Background(), "app", "users"); err == nil {
		t.Fatal("drop failure must surface")
	}
}

// --- TableColumns ---

func TestMysqlClientTableColumns(t *testing.T) {
	conn := &ddlFakeConn{respond: func(query string) (driver.Rows, error) {
		if strings.Contains(query, "information_schema.columns") {
			return &ddlFakeRows{
				cols: []string{"column_name", "column_type", "data_type", "is_nullable", "column_default", "extra", "column_comment", "column_key"},
				vals: [][]driver.Value{
					{"id", "bigint unsigned", "bigint", "NO", nil, "", "", "PRI"},
					{"note", "varchar(64)", "varchar", "YES", "abc", "", "备注", ""},
					{"created", "timestamp", "timestamp", "NO", "CURRENT_TIMESTAMP", "DEFAULT_GENERATED on update CURRENT_TIMESTAMP", "", ""},
				},
			}, nil
		}
		if strings.HasPrefix(strings.ToUpper(query), "SHOW CREATE TABLE") {
			return &ddlFakeRows{
				cols: []string{"Table", "Create Table"},
				vals: [][]driver.Value{{"users", "CREATE TABLE `users` (`id` bigint unsigned NOT NULL) ENGINE=InnoDB"}},
			}, nil
		}
		return nil, fmt.Errorf("unexpected query: %s", query)
	}}
	c := newDDLFakeClient(t, conn)
	res, err := c.TableColumns(context.Background(), "app", "users")
	if err != nil {
		t.Fatalf("TableColumns: %v", err)
	}
	if len(res.Columns) != 3 {
		t.Fatalf("expected 3 columns, got %+v", res.Columns)
	}
	id, note := res.Columns[0], res.Columns[1]
	if id.Name != "id" || id.ColumnType != "bigint unsigned" || id.DataType != "bigint" ||
		id.Nullable || id.DefaultValue != nil || !id.IsPrimaryKey {
		t.Fatalf("unexpected id column: %+v", id)
	}
	if !note.Nullable || note.DefaultValue == nil || *note.DefaultValue != "abc" || note.Comment != "备注" || note.IsPrimaryKey {
		t.Fatalf("unexpected note column: %+v", note)
	}
	if res.Columns[2].DefaultValue == nil || *res.Columns[2].DefaultValue != "CURRENT_TIMESTAMP" {
		t.Fatalf("timestamp default must pass through verbatim: %+v", res.Columns[2])
	}
	if !strings.Contains(res.DDL, "ENGINE=InnoDB") {
		t.Fatalf("ddl must be the SHOW CREATE TABLE text, got %q", res.DDL)
	}
	// SHOW CREATE TABLE 语句必须反引号限定 db.table。
	if !strings.Contains(conn.queries[1], "SHOW CREATE TABLE `app`.`users`") {
		t.Fatalf("unexpected ddl query: %+v", conn.queries)
	}
}

// --- AlterTable ---

func TestMysqlClientAlterTableExecutesInOrder(t *testing.T) {
	conn := &ddlFakeConn{}
	c := newDDLFakeClient(t, conn)
	str := func(s string) *string { return &s }
	spec := MysqlAlterTableSpec{
		Database: "app", Table: "users",
		AddColumns:    []MysqlColumnDef{{Name: "c1", ColumnType: "int", Nullable: true}, {Name: "c2", ColumnType: "varchar(4)", Nullable: true, After: str("c1")}},
		ModifyColumns: []MysqlColumnDef{{Name: "c1", ColumnType: "bigint", Nullable: true}},
		DropColumns:   []string{"d1"},
	}
	if err := c.AlterTable(context.Background(), spec); err != nil {
		t.Fatalf("AlterTable: %v", err)
	}
	want := []string{
		"ALTER TABLE `app`.`users` ADD COLUMN `c1` int DEFAULT NULL COMMENT ''",
		"ALTER TABLE `app`.`users` ADD COLUMN `c2` varchar(4) DEFAULT NULL COMMENT '' AFTER `c1`",
		"ALTER TABLE `app`.`users` MODIFY COLUMN `c1` bigint DEFAULT NULL COMMENT ''",
		"ALTER TABLE `app`.`users` DROP COLUMN `d1`",
	}
	if !reflect.DeepEqual(conn.execs, want) {
		t.Fatalf("unexpected execs:\n got %+v\nwant %+v", conn.execs, want)
	}
}

// ADD 与 MODIFY 的列类型都必须过白名单校验,注入形态在执行前被拒。
func TestMysqlClientAlterTableRejectsIllegalColumnType(t *testing.T) {
	conn := &ddlFakeConn{}
	c := newDDLFakeClient(t, conn)
	err := c.AlterTable(context.Background(), MysqlAlterTableSpec{
		Database: "app", Table: "users",
		AddColumns: []MysqlColumnDef{{Name: "c1", ColumnType: "varchar(10) DEFAULT 'x', DROP COLUMN secret"}},
	})
	if err == nil || !strings.Contains(err.Error(), "列类型不合法") {
		t.Fatalf("add column with clause injection must be rejected, got %v", err)
	}
	err = c.AlterTable(context.Background(), MysqlAlterTableSpec{
		Database: "app", Table: "users",
		ModifyColumns: []MysqlColumnDef{{Name: "c1", ColumnType: "CURRENT_TIMESTAMP(6), DROP COLUMN x"}},
	})
	if err == nil || !strings.Contains(err.Error(), "列类型不合法") {
		t.Fatalf("modify column with clause injection must be rejected, got %v", err)
	}
	if len(conn.execs) != 0 {
		t.Fatalf("no statement may run when validation fails: %+v", conn.execs)
	}
}

func TestMysqlClientAlterTableStopsOnFirstFailure(t *testing.T) {
	conn := &ddlFakeConn{execErr: errors.New("boom")}
	c := newDDLFakeClient(t, conn)
	spec := MysqlAlterTableSpec{
		Database: "app", Table: "users",
		AddColumns:  []MysqlColumnDef{{Name: "c1", ColumnType: "int"}},
		DropColumns: []string{"d1"},
	}
	if err := c.AlterTable(context.Background(), spec); err == nil {
		t.Fatal("alter failure must surface")
	}
	if len(conn.execs) != 0 {
		t.Fatalf("no statement may be recorded when the first one fails: %+v", conn.execs)
	}
	if err := c.AlterTable(context.Background(), MysqlAlterTableSpec{Table: "users"}); err == nil {
		t.Fatal("empty change set must be rejected before executing")
	}
}

// --- 导出 ---

func TestRenderMysqlExportLiteral(t *testing.T) {
	ts := time.Date(2026, 9, 28, 10, 30, 0, 123456000, time.Local)
	cases := []struct {
		name string
		in   any
		want string
	}{
		{"nil", nil, "NULL"},
		{"bytes 十六进制", []byte{0xde, 0xad}, "0xdead"},
		{"空 bytes", []byte{}, "''"},
		{"time 墙钟微秒", ts, "'2026-09-28 10:30:00.123456'"},
		{"字符串引号双写", "it's", "'it''s'"},
		{"int64 负数", int64(-7), "-7"},
		{"float64", 3.5, "3.5"},
		{"float32", float32(0.5), "0.5"},
		{"bool", true, "true"},
		{"未知类型按字符串", struct{ X int }{1}, "'{1}'"},
	}
	for _, tc := range cases {
		if got := renderMysqlExportLiteral(tc.in); got != tc.want {
			t.Errorf("%s: renderMysqlExportLiteral(%v) = %s, want %s", tc.name, tc.in, got, tc.want)
		}
	}
}

func TestMysqlClientExportStructureOnly(t *testing.T) {
	conn := &ddlFakeConn{respond: func(query string) (driver.Rows, error) {
		if strings.HasPrefix(strings.ToUpper(query), "SHOW CREATE TABLE") {
			return &ddlFakeRows{
				cols: []string{"Table", "Create Table"},
				vals: [][]driver.Value{{"users", "CREATE TABLE `users` (`id` int)"}},
			}, nil
		}
		return nil, fmt.Errorf("structure-only export must not query data, got %s", query)
	}}
	c := newDDLFakeClient(t, conn)
	res, err := c.ExportTable(context.Background(), MysqlExportSpec{Database: "app", Table: "users", IncludeDDL: true})
	if err != nil {
		t.Fatalf("ExportTable: %v", err)
	}
	if !strings.HasPrefix(res.Filename, "users_") || !strings.HasSuffix(res.Filename, ".sql") {
		t.Fatalf("unexpected filename %q", res.Filename)
	}
	want := "-- 表结构: app.users\nCREATE TABLE `users` (`id` int);\n"
	if res.Content != want {
		t.Fatalf("unexpected content:\n got %q\nwant %q", res.Content, want)
	}
}

// ddlPKRows 构造主键列查询桩(key_column_usage 单列结果;空=无主键)。
func ddlPKRows(pk []string) *ddlFakeRows {
	rows := &ddlFakeRows{cols: []string{"column_name"}}
	for _, c := range pk {
		rows.vals = append(rows.vals, []driver.Value{c})
	}
	return rows
}

// ddlShowCreateRespond 桩 SHOW CREATE TABLE 与默认无主键的 key_column_usage,
// 其余查询交给 dataQuery。
func ddlShowCreateRespond(dataQuery func(query string) (driver.Rows, error)) func(string) (driver.Rows, error) {
	return ddlShowCreateWithPK(nil, dataQuery)
}

// ddlShowCreateWithPK 同上,但可指定主键列(空切片=无主键,导出不拼 ORDER BY)。
func ddlShowCreateWithPK(pk []string, dataQuery func(query string) (driver.Rows, error)) func(string) (driver.Rows, error) {
	return func(query string) (driver.Rows, error) {
		if strings.HasPrefix(strings.ToUpper(query), "SHOW CREATE TABLE") {
			return &ddlFakeRows{
				cols: []string{"Table", "Create Table"},
				vals: [][]driver.Value{{"users", "CREATE TABLE `users` (`id` int, `name` varchar(8))"}},
			}, nil
		}
		if strings.Contains(query, "information_schema.key_column_usage") {
			return ddlPKRows(pk), nil
		}
		return dataQuery(query)
	}
}

func ddlExportRows(count int) [][]driver.Value {
	vals := make([][]driver.Value, count)
	for i := range vals {
		vals[i] = []driver.Value{int64(i + 1), "v"}
	}
	return vals
}

// ddlExportRowsFrom 生成 id 从 start 起的 count 行(翻页桩数据保持 id 连续)。
func ddlExportRowsFrom(start, count int) [][]driver.Value {
	vals := make([][]driver.Value, count)
	for i := range vals {
		vals[i] = []driver.Value{int64(start + i), "v"}
	}
	return vals
}

var ddlLimitRe = regexp.MustCompile(`LIMIT (\d+) OFFSET (\d+)`)

// newExportFakeClient 桩一张 2200 行的两列表:数据查询按解析出的 LIMIT/OFFSET
// 返回对应页(总行数封顶 2200),并记录每条数据查询文本。
func newExportFakeClient(t *testing.T) (*MysqlClient, *ddlFakeConn, *[]string) {
	var dataQueries []string
	conn := &ddlFakeConn{respond: ddlShowCreateRespond(func(query string) (driver.Rows, error) {
		if strings.HasPrefix(query, "SELECT * FROM") {
			dataQueries = append(dataQueries, query)
			m := ddlLimitRe.FindStringSubmatch(query)
			size, _ := strconv.Atoi(m[1])
			offset, _ := strconv.Atoi(m[2])
			n := size
			if remain := 2200 - offset; remain < n {
				n = remain
			}
			return &ddlFakeRows{cols: []string{"id", "name"}, vals: ddlExportRowsFrom(offset+1, n)}, nil
		}
		return nil, fmt.Errorf("unexpected query: %s", query)
	})}
	return newDDLFakeClient(t, conn), conn, &dataQueries
}

// 有主键表的数据分批必须按主键列排序:OFFSET 翻页只有在确定排序下才保证
// 行序稳定、不漏行不重行。
func TestMysqlClientExportOrdersByPrimaryKey(t *testing.T) {
	var dataQueries []string
	conn := &ddlFakeConn{respond: ddlShowCreateWithPK([]string{"tenant_id", "id"}, func(query string) (driver.Rows, error) {
		if strings.HasPrefix(query, "SELECT * FROM") {
			dataQueries = append(dataQueries, query)
			return &ddlFakeRows{
				cols: []string{"tenant_id", "id", "name"},
				vals: [][]driver.Value{{"t1", int64(1), "v"}, {"t1", int64(2), "v"}},
			}, nil
		}
		return nil, fmt.Errorf("unexpected query: %s", query)
	})}
	c := newDDLFakeClient(t, conn)
	res, err := c.ExportTable(context.Background(), MysqlExportSpec{Database: "app", Table: "users", IncludeData: true})
	if err != nil {
		t.Fatalf("ExportTable: %v", err)
	}
	if len(dataQueries) != 1 {
		t.Fatalf("expected 1 data query, got %+v", dataQueries)
	}
	want := "SELECT * FROM `app`.`users` ORDER BY `tenant_id`, `id` LIMIT 1000 OFFSET 0"
	if dataQueries[0] != want {
		t.Fatalf("data query must order by primary key:\n got %s\nwant %s", dataQueries[0], want)
	}
	if !strings.Contains(res.Content, "-- 表数据: app.users (2 行)") {
		t.Fatalf("rows must still be exported:\n%s", res.Content)
	}
}

// 无主键表不拼 ORDER BY(保持现状;跨批行序不保证是固有限制)。
func TestMysqlClientExportWithoutPKKeepsUnordered(t *testing.T) {
	var dataQueries []string
	conn := &ddlFakeConn{respond: ddlShowCreateWithPK(nil, func(query string) (driver.Rows, error) {
		if strings.HasPrefix(query, "SELECT * FROM") {
			dataQueries = append(dataQueries, query)
			return &ddlFakeRows{cols: []string{"id"}, vals: ddlExportRows(2)}, nil
		}
		return nil, fmt.Errorf("unexpected query: %s", query)
	})}
	c := newDDLFakeClient(t, conn)
	if _, err := c.ExportTable(context.Background(), MysqlExportSpec{Database: "app", Table: "users", IncludeData: true}); err != nil {
		t.Fatalf("ExportTable: %v", err)
	}
	if len(dataQueries) != 1 {
		t.Fatalf("expected 1 data query, got %+v", dataQueries)
	}
	if strings.Contains(dataQueries[0], "ORDER BY") {
		t.Fatalf("no primary key: must not add ORDER BY, got %s", dataQueries[0])
	}
}

func TestMysqlClientExportInsertEscaping(t *testing.T) {
	conn := &ddlFakeConn{respond: ddlShowCreateRespond(func(query string) (driver.Rows, error) {
		if strings.HasPrefix(query, "SELECT * FROM") {
			return &ddlFakeRows{
				cols: []string{"id", "bin", "note", "created"},
				vals: [][]driver.Value{
					{int64(1), []byte{0xde, 0xad}, "it's", nil},
					{int64(2), []byte{}, "多行\n文本", time.Date(2026, 9, 28, 10, 30, 0, 123456000, time.Local)},
				},
			}, nil
		}
		return nil, fmt.Errorf("unexpected query: %s", query)
	})}
	c := newDDLFakeClient(t, conn)
	res, err := c.ExportTable(context.Background(), MysqlExportSpec{Database: "app", Table: "users", IncludeData: true})
	if err != nil {
		t.Fatalf("ExportTable: %v", err)
	}
	for _, want := range []string{
		"INSERT INTO `app`.`users` (`id`, `bin`, `note`, `created`) VALUES ",
		"(1, 0xdead, 'it''s', NULL), ",
		"(2, '', '多行\n文本', '2026-09-28 10:30:00.123456')",
		"-- 表数据: app.users (2 行)",
	} {
		if !strings.Contains(res.Content, want) {
			t.Fatalf("content must contain %q, got:\n%s", want, res.Content)
		}
	}
	if n := strings.Count(res.Content, "INSERT INTO"); n != 1 {
		t.Fatalf("two rows must aggregate into one INSERT, got %d", n)
	}
}

func TestMysqlClientExportBatchesBy100Rows(t *testing.T) {
	// 120 行(< 一批)→ 2 条 INSERT(100 + 20),且 100 行处即时断句。
	var dataQueries []string
	conn := &ddlFakeConn{respond: ddlShowCreateRespond(func(query string) (driver.Rows, error) {
		if strings.HasPrefix(query, "SELECT * FROM") {
			dataQueries = append(dataQueries, query)
			return &ddlFakeRows{cols: []string{"id"}, vals: ddlExportRows(120)}, nil
		}
		return nil, fmt.Errorf("unexpected query: %s", query)
	})}
	c := newDDLFakeClient(t, conn)
	res, err := c.ExportTable(context.Background(), MysqlExportSpec{Database: "app", Table: "users", IncludeData: true})
	if err != nil {
		t.Fatalf("ExportTable: %v", err)
	}
	if n := strings.Count(res.Content, "INSERT INTO"); n != 2 {
		t.Fatalf("120 rows must split into 2 INSERT statements, got %d", n)
	}
	if !strings.Contains(res.Content, ";\n") {
		t.Fatal("each INSERT must terminate with a semicolon")
	}
	if !strings.Contains(res.Content, "-- 表数据: app.users (120 行)") {
		t.Fatalf("row count comment missing:\n%s", res.Content[:200])
	}
}

func TestMysqlClientExportPagesUntilExhausted(t *testing.T) {
	c, _, queries := newExportFakeClient(t)
	res, err := c.ExportTable(context.Background(), MysqlExportSpec{Database: "app", Table: "users", IncludeData: true})
	if err != nil {
		t.Fatalf("ExportTable: %v", err)
	}
	// 2200 行:批 1000 + 1000 + 500(第三批不足即尾页)。
	if len(*queries) != 3 {
		t.Fatalf("expected 3 data queries, got %d: %+v", len(*queries), *queries)
	}
	if n := strings.Count(res.Content, "INSERT INTO"); n != 22 {
		t.Fatalf("2200 rows must split into 22 INSERT statements, got %d", n)
	}
	if !strings.Contains(res.Content, "(2200, 'v')") {
		t.Fatal("the last exported row must be included")
	}
}

func TestMysqlClientExportDataLimitCapsRows(t *testing.T) {
	c, _, queries := newExportFakeClient(t)
	res, err := c.ExportTable(context.Background(), MysqlExportSpec{Database: "app", Table: "users", IncludeData: true, DataLimit: 1200})
	if err != nil {
		t.Fatalf("ExportTable: %v", err)
	}
	// 1200 行 = 1000 + 200:第二批 LIMIT 收缩到剩余额度。
	if len(*queries) != 2 {
		t.Fatalf("expected 2 data queries, got %d: %+v", len(*queries), *queries)
	}
	if !strings.Contains((*queries)[1], "LIMIT 200 OFFSET 1000") {
		t.Fatalf("second batch must cap its LIMIT to the remaining quota, got %q", (*queries)[1])
	}
	if n := strings.Count(res.Content, "INSERT INTO"); n != 12 {
		t.Fatalf("1200 rows must split into 12 INSERT statements, got %d", n)
	}
	if strings.Contains(res.Content, "(1201, 'v')") {
		t.Fatal("rows beyond the data limit must not be exported")
	}
}

// --- 导出选项 ---

// include_ddl=false 时不得发送 SHOW CREATE TABLE,内容只有数据段。
func TestMysqlClientExportDataOnlySkipsDDL(t *testing.T) {
	var sawShowCreate bool
	conn := &ddlFakeConn{respond: func(query string) (driver.Rows, error) {
		if strings.HasPrefix(strings.ToUpper(query), "SHOW CREATE TABLE") {
			sawShowCreate = true
			return &ddlFakeRows{cols: []string{"Table", "Create Table"}, vals: [][]driver.Value{{"users", "CREATE TABLE `users`"}}}, nil
		}
		if strings.Contains(query, "information_schema.key_column_usage") {
			return ddlPKRows(nil), nil // 无主键
		}
		if strings.HasPrefix(query, "SELECT * FROM") {
			return &ddlFakeRows{cols: []string{"id"}, vals: ddlExportRows(2)}, nil
		}
		return nil, fmt.Errorf("unexpected query: %s", query)
	}}
	c := newDDLFakeClient(t, conn)
	res, err := c.ExportTable(context.Background(), MysqlExportSpec{Database: "app", Table: "users", IncludeData: true})
	if err != nil {
		t.Fatalf("ExportTable: %v", err)
	}
	if sawShowCreate {
		t.Fatal("include_ddl=false must not query SHOW CREATE TABLE")
	}
	if strings.Contains(res.Content, "CREATE TABLE") || strings.Contains(res.Content, "-- 表结构") {
		t.Fatalf("data-only export must not contain the structure section:\n%s", res.Content)
	}
	if !strings.Contains(res.Content, "-- 表数据: app.users (2 行)") || !strings.Contains(res.Content, "INSERT INTO") {
		t.Fatalf("data-only export must still render the data section:\n%s", res.Content)
	}
}

// include_ddl 与 include_data 都为 false:中文校验错误,且不发任何查询。
func TestMysqlClientExportRejectsEmptySelection(t *testing.T) {
	conn := &ddlFakeConn{}
	c := newDDLFakeClient(t, conn)
	_, err := c.ExportTable(context.Background(), MysqlExportSpec{Database: "app", Table: "users"})
	if err == nil || !strings.Contains(err.Error(), "请至少选择导出内容") {
		t.Fatalf("both flags false must fail with the validation error, got %v", err)
	}
	if len(conn.queries) != 0 {
		t.Fatalf("validation failure must not issue any query: %+v", conn.queries)
	}
}

// insert_per_row=true:2 行数据 = 2 条独立 INSERT,各占一行。
func TestMysqlClientExportInsertPerRow(t *testing.T) {
	conn := &ddlFakeConn{respond: ddlShowCreateRespond(func(query string) (driver.Rows, error) {
		if strings.HasPrefix(query, "SELECT * FROM") {
			return &ddlFakeRows{cols: []string{"id"}, vals: ddlExportRows(2)}, nil
		}
		return nil, fmt.Errorf("unexpected query: %s", query)
	})}
	c := newDDLFakeClient(t, conn)
	res, err := c.ExportTable(context.Background(), MysqlExportSpec{Database: "app", Table: "users", IncludeData: true, InsertPerRow: true})
	if err != nil {
		t.Fatalf("ExportTable: %v", err)
	}
	if n := strings.Count(res.Content, "INSERT INTO"); n != 2 {
		t.Fatalf("2 rows with insert_per_row must yield 2 standalone INSERTs, got %d:\n%s", n, res.Content)
	}
	for _, want := range []string{"VALUES (1);\n", "VALUES (2);\n"} {
		if !strings.Contains(res.Content, want) {
			t.Fatalf("each row must be its own INSERT statement, want %q in:\n%s", want, res.Content)
		}
	}
}

// drop_table_if_exists:DROP 行位于表结构注释之后、CREATE 之前;默认不输出。
func TestMysqlClientExportDropTableIfExists(t *testing.T) {
	conn := &ddlFakeConn{respond: func(query string) (driver.Rows, error) {
		if strings.HasPrefix(strings.ToUpper(query), "SHOW CREATE TABLE") {
			return &ddlFakeRows{cols: []string{"Table", "Create Table"}, vals: [][]driver.Value{{"users", "CREATE TABLE `users` (`id` int)"}}}, nil
		}
		return nil, fmt.Errorf("unexpected query: %s", query)
	}}
	c := newDDLFakeClient(t, conn)
	res, err := c.ExportTable(context.Background(), MysqlExportSpec{Database: "app", Table: "users", IncludeDDL: true, DropTableIfExists: true})
	if err != nil {
		t.Fatalf("ExportTable: %v", err)
	}
	di := strings.Index(res.Content, "DROP TABLE IF EXISTS `users`;\n")
	ci := strings.Index(res.Content, "CREATE TABLE `users`")
	if di < 0 || ci < 0 || di > ci {
		t.Fatalf("DROP TABLE line must precede the DDL:\n%s", res.Content)
	}
	res2, err := c.ExportTable(context.Background(), MysqlExportSpec{Database: "app", Table: "users", IncludeDDL: true})
	if err != nil {
		t.Fatalf("ExportTable default: %v", err)
	}
	if strings.Contains(res2.Content, "DROP TABLE") {
		t.Fatalf("drop_table_if_exists=false must not emit DROP TABLE:\n%s", res2.Content)
	}
}

// strip_auto_increment:剥离表级 AUTO_INCREMENT=N 计数,其余表选项与列级
// AUTO_INCREMENT(语义)原样保留;不开剥离时计数保留。
func TestMysqlClientExportStripAutoIncrement(t *testing.T) {
	ddl := "CREATE TABLE `users` (`id` int NOT NULL AUTO_INCREMENT, PRIMARY KEY (`id`))" +
		" ENGINE=InnoDB AUTO_INCREMENT=123 DEFAULT CHARSET=utf8mb4"
	conn := &ddlFakeConn{respond: func(query string) (driver.Rows, error) {
		if strings.HasPrefix(strings.ToUpper(query), "SHOW CREATE TABLE") {
			return &ddlFakeRows{cols: []string{"Table", "Create Table"}, vals: [][]driver.Value{{"users", ddl}}}, nil
		}
		return nil, fmt.Errorf("unexpected query: %s", query)
	}}
	c := newDDLFakeClient(t, conn)
	res, err := c.ExportTable(context.Background(), MysqlExportSpec{Database: "app", Table: "users", IncludeDDL: true, StripAutoIncrement: true})
	if err != nil {
		t.Fatalf("ExportTable: %v", err)
	}
	if strings.Contains(res.Content, "AUTO_INCREMENT=123") {
		t.Fatalf("table-level AUTO_INCREMENT counter must be stripped:\n%s", res.Content)
	}
	if !strings.Contains(res.Content, "ENGINE=InnoDB") || !strings.Contains(res.Content, "DEFAULT CHARSET=utf8mb4") {
		t.Fatalf("other table options must survive the strip:\n%s", res.Content)
	}
	if !strings.Contains(res.Content, "`id` int NOT NULL AUTO_INCREMENT") {
		t.Fatalf("column-level AUTO_INCREMENT is semantic and must survive:\n%s", res.Content)
	}
	res2, err := c.ExportTable(context.Background(), MysqlExportSpec{Database: "app", Table: "users", IncludeDDL: true})
	if err != nil {
		t.Fatalf("ExportTable default: %v", err)
	}
	if !strings.Contains(res2.Content, "AUTO_INCREMENT=123") {
		t.Fatalf("counter must be preserved when strip is off:\n%s", res2.Content)
	}
}

// include_create_db:文件以建库 + USE 开头,字符集/排序规则来自 SCHEMATA 桩;
// 仅数据导出时头部同样生效。SCHEMATA 无行时退化为裸建库语句(两条都写)。
func TestMysqlClientExportIncludeCreateDB(t *testing.T) {
	conn := &ddlFakeConn{respond: func(query string) (driver.Rows, error) {
		if strings.Contains(query, "information_schema.SCHEMATA") {
			return &ddlFakeRows{
				cols: []string{"default_character_set_name", "default_collation_name"},
				vals: [][]driver.Value{{"utf8mb4", "utf8mb4_general_ci"}},
			}, nil
		}
		if strings.HasPrefix(strings.ToUpper(query), "SHOW CREATE TABLE") {
			return &ddlFakeRows{cols: []string{"Table", "Create Table"}, vals: [][]driver.Value{{"users", "CREATE TABLE `users` (`id` int)"}}}, nil
		}
		if strings.Contains(query, "information_schema.key_column_usage") {
			return ddlPKRows(nil), nil // 无主键
		}
		if strings.HasPrefix(query, "SELECT * FROM") {
			return &ddlFakeRows{cols: []string{"id"}, vals: ddlExportRows(1)}, nil
		}
		return nil, fmt.Errorf("unexpected query: %s", query)
	}}
	c := newDDLFakeClient(t, conn)
	res, err := c.ExportTable(context.Background(), MysqlExportSpec{Database: "app", Table: "users", IncludeDDL: true, IncludeCreateDB: true})
	if err != nil {
		t.Fatalf("ExportTable: %v", err)
	}
	want := "CREATE DATABASE IF NOT EXISTS `app` DEFAULT CHARACTER SET `utf8mb4` COLLATE `utf8mb4_general_ci`;\nUSE `app`;\n"
	if !strings.HasPrefix(res.Content, want) {
		t.Fatalf("create-db header must open the file, want prefix %q got:\n%s", want, res.Content)
	}
	if !strings.Contains(res.Content, "-- 表结构: app.users") {
		t.Fatalf("create-db header must not replace the structure section:\n%s", res.Content)
	}
	// 仅数据导出:头部独立于结构段,结构段缺席。
	res2, err := c.ExportTable(context.Background(), MysqlExportSpec{Database: "app", Table: "users", IncludeData: true, IncludeCreateDB: true})
	if err != nil {
		t.Fatalf("ExportTable data-only: %v", err)
	}
	if !strings.HasPrefix(res2.Content, want) || strings.Contains(res2.Content, "CREATE TABLE") {
		t.Fatalf("data-only export must keep the header and drop the structure section:\n%s", res2.Content)
	}
}

func TestMysqlClientExportIncludeCreateDBFallback(t *testing.T) {
	conn := &ddlFakeConn{respond: func(query string) (driver.Rows, error) {
		if strings.Contains(query, "information_schema.SCHEMATA") {
			return &ddlFakeRows{cols: []string{"default_character_set_name", "default_collation_name"}}, nil // 无行
		}
		if strings.HasPrefix(strings.ToUpper(query), "SHOW CREATE TABLE") {
			return &ddlFakeRows{cols: []string{"Table", "Create Table"}, vals: [][]driver.Value{{"users", "CREATE TABLE `users` (`id` int)"}}}, nil
		}
		return nil, fmt.Errorf("unexpected query: %s", query)
	}}
	c := newDDLFakeClient(t, conn)
	res, err := c.ExportTable(context.Background(), MysqlExportSpec{Database: "app", Table: "users", IncludeDDL: true, IncludeCreateDB: true})
	if err != nil {
		t.Fatalf("ExportTable: %v", err)
	}
	want := "CREATE DATABASE IF NOT EXISTS `app`;\nUSE `app`;\n"
	if !strings.HasPrefix(res.Content, want) {
		t.Fatalf("fallback header must open the file, want prefix %q got:\n%s", want, res.Content)
	}
}

// --- Service 层:断言 *MysqlClient 的类型守卫与委托 ---

func TestMysqlDdlServiceDelegation(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()
	c, _ := svc.CreateConnection(ctx, &model.Connection{
		Name:   "mysql-local",
		Type:   model.ConnectionTypeMySQL,
		Config: model.MustConfigJSON(model.MysqlConfig{Host: "127.0.0.1"}),
	})
	// 实现了 MysqlDataSource 但不是 *MysqlClient 的池化客户端必须被拒。
	fake := &fakeMysqlDS{}
	if err := svc.PutPooledForTest(c.ID, fake); err != nil {
		t.Fatalf("pool fake: %v", err)
	}
	if err := svc.MysqlDropTable(ctx, c.ID, "app", "users"); err == nil || !strings.Contains(err.Error(), "MySQL") {
		t.Fatalf("non-MysqlClient pooled client must be rejected, got %v", err)
	}
	if _, err := svc.MysqlTableColumns(ctx, c.ID, "app", "users"); err == nil {
		t.Fatal("non-MysqlClient pooled client must be rejected for columns too")
	}

	// 生产 *MysqlClient(fake 驱动)走通全部四个委托。
	conn := &ddlFakeConn{respond: func(query string) (driver.Rows, error) {
		if strings.Contains(query, "information_schema.columns") {
			return &ddlFakeRows{
				cols: []string{"column_name", "column_type", "data_type", "is_nullable", "column_default", "extra", "column_comment", "column_key"},
				vals: [][]driver.Value{{"id", "bigint", "bigint", "NO", nil, "", "", "PRI"}},
			}, nil
		}
		if strings.HasPrefix(strings.ToUpper(query), "SHOW CREATE TABLE") {
			return &ddlFakeRows{cols: []string{"Table", "Create Table"}, vals: [][]driver.Value{{"users", "CREATE TABLE `users`"}}}, nil
		}
		if strings.Contains(query, "information_schema.key_column_usage") {
			return &ddlFakeRows{cols: []string{"column_name"}}, nil // 无主键
		}
		if strings.HasPrefix(query, "SELECT * FROM") {
			return &ddlFakeRows{cols: []string{"id"}, vals: ddlExportRows(1)}, nil
		}
		return nil, fmt.Errorf("unexpected query: %s", query)
	}}
	client := newDDLFakeClient(t, conn)
	if err := svc.PutPooledForTest(c.ID, client); err != nil {
		t.Fatalf("pool client: %v", err)
	}
	if err := svc.MysqlDropTable(ctx, c.ID, "app", "users"); err != nil {
		t.Fatalf("MysqlDropTable: %v", err)
	}
	if len(conn.execs) != 1 || conn.execs[0] != "DROP TABLE `app`.`users`" {
		t.Fatalf("unexpected execs: %+v", conn.execs)
	}
	cols, err := svc.MysqlTableColumns(ctx, c.ID, "app", "users")
	if err != nil || len(cols.Columns) != 1 || !cols.Columns[0].IsPrimaryKey || cols.DDL == "" {
		t.Fatalf("MysqlTableColumns: %v %+v", err, cols)
	}
	if err := svc.MysqlAlterTable(ctx, c.ID, MysqlAlterTableSpec{Database: "app", Table: "users", DropColumns: []string{"id"}}); err != nil {
		t.Fatalf("MysqlAlterTable: %v", err)
	}
	if len(conn.execs) != 2 || !strings.Contains(conn.execs[1], "DROP COLUMN `id`") {
		t.Fatalf("alter must delegate: %+v", conn.execs)
	}
	// 导出经独立 builder 委托(不复用池客户端,见 MysqlExportTable):注入返回
	// 同一 fake 客户端,委托链路断言不变。
	svc.SetMysqlExportClientBuilderForTest(func(*model.Connection) (*MysqlClient, error) {
		return client, nil
	})
	res, err := svc.MysqlExportTable(ctx, c.ID, MysqlExportSpec{Database: "app", Table: "users", IncludeData: true, IncludeDDL: true})
	if err != nil || !strings.Contains(res.Content, "INSERT INTO") {
		t.Fatalf("MysqlExportTable: %v %+v", err, res)
	}
}

// TestMysqlExportUsesDedicatedConnectionNotPooled 复现线上 bug:导出曾复用
// 池内共享客户端,导出进行中一旦该连接被 断开/编辑保存/删除(CloseConnection/
// UpdateConnection/DeleteConnection 都会 Close 池内客户端),下一批次即报
// "export rows: sql: database is closed"。修复后导出使用独立专用连接,与池
// 生命周期完全解耦(MySQL/TiDB 共用同一实现,一并修复)。
func TestMysqlExportUsesDedicatedConnectionNotPooled(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()
	c, err := svc.CreateConnection(ctx, &model.Connection{
		Name:   "tidb-local",
		Type:   model.ConnectionTypeTiDB,
		Config: model.MustConfigJSON(model.MysqlConfig{Host: "127.0.0.1"}),
	})
	if err != nil {
		t.Fatalf("CreateConnection: %v", err)
	}

	// 池内客户端(用户先连接、后导出);随后 Close 它模拟导出进行中被断开。
	pooled := newDDLFakeClient(t, &ddlFakeConn{respond: func(string) (driver.Rows, error) {
		return nil, fmt.Errorf("export must never touch the pooled client")
	}})
	if err := svc.PutPooledForTest(c.ID, pooled); err != nil {
		t.Fatalf("PutPooledForTest: %v", err)
	}

	// 导出专用 builder:返回独立健康客户端,并记录收到的是哪条连接。
	exportClient := newDDLFakeClient(t, &ddlFakeConn{respond: func(query string) (driver.Rows, error) {
		if strings.HasPrefix(strings.ToUpper(query), "SHOW CREATE TABLE") {
			return &ddlFakeRows{cols: []string{"Table", "Create Table"}, vals: [][]driver.Value{{"users", "CREATE TABLE `users`"}}}, nil
		}
		if strings.Contains(query, "information_schema.key_column_usage") {
			return &ddlFakeRows{cols: []string{"column_name"}}, nil // 无主键
		}
		if strings.HasPrefix(query, "SELECT * FROM") {
			return &ddlFakeRows{cols: []string{"id"}, vals: ddlExportRows(2)}, nil
		}
		return nil, fmt.Errorf("unexpected export query: %s", query)
	}})
	t.Cleanup(func() { _ = exportClient.Close() })
	var builderConnID string
	svc.SetMysqlExportClientBuilderForTest(func(conn *model.Connection) (*MysqlClient, error) {
		builderConnID = conn.ID
		return exportClient, nil
	})

	// 导出开始前连接已被断开(池内客户端已 Close):导出必须照常完成。
	if err := pooled.Close(); err != nil {
		t.Fatalf("close pooled: %v", err)
	}

	res, err := svc.MysqlExportTable(ctx, c.ID, MysqlExportSpec{Database: "app", Table: "users", IncludeData: true, IncludeDDL: true})
	if err != nil {
		t.Fatalf("export must not depend on the pooled client lifecycle, got %v", err)
	}
	if builderConnID != c.ID {
		t.Fatalf("builder must receive the connection being exported, got %q", builderConnID)
	}
	if !strings.Contains(res.Content, "CREATE TABLE `users`") || !strings.Contains(res.Content, "INSERT INTO") {
		t.Fatalf("unexpected export content: %q", res.Content)
	}
}
