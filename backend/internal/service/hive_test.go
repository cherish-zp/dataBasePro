package service

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"testing"

	_ "modernc.org/sqlite"

	"dataBasePro/backend/internal/model"
	"dataBasePro/backend/internal/store"
)

// --- 离线 fake:HiveConn/HiveRows 的最小实现(不触网) ---

type fakeHiveConn struct {
	execs   []string
	queries []string
	onExec  func(query string) error
	onQuery func(query string) (HiveRows, error)
	closed  bool
}

func (f *fakeHiveConn) Exec(_ context.Context, query string) error {
	f.execs = append(f.execs, query)
	if f.onExec != nil {
		return f.onExec(query)
	}
	return nil
}

func (f *fakeHiveConn) Query(_ context.Context, query string) (HiveRows, error) {
	f.queries = append(f.queries, query)
	if f.onQuery != nil {
		return f.onQuery(query)
	}
	return &fakeHiveRows{cols: []model.HiveColumn{{Name: "a", Type: "int"}}}, nil
}

func (f *fakeHiveConn) Close() error { f.closed = true; return nil }

type fakeHiveRows struct {
	cols []model.HiveColumn
	rows [][]*string
	pos  int
	err  error
}

func (r *fakeHiveRows) Columns() []model.HiveColumn { return r.cols }

func (r *fakeHiveRows) Next(_ context.Context) ([]*string, bool, error) {
	if r.err != nil {
		return nil, false, r.err
	}
	if r.pos >= len(r.rows) {
		return nil, false, nil
	}
	row := r.rows[r.pos]
	r.pos++
	return row, true, nil
}

func (r *fakeHiveRows) Close() {}

func sp(s string) *string { return &s }

// --- DESCRIBE FORMATTED 文本夹具 ---

// fakeHiveDescRows renders one transactional(可调)内部表的 DESCRIBE FORMATTED
// 行集:普通列 id/name、分区列 dt、Table Type 与 Table Parameters。
func fakeHiveDescRows(transactional bool, tableType string) *fakeHiveRows {
	transactionalVal := "false"
	if transactional {
		transactionalVal = "true"
	}
	return &fakeHiveRows{
		cols: []model.HiveColumn{{Name: "col_name", Type: "string"}, {Name: "data_type", Type: "string"}, {Name: "comment", Type: "string"}},
		rows: [][]*string{
			{sp("# col_name"), sp("data_type"), sp("comment")},
			{sp(""), sp(""), sp("")},
			{sp("id"), sp("int"), sp("主键")},
			{sp("name"), sp("string"), sp("")},
			{sp(""), sp(""), sp("")},
			{sp("# Partition Information"), sp(""), sp("")},
			{sp("# col_name"), sp("data_type"), sp("comment")},
			{sp(""), sp(""), sp("")},
			{sp("dt"), sp("string"), sp("")},
			{sp(""), sp(""), sp("")},
			{sp("# Detailed Table Information"), sp(""), sp("")},
			{sp("Table:"), sp("t"), sp("")},
			{sp("Table Type:"), sp(tableType), sp("")},
			{sp("# Table Parameters:"), sp("null"), sp("")},
			{sp("EXTERNAL"), sp("TRUE"), sp("")},
			{sp("transactional"), sp(transactionalVal), sp("")},
			{sp("transient_lastDdlTime"), sp("1690000000"), sp("")},
			{sp("# Storage Information"), sp(""), sp("")},
			{sp("Location:"), sp("hdfs://nameservice/warehouse/t"), sp("")},
		},
	}
}

const fakeHiveDDL = "CREATE TABLE `t`(\n" +
	"  `id` int COMMENT '主键',\n" +
	"  `name` string,\n" +
	"  `dt` string)\n" +
	"CONSTRAINT `pk_t` PRIMARY KEY (`id`) RELIED UPON\n" +
	"PARTITIONED BY (\n" +
	"  `dt` string)\n" +
	"STORED AS ORC"

// newFakeHiveClient wires a HiveClient with standard metadata routing:
// DESCRIBE FORMATTED → fakeHiveDescRows,SHOW CREATE TABLE → DDL,其余由
// extra 提供的 onQuery 兜底。
func newFakeHiveClient(transactional bool, tableType string, extra func(query string) (HiveRows, error)) (*HiveClient, *fakeHiveConn) {
	conn := &fakeHiveConn{
		onQuery: func(query string) (HiveRows, error) {
			switch {
			case strings.HasPrefix(query, "DESCRIBE FORMATTED"):
				return fakeHiveDescRows(transactional, tableType), nil
			case strings.HasPrefix(query, "SHOW CREATE TABLE"):
				return &fakeHiveRows{
					cols: []model.HiveColumn{{Name: "createtab_stmt", Type: "string"}},
					rows: [][]*string{{sp(fakeHiveDDL)}},
				}, nil
			}
			if extra != nil {
				return extra(query)
			}
			return &fakeHiveRows{cols: []model.HiveColumn{{Name: "x", Type: "string"}}}, nil
		},
	}
	return NewHiveClientWithConn(conn, "dw"), conn
}

// --- DESCRIBE FORMATTED 解析 ---

// hiveDescPlain 把 DESCRIBE FORMATTED 桩行转成 parseHiveDescribeFormatted 的
// 纯字符串输入(测试适配)。
func hiveDescPlain(rows [][]*string) [][]string {
	out := make([][]string, len(rows))
	for i, row := range rows {
		r := make([]string, len(row))
		for j, cell := range row {
			if cell != nil {
				r[j] = *cell
			}
		}
		out[i] = r
	}
	return out
}

func TestParseHiveDescribeFormatted(t *testing.T) {
	meta := parseHiveDescribeFormatted(hiveDescPlain(fakeHiveDescRows(true, model.HiveTableTypeManaged).rows))
	if len(meta.Columns) != 2 {
		t.Fatalf("columns = %+v, want id/name", meta.Columns)
	}
	if meta.Columns[0].Name != "id" || meta.Columns[0].Type != "int" || meta.Columns[0].Comment != "主键" {
		t.Fatalf("column 0 = %+v", meta.Columns[0])
	}
	if meta.Columns[1].Name != "name" || meta.Columns[1].Comment != "" {
		t.Fatalf("column 1 = %+v", meta.Columns[1])
	}
	if len(meta.PartitionColumns) != 1 || meta.PartitionColumns[0].Name != "dt" {
		t.Fatalf("partition columns = %+v", meta.PartitionColumns)
	}
	if !meta.Transactional {
		t.Fatal("transactional must be parsed from Table Parameters")
	}
	if meta.TableType != model.HiveTableTypeManaged {
		t.Fatalf("table type = %q", meta.TableType)
	}
}

func TestParseHiveDescribeFormatted_NonTransactionalExternal(t *testing.T) {
	meta := parseHiveDescribeFormatted(hiveDescPlain(fakeHiveDescRows(false, model.HiveTableTypeExternal).rows))
	if meta.Transactional {
		t.Fatal("transactional=false must not be flagged")
	}
	if meta.TableType != model.HiveTableTypeExternal {
		t.Fatalf("table type = %q", meta.TableType)
	}
	// EXTERNAL=TRUE 参数行不得混入列清单。
	for _, col := range meta.Columns {
		if strings.EqualFold(col.Name, "EXTERNAL") || strings.EqualFold(col.Name, "transactional") {
			t.Fatalf("parameter row leaked into columns: %+v", meta.Columns)
		}
	}
}

func TestParseHivePrimaryKey(t *testing.T) {
	pk := parseHivePrimaryKey(fakeHiveDDL)
	if len(pk) != 1 || pk[0] != "id" {
		t.Fatalf("pk = %v, want [id]", pk)
	}
	if got := parseHivePrimaryKey("CREATE TABLE t(id int)"); got != nil {
		t.Fatalf("ddl without constraint must return nil, got %v", got)
	}
	pk2 := parseHivePrimaryKey("CONSTRAINT `t_pk` PRIMARY KEY (`a`, `b`) RELIED UPON")
	if len(pk2) != 2 || pk2[0] != "a" || pk2[1] != "b" {
		t.Fatalf("composite pk = %v", pk2)
	}
}

// --- SQL 构造 ---

func TestBuildHivePageQuery(t *testing.T) {
	got := buildHivePageQuery("dw", "t", []string{"id", "name"}, 20, 40)
	want := "SELECT `id`, `name` FROM (SELECT `id`, `name`, ROW_NUMBER() OVER () AS `_dbp_rn`" +
		" FROM `dw`.`t`) `_dbp` WHERE `_dbp_rn` > 40 AND `_dbp_rn` <= 60"
	if got != want {
		t.Fatalf("page query = %s, want %s", got, want)
	}
}

func TestWrapHivePagedQuery(t *testing.T) {
	got := wrapHivePagedQuery("SELECT id FROM t ORDER BY id;", 10, 5)
	if !strings.Contains(got, "FROM (SELECT id FROM t) `_q`") {
		t.Fatalf("wrap must nest the statement body: %s", got)
	}
	if !strings.Contains(got, "ROW_NUMBER() OVER () AS `_dbp_rn`") {
		t.Fatalf("wrap must add row number column: %s", got)
	}
	if !strings.Contains(got, "`_dbp_rn` > 5 AND `_dbp_rn` <= 15") {
		t.Fatalf("wrap window wrong: %s", got)
	}
	if !strings.HasSuffix(got, " ORDER BY id") {
		t.Fatalf("trailing ORDER BY must be hoisted outside: %s", got)
	}
	if strings.Contains(got, ";") {
		t.Fatalf("trailing semicolon must be stripped: %s", got)
	}
}

func TestStripHiveRowNumber(t *testing.T) {
	cols := []model.HiveColumn{{Name: "id", Type: "int"}, {Name: hivePageRowNumberCol, Type: "bigint"}}
	rows := [][]*string{{sp("1"), sp("1")}, {sp("2"), sp("2")}}
	outCols, outRows := stripHiveRowNumber(cols, rows)
	if len(outCols) != 1 || outCols[0].Name != "id" {
		t.Fatalf("cols after strip = %+v", outCols)
	}
	if len(outRows) != 2 || len(outRows[0]) != 1 || *outRows[1][0] != "2" {
		t.Fatalf("rows after strip = %+v", outRows)
	}
	// 无行号列时原样返回。
	c2 := []model.HiveColumn{{Name: "id", Type: "int"}}
	gc, gr := stripHiveRowNumber(c2, rows)
	if len(gc) != 1 || len(gr) != 2 || len(gr[0]) != 2 {
		t.Fatal("non-matching result must pass through unchanged")
	}
}

// --- 单元格类型转换 ---

func TestHiveThriftToHiveType(t *testing.T) {
	cases := map[string]string{
		"INT_TYPE":       "int",
		"BIGINT_TYPE":    "bigint",
		"STRING_TYPE":    "string",
		"BOOLEAN_TYPE":   "boolean",
		"DOUBLE_TYPE":    "double",
		"DECIMAL_TYPE":   "decimal",
		"TIMESTAMP_TYPE": "timestamp",
	}
	for in, want := range cases {
		if got := hiveThriftToHiveType(in); got != want {
			t.Fatalf("hiveThriftToHiveType(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestHiveDestsToCells(t *testing.T) {
	dests := []any{
		newHiveDest("BOOLEAN_TYPE"), newHiveDest("BIGINT_TYPE"),
		newHiveDest("DOUBLE_TYPE"), newHiveDest("STRING_TYPE"),
		newHiveDest("TINYINT_TYPE"), newHiveDest("BINARY_TYPE"),
		newHiveDest("INT_TYPE"), newHiveDest("SMALLINT_TYPE"),
	}
	*(dests[0].(**bool)) = func() *bool { b := true; return &b }()
	*(dests[1].(**int64)) = func() *int64 { v := int64(-42); return &v }()
	*(dests[2].(**float64)) = func() *float64 { v := 1.5; return &v }()
	*(dests[3].(**string)) = func() *string { v := "héllo"; return &v }()
	*(dests[4].(**int8)) = func() *int8 { v := int8(7); return &v }()
	*(dests[5].(**[]byte)) = func() *[]byte { v := []byte("bin"); return &v }()
	// INT/SMALLINT 保持 nil → NULL。
	cells := hiveDestsToCells(dests)
	if cells[0] == nil || *cells[0] != "true" {
		t.Fatalf("bool cell = %v", cells[0])
	}
	if cells[1] == nil || *cells[1] != "-42" {
		t.Fatalf("int64 cell = %v", cells[1])
	}
	if cells[2] == nil || *cells[2] != "1.5" {
		t.Fatalf("float cell = %v", cells[2])
	}
	if cells[3] == nil || *cells[3] != "héllo" {
		t.Fatalf("string cell = %v", cells[3])
	}
	if cells[4] == nil || *cells[4] != "7" {
		t.Fatalf("int8 cell = %v", cells[4])
	}
	if cells[5] == nil || *cells[5] != "bin" {
		t.Fatalf("binary cell = %v", cells[5])
	}
	if cells[6] != nil || cells[7] != nil {
		t.Fatalf("nil dests must be NULL cells: %v %v", cells[6], cells[7])
	}
}

// --- 元数据访问 ---

func TestHiveClientDatabasesAndTables(t *testing.T) {
	conn := &fakeHiveConn{onQuery: func(query string) (HiveRows, error) {
		switch query {
		case "SHOW DATABASES":
			return &fakeHiveRows{cols: []model.HiveColumn{{Name: "database_name", Type: "string"}},
				rows: [][]*string{{sp("default")}, {sp("dw")}}}, nil
		case "SHOW TABLES IN `dw`":
			return &fakeHiveRows{cols: []model.HiveColumn{{Name: "tab_name", Type: "string"}},
				rows: [][]*string{{sp("t")}}}, nil
		}
		return nil, fmt.Errorf("unexpected query %q", query)
	}}
	client := NewHiveClientWithConn(conn, "dw")
	ctx := context.Background()
	dbs, err := client.Databases(ctx)
	if err != nil {
		t.Fatalf("Databases: %v", err)
	}
	if len(dbs) != 2 || dbs[1] != "dw" {
		t.Fatalf("databases = %v", dbs)
	}
	tables, err := client.Tables(ctx, "dw")
	if err != nil {
		t.Fatalf("Tables: %v", err)
	}
	if len(tables) != 1 || tables[0].Name != "t" {
		t.Fatalf("tables = %+v", tables)
	}
	if tables[0].Name == "" {
		t.Fatal("table name must be set")
	}
}

func TestHiveClientTableColumns(t *testing.T) {
	client, _ := newFakeHiveClient(true, model.HiveTableTypeManaged, nil)
	res, err := client.TableColumns(context.Background(), "dw", "t")
	if err != nil {
		t.Fatalf("TableColumns: %v", err)
	}
	if len(res.Columns) != 2 || len(res.PartitionColumns) != 1 {
		t.Fatalf("columns = %+v, partitions = %+v", res.Columns, res.PartitionColumns)
	}
	if !res.Transactional || res.TableType != model.HiveTableTypeManaged {
		t.Fatalf("transactional/type = %v/%q", res.Transactional, res.TableType)
	}
	if len(res.PrimaryKey) != 1 || res.PrimaryKey[0] != "id" {
		t.Fatalf("primary key = %v", res.PrimaryKey)
	}
	if res.DDL != fakeHiveDDL {
		t.Fatalf("ddl = %q", res.DDL)
	}
}

// --- PageRows ---

func TestHiveClientPageRows(t *testing.T) {
	pageRows := &fakeHiveRows{
		cols: []model.HiveColumn{
			{Name: "id", Type: "int"}, {Name: "name", Type: "string"}, {Name: "dt", Type: "string"},
		},
		rows: [][]*string{{sp("1"), sp("alice"), sp("2026-01-01")}, {sp("2"), nil, sp("2026-01-02")}},
	}
	client, conn := newFakeHiveClient(true, model.HiveTableTypeManaged, func(query string) (HiveRows, error) {
		if strings.HasPrefix(query, "SELECT `id`") && strings.Contains(query, "_dbp_rn") {
			return pageRows, nil
		}
		if query == "SELECT COUNT(*) FROM `dw`.`t`" {
			return &fakeHiveRows{cols: []model.HiveColumn{{Name: "_c0", Type: "bigint"}},
				rows: [][]*string{{sp("123")}}}, nil
		}
		return nil, fmt.Errorf("unexpected query %q", query)
	})
	res, err := client.PageRows(context.Background(), "dw", "t", 20, 40)
	if err != nil {
		t.Fatalf("PageRows: %v", err)
	}
	if res.TotalRows != 123 {
		t.Fatalf("total rows = %d", res.TotalRows)
	}
	if len(res.Rows) != 2 || res.Rows[1][1] != nil {
		t.Fatalf("rows = %+v (NULL cell must stay nil)", res.Rows)
	}
	// 类型被 DESCRIBE 元数据覆盖(含分区列)。
	if len(res.Columns) != 3 || res.Columns[2].Name != "dt" {
		t.Fatalf("columns = %+v", res.Columns)
	}
	var countQueries []string
	for _, q := range conn.queries {
		if strings.HasPrefix(q, "SELECT COUNT(*)") {
			countQueries = append(countQueries, q)
		}
	}
	if len(countQueries) != 1 || countQueries[0] != "SELECT COUNT(*) FROM `dw`.`t`" {
		t.Fatalf("count queries = %v", countQueries)
	}
}

func TestHiveClientPageRows_RejectsNonPositiveLimit(t *testing.T) {
	client, _ := newFakeHiveClient(true, model.HiveTableTypeManaged, nil)
	if _, err := client.PageRows(context.Background(), "dw", "t", 0, 0); err == nil {
		t.Fatal("limit<=0 must be rejected")
	}
}

// --- Execute ---

func TestHiveClientExecute_WrappedAndFallback(t *testing.T) {
	client, conn := newFakeHiveClient(true, model.HiveTableTypeManaged, func(query string) (HiveRows, error) {
		switch {
		case strings.HasPrefix(query, "SELECT * FROM (SELECT _q.*"):
			return &fakeHiveRows{
				cols: []model.HiveColumn{{Name: "id", Type: "int"}, {Name: hivePageRowNumberCol, Type: "bigint"}},
				rows: [][]*string{{sp("1"), sp("1")}, {sp("2"), sp("2")}},
			}, nil
		case strings.HasPrefix(query, "SELECT COUNT(*) FROM ("):
			return &fakeHiveRows{cols: []model.HiveColumn{{Name: "_c0", Type: "bigint"}},
				rows: [][]*string{{sp("57")}}}, nil
		case strings.HasPrefix(query, "SHOW TABLES"):
			return &fakeHiveRows{cols: []model.HiveColumn{{Name: "tab_name", Type: "string"}},
				rows: [][]*string{{sp("t1")}, {sp("t2")}, {sp("t3")}}}, nil
		}
		return nil, fmt.Errorf("unexpected query %q", query)
	})
	results, err := client.Execute(context.Background(), "dw",
		"SELECT id FROM t; SHOW TABLES; SET hive.cli.print.header = false", 2, 0)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if len(results) != 3 {
		t.Fatalf("results = %d", len(results))
	}
	// 语句 1:可包装 SELECT → ROW_NUMBER 窗口 + COUNT,行号列剥离。
	r1 := results[0]
	if r1.Error != "" {
		t.Fatalf("stmt 1 error: %s", r1.Error)
	}
	if r1.SQL != "SELECT id FROM t" {
		t.Fatalf("res.SQL must keep the user text, got %q", r1.SQL)
	}
	if r1.TotalRows == nil || *r1.TotalRows != 57 {
		t.Fatalf("wrapped total_rows = %v", r1.TotalRows)
	}
	if len(r1.Columns) != 1 || r1.Columns[0].Name == hivePageRowNumberCol {
		t.Fatalf("row number column must be stripped, cols = %+v", r1.Columns)
	}
	if len(r1.Rows) != 2 || len(r1.Rows[0]) != 1 {
		t.Fatalf("wrapped rows = %+v", r1.Rows)
	}
	// 语句 2:SHOW → 截断回退,只消费 offset+limit 行,取满 limit → total=-1。
	r2 := results[1]
	if r2.Error != "" {
		t.Fatalf("stmt 2 error: %s", r2.Error)
	}
	if len(r2.Rows) != 2 {
		t.Fatalf("truncated rows = %+v", r2.Rows)
	}
	if r2.TotalRows == nil || *r2.TotalRows != -1 {
		t.Fatalf("fallback total_rows = %v", r2.TotalRows)
	}
	// 语句 3:SET 不返回行 → Exec 路径;database 非空 → 先 USE。
	if len(conn.execs) != 2 {
		t.Fatalf("execs = %v", conn.execs)
	}
	if conn.execs[0] != "USE `dw`" {
		t.Fatalf("USE must run first, execs = %v", conn.execs)
	}
	if !strings.HasPrefix(conn.execs[1], "SET ") {
		t.Fatalf("non-result statements must run via exec, execs = %v", conn.execs)
	}
}

func TestHiveClientExecute_FailingStatementStops(t *testing.T) {
	client, conn := newFakeHiveClient(true, model.HiveTableTypeManaged, func(query string) (HiveRows, error) {
		if strings.HasPrefix(query, "SELECT boom") {
			return nil, errors.New("compile error")
		}
		return &fakeHiveRows{cols: []model.HiveColumn{{Name: "x", Type: "string"}},
			rows: [][]*string{{sp("v")}}}, nil
	})
	results, err := client.Execute(context.Background(), "", "SELECT 1; SELECT boom; SELECT 3", 0, 0)
	if err != nil {
		t.Fatalf("Execute must not return hard error: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("run must stop at the failing statement, got %d results", len(results))
	}
	if results[1].Error == "" {
		t.Fatal("failing statement must carry its error text")
	}
	// 空 database → 不发 USE。
	for _, q := range conn.execs {
		if strings.HasPrefix(q, "USE ") {
			t.Fatalf("USE must not run for empty database, execs = %v", conn.execs)
		}
	}
}

// --- 单元格字面量与定位校验 ---

func TestHiveCellLiteral(t *testing.T) {
	i := "42"
	if got, err := hiveCellLiteral("int", &i); err != nil || got != "42" {
		t.Fatalf("int literal = %s, %v", got, err)
	}
	d := "1.25"
	if got, err := hiveCellLiteral("decimal(10,2)", &d); err != nil || got != "1.25" {
		t.Fatalf("decimal literal = %s, %v", got, err)
	}
	if _, err := hiveCellLiteral("bigint", sp("abc")); err == nil {
		t.Fatal("non-numeric value for numeric type must fail")
	}
	if got, err := hiveCellLiteral("boolean", sp("TRUE")); err != nil || got != "TRUE" {
		t.Fatalf("boolean literal = %s, %v", got, err)
	}
	if _, err := hiveCellLiteral("boolean", sp("yes")); err == nil {
		t.Fatal("invalid boolean must fail")
	}
	if got, err := hiveCellLiteral("string", sp("o'br'ien")); err != nil || got != `'o''br''ien'` {
		t.Fatalf("string literal = %s, %v", got, err)
	}
	if got, err := hiveCellLiteral("int", nil); err != nil || got != "NULL" {
		t.Fatalf("nil value = %s, %v", got, err)
	}
}

func TestValidateHiveEditWhere(t *testing.T) {
	pk := []string{"id"}
	all := []string{"id", "name", "dt"}
	ok := []model.HiveCellRef{{Column: "id", Type: "int", Value: sp("1")}}
	if err := validateHiveEditWhere(ok, pk, all); err != nil {
		t.Fatalf("pk mode must pass: %v", err)
	}
	whole := []model.HiveCellRef{
		{Column: "dt", Type: "string", Value: sp("x")},
		{Column: "id", Type: "int", Value: sp("1")},
		{Column: "name", Type: "string", Value: nil},
	}
	if err := validateHiveEditWhere(whole, nil, all); err != nil {
		t.Fatalf("whole-row mode must pass without pk: %v", err)
	}
	if err := validateHiveEditWhere(whole, pk, all); err != nil {
		t.Fatalf("whole-row mode must pass with pk: %v", err)
	}
	mixed := []model.HiveCellRef{{Column: "id", Type: "int", Value: sp("1")}, {Column: "name", Type: "string", Value: sp("x")}}
	if err := validateHiveEditWhere(mixed, pk, all); err == nil {
		t.Fatal("pk+extra mixed conditions must be rejected")
	}
	if err := validateHiveEditWhere(nil, pk, all); err == nil {
		t.Fatal("empty where must be rejected")
	}
	partial := []model.HiveCellRef{{Column: "name", Type: "string", Value: sp("x")}}
	if err := validateHiveEditWhere(partial, nil, all); err == nil {
		t.Fatal("partial columns without pk must be rejected")
	}
}

// --- ACID 校验与单元格更新/按行删除 ---

func TestHiveClientUpdateCell_ACIDAndLocation(t *testing.T) {
	// 非 ACID 表拒绝。
	client, _ := newFakeHiveClient(false, model.HiveTableTypeManaged, nil)
	err := client.UpdateCell(context.Background(), "dw", "t",
		model.HiveCellRef{Column: "name", Type: "string", Value: sp("x")},
		[]model.HiveCellRef{{Column: "id", Type: "int", Value: sp("1")}})
	if err == nil || !strings.Contains(err.Error(), "ACID") {
		t.Fatalf("non-transactional table must be rejected, got %v", err)
	}

	client, conn := newFakeHiveClient(true, model.HiveTableTypeManaged, nil)
	ctx := context.Background()
	if err := client.UpdateCell(ctx, "dw", "t",
		model.HiveCellRef{Column: "name", Type: "string", Value: sp("o'neil")},
		[]model.HiveCellRef{{Column: "id", Type: "int", Value: sp("1")}}); err != nil {
		t.Fatalf("UpdateCell: %v", err)
	}
	var updates []string
	for _, e := range conn.execs {
		if strings.HasPrefix(e, "UPDATE ") {
			updates = append(updates, e)
		}
	}
	want := "UPDATE `dw`.`t` SET `name` = 'o''neil' WHERE `id` = 1"
	if len(updates) != 1 || updates[0] != want {
		t.Fatalf("updates = %v, want %s", updates, want)
	}

	// 分区列不可更新。
	err = client.UpdateCell(ctx, "dw", "t",
		model.HiveCellRef{Column: "dt", Type: "string", Value: sp("x")},
		[]model.HiveCellRef{{Column: "id", Type: "int", Value: sp("1")}})
	if err == nil || !strings.Contains(err.Error(), "分区列") {
		t.Fatalf("partition column update must be rejected, got %v", err)
	}

	// 整行定位(含 NULL → IS NULL)可用。
	whole := []model.HiveCellRef{
		{Column: "id", Type: "int", Value: sp("1")},
		{Column: "name", Type: "string", Value: nil},
		{Column: "dt", Type: "string", Value: sp("2026-01-01")},
	}
	if err := client.UpdateCell(ctx, "dw", "t",
		model.HiveCellRef{Column: "name", Type: "string", Value: sp("y")}, whole); err != nil {
		t.Fatalf("whole-row update: %v", err)
	}
	found := false
	for _, e := range conn.execs {
		if strings.Contains(e, "`name` IS NULL") && strings.Contains(e, "SET `name` = 'y'") {
			found = true
		}
	}
	if !found {
		t.Fatalf("whole-row update with IS NULL missing, execs = %v", conn.execs)
	}
}

func TestHiveClientPreviewCellUpdateAndDeleteRow(t *testing.T) {
	client, conn := newFakeHiveClient(true, model.HiveTableTypeManaged, func(query string) (HiveRows, error) {
		if strings.HasPrefix(query, "SELECT COUNT(*) FROM `dw`.`t` WHERE") {
			return &fakeHiveRows{cols: []model.HiveColumn{{Name: "_c0", Type: "bigint"}},
				rows: [][]*string{{sp("3")}}}, nil
		}
		return nil, fmt.Errorf("unexpected query %q", query)
	})
	ctx := context.Background()
	where := []model.HiveCellRef{{Column: "id", Type: "int", Value: sp("1")}}
	preview, err := client.PreviewCellUpdate(ctx, "dw", "t",
		model.HiveCellRef{Column: "name", Type: "string", Value: sp("x")}, where)
	if err != nil {
		t.Fatalf("PreviewCellUpdate: %v", err)
	}
	if preview.MatchedRows != 3 {
		t.Fatalf("matched rows = %d", preview.MatchedRows)
	}
	if preview.Statement != "UPDATE `dw`.`t` SET `name` = 'x' WHERE `id` = 1" {
		t.Fatalf("statement = %q", preview.Statement)
	}
	dpreview, err := client.PreviewDeleteRow(ctx, "dw", "t", where)
	if err != nil {
		t.Fatalf("PreviewDeleteRow: %v", err)
	}
	if dpreview.Statement != "DELETE FROM `dw`.`t` WHERE `id` = 1" {
		t.Fatalf("delete statement = %q", dpreview.Statement)
	}
	if dpreview.MatchedRows != 3 {
		t.Fatalf("delete matched rows = %d", dpreview.MatchedRows)
	}
	if err := client.DeleteRow(ctx, "dw", "t", where); err != nil {
		t.Fatalf("DeleteRow: %v", err)
	}
	var deletes []string
	for _, e := range conn.execs {
		if strings.HasPrefix(e, "DELETE FROM ") {
			deletes = append(deletes, e)
		}
	}
	if len(deletes) != 1 || deletes[0] != "DELETE FROM `dw`.`t` WHERE `id` = 1" {
		t.Fatalf("deletes = %v", deletes)
	}
}

// --- 截断 / 删除表 ---

func TestHiveClientTruncateTable(t *testing.T) {
	client, conn := newFakeHiveClient(true, model.HiveTableTypeManaged, nil)
	if err := client.TruncateTable(context.Background(), "dw", "t"); err != nil {
		t.Fatalf("TruncateTable: %v", err)
	}
	if len(conn.execs) != 1 || conn.execs[0] != "TRUNCATE TABLE `dw`.`t`" {
		t.Fatalf("execs = %v", conn.execs)
	}
	for _, tt := range []string{model.HiveTableTypeExternal, model.HiveTableTypeView} {
		client, _ := newFakeHiveClient(false, tt, nil)
		if err := client.TruncateTable(context.Background(), "dw", "t"); err == nil {
			t.Fatalf("table type %s must be rejected", tt)
		}
	}
}

func TestHiveClientDropTable(t *testing.T) {
	client, conn := newFakeHiveClient(true, model.HiveTableTypeManaged, nil)
	if err := client.DropTable(context.Background(), "dw", "t"); err != nil {
		t.Fatalf("DropTable: %v", err)
	}
	if len(conn.execs) != 1 || conn.execs[0] != "DROP TABLE `dw`.`t`" {
		t.Fatalf("execs = %v", conn.execs)
	}
}

// --- 编辑表字段 ---

func TestValidateHiveColumnType(t *testing.T) {
	good := []string{
		"int", "bigint", "string", "varchar(20)", "char(5)", "decimal(10,2)",
		"array<string>", "map<string,int>", "struct<a:int,b:string>",
		"map<string,struct<a:int,b:decimal(10,2)>>", "uniontype<int,string>",
		"timestamp with local time zone", "double precision",
	}
	for _, s := range good {
		if err := validateHiveColumnType(s); err != nil {
			t.Fatalf("type %q must pass, got %v", s, err)
		}
	}
	bad := []string{
		"", "int, DROP COLUMN `password`", "int; DROP TABLE t", "int comments 'x'",
		"int) --", "int drop column c", "map<string,int", "'int'", "int\\",
		"int (drop column c)",
	}
	for _, s := range bad {
		if err := validateHiveColumnType(s); err == nil {
			t.Fatalf("type %q must be rejected", s)
		}
	}
}

func TestHiveClientAlterTable(t *testing.T) {
	client, conn := newFakeHiveClient(true, model.HiveTableTypeManaged, nil)
	ctx := context.Background()
	spec := HiveAlterTableSpec{
		Database: "dw", Table: "t",
		AddColumns:    []HiveColumnDef{{Name: "age", Type: "int", Comment: "年龄"}},
		ModifyColumns: []HiveColumnDef{{Name: "name", Type: "string", Comment: "姓名"}},
	}
	if err := client.AlterTable(ctx, spec); err != nil {
		t.Fatalf("AlterTable: %v", err)
	}
	want := []string{
		"ALTER TABLE `dw`.`t` ADD COLUMNS (`age` int COMMENT '年龄')",
		"ALTER TABLE `dw`.`t` CHANGE COLUMN `name` `name` string COMMENT '姓名'",
	}
	if len(conn.execs) != len(want) {
		t.Fatalf("execs = %v, want %v", conn.execs, want)
	}
	for i, w := range want {
		if conn.execs[i] != w {
			t.Fatalf("exec %d = %q, want %q", i, conn.execs[i], w)
		}
	}
}

func TestHiveClientAlterTable_DropColumnFallback(t *testing.T) {
	var stmts []string
	client, _ := newFakeHiveClient(true, model.HiveTableTypeManaged, nil)
	// 拦截 exec:DROP COLUMN 报错(模拟 Hive 2),REPLACE COLUMNS 成功并记录。
	client.conn = &recExecHiveConn{
		HiveConn: client.conn,
		onExec: func(query string) error {
			stmts = append(stmts, query)
			if strings.Contains(query, "DROP COLUMN") {
				return errors.New("hive 2: drop column unsupported")
			}
			return nil
		},
	}
	spec := HiveAlterTableSpec{Database: "dw", Table: "t", DropColumns: []string{"name"}}
	if err := client.AlterTable(context.Background(), spec); err != nil {
		t.Fatalf("AlterTable fallback: %v", err)
	}
	if len(stmts) != 2 {
		t.Fatalf("stmts = %v", stmts)
	}
	if stmts[0] != "ALTER TABLE `dw`.`t` DROP COLUMN `name`" {
		t.Fatalf("drop stmt = %q", stmts[0])
	}
	// REPLACE COLUMNS 剔除 name,保留 id 与注释(分区列不参与重建)。
	wantReplace := "ALTER TABLE `dw`.`t` REPLACE COLUMNS (`id` int COMMENT '主键')"
	if stmts[1] != wantReplace {
		t.Fatalf("replace stmt = %q, want %q", stmts[1], wantReplace)
	}
}

func TestHiveClientAlterTable_Validation(t *testing.T) {
	client, _ := newFakeHiveClient(true, model.HiveTableTypeManaged, nil)
	ctx := context.Background()
	if err := client.AlterTable(ctx, HiveAlterTableSpec{Database: "dw", Table: "t"}); err == nil {
		t.Fatal("empty spec must be rejected")
	}
	err := client.AlterTable(ctx, HiveAlterTableSpec{Database: "dw", Table: "t",
		AddColumns: []HiveColumnDef{{Name: "c", Type: "int; DROP TABLE t"}}})
	if err == nil || !strings.Contains(err.Error(), "不合法") {
		t.Fatalf("injected type must be rejected, got %v", err)
	}
	err = client.AlterTable(ctx, HiveAlterTableSpec{Database: "dw", Table: "t",
		DropColumns: []string{" "}})
	if err == nil {
		t.Fatal("blank drop column must be rejected")
	}
}

// recExecHiveConn 在既有 fake 之上拦截 exec(复用 onQuery 路由)。
type recExecHiveConn struct {
	HiveConn
	onExec func(query string) error
}

func (r *recExecHiveConn) Exec(ctx context.Context, query string) error {
	return r.onExec(query)
}

// --- 导出表结构 ---

func TestHiveClientExportTable(t *testing.T) {
	client, _ := newFakeHiveClient(true, model.HiveTableTypeManaged, nil)
	res, err := client.ExportTable(context.Background(), "dw", "t")
	if err != nil {
		t.Fatalf("ExportTable: %v", err)
	}
	if !strings.HasPrefix(res.Filename, "hive-t-") || !strings.HasSuffix(res.Filename, ".sql") {
		t.Fatalf("filename = %q", res.Filename)
	}
	if !strings.HasPrefix(res.Content, "CREATE TABLE `t`(") || !strings.HasSuffix(res.Content, "\n") {
		t.Fatalf("content = %q", res.Content)
	}
	if !strings.Contains(res.Content, "PRIMARY KEY") {
		t.Fatal("content must carry the SHOW CREATE TABLE text verbatim")
	}
}

// --- store 层 hive 配置加密往返 ---

func TestHiveStoreConfigRoundtrip(t *testing.T) {
	path := t.TempDir() + "/config.db"
	st, err := store.Open(path, "test-master")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	c := &model.Connection{
		ID:   "hive-1",
		Name: "hive-local",
		Type: model.ConnectionTypeHive,
		Config: model.MustConfigJSON(model.HiveConfig{
			Host: "hs2", Port: 10000, AuthMode: model.HiveAuthLDAP,
			Username: "u", Password: "plain-secret", Database: "dw",
		}),
	}
	if err := st.CreateConnection(c); err != nil {
		t.Fatalf("create: %v", err)
	}
	// 直接打开底层 SQLite 读原始行(经 store API 拿不到密文)。
	rawDB, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open raw sqlite: %v", err)
	}
	defer rawDB.Close()
	var raw string
	if err := rawDB.QueryRow("SELECT config_json FROM connections WHERE id = ?", "hive-1").Scan(&raw); err != nil {
		t.Fatalf("query raw: %v", err)
	}
	if strings.Contains(raw, "plain-secret") {
		t.Fatalf("stored config must not contain plaintext password: %s", raw)
	}
	if !strings.Contains(raw, "enc:v1:") {
		t.Fatalf("stored password should use encrypted prefix, got %s", raw)
	}
	loaded, err := st.GetConnection("hive-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	cfg, err := loaded.HiveConfig()
	if err != nil {
		t.Fatalf("decode loaded: %v", err)
	}
	if cfg.Password != "plain-secret" || cfg.AuthMode != model.HiveAuthLDAP || cfg.Database != "dw" {
		t.Fatalf("roundtrip mismatch: %+v", cfg)
	}
}
