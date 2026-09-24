package service

import (
	"context"
	"crypto/tls"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/go-sql-driver/mysql"

	"dataBasePro/backend/internal/model"
)

// mysqlDialTimeout bounds the initial connect/ping of a new client.
const mysqlDialTimeout = 5 * time.Second

// mysqlSystemDatabases lists the built-in schemas hidden from the database
// tree (filter is applied in SQL and again defensively on the results).
var mysqlSystemDatabases = []string{"information_schema", "mysql", "performance_schema", "sys"}

// isMysqlSystemDatabase reports whether name is one of the built-in schemas
// (case-insensitive: server-side lower-casing varies across MySQL versions).
func isMysqlSystemDatabase(name string) bool {
	for _, s := range mysqlSystemDatabases {
		if strings.EqualFold(name, s) {
			return true
		}
	}
	return false
}

// mysqlDatabasesQuery builds the schema listing with one NOT IN placeholder
// per system schema.
func mysqlDatabasesQuery() string {
	placeholders := make([]string, len(mysqlSystemDatabases))
	for i := range placeholders {
		placeholders[i] = "?"
	}
	return "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN (" +
		strings.Join(placeholders, ", ") + ") ORDER BY schema_name"
}

// MysqlClient 是 MysqlDataSource 的生产实现,同时服务 mysql 与 tidb 两种连接
// 类型(TiDB 走 MySQL 协议):经 go-sql-driver 的 Connector 适配到 database/sql。
// 单元格编辑全程参数化;元数据一律取自 information_schema。
type MysqlClient struct {
	db *sql.DB
	// connType 是连接的真实类型(mysql 或 tidb),GetType 原样返回。
	connType model.ConnectionType
	// defaultDB 是连接配置的默认库:请求未显式指定库名时兜底使用。
	defaultDB string
}

// compile-time proof that MysqlClient implements the MySQL data source.
var _ MysqlDataSource = (*MysqlClient)(nil)

// NewMysqlClient builds a client of the plain mysql type and verifies
// reachability with a Ping before returning.
func NewMysqlClient(cfg model.MysqlConfig) (*MysqlClient, error) {
	return NewMysqlClientOfType(cfg, model.ConnectionTypeMySQL)
}

// NewMysqlClientOfType builds a client tagged with the real connection type
// (mysql or tidb) and verifies reachability with a Ping before returning.
func NewMysqlClientOfType(cfg model.MysqlConfig, connType model.ConnectionType) (*MysqlClient, error) {
	if connType != model.ConnectionTypeMySQL && connType != model.ConnectionTypeTiDB {
		return nil, fmt.Errorf("connection type %q is not a MySQL/TiDB source", connType)
	}
	dsn, err := buildMysqlDSN(cfg)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, fmt.Errorf("mysql open: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), mysqlDialTimeout)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, wrapMysqlPingError(err)
	}
	return &MysqlClient{db: db, connType: connType, defaultDB: cfg.Database}, nil
}

// buildMysqlDSN renders the driver DSN:
// user:pass@tcp(host:port)/db?charset=utf8mb4&parseTime=true&loc=Local, with
// the tls parameter added per TLSMode (skip-verify builtin name or a custom
// verify-full registration). Values go through FormatDSN so credentials with
// special characters cannot break the DSN structure.
func buildMysqlDSN(cfg model.MysqlConfig) (string, error) {
	if err := cfg.Validate(); err != nil {
		return "", err
	}
	d := mysql.NewConfig()
	d.User = cfg.Username
	d.Passwd = cfg.Password
	d.Net = "tcp"
	d.Addr = fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	d.DBName = cfg.Database
	d.Params = map[string]string{"charset": "utf8mb4"}
	d.ParseTime = true
	d.Loc = time.Local
	switch cfg.TLSMode {
	case model.MysqlTLSSkipVerify:
		d.TLSConfig = model.MysqlTLSSkipVerify
	case model.MysqlTLSVerifyFull:
		name, err := registerMysqlVerifyFullTLS(cfg.Host)
		if err != nil {
			return "", err
		}
		d.TLSConfig = name
	}
	return d.FormatDSN(), nil
}

// wrapMysqlPingError wraps a ping failure with the standard prefix. The
// driver's errors are transparent (dial/TLS/auth details) and never carry
// credentials.
func wrapMysqlPingError(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("mysql ping: %w", err)
}

var (
	mysqlTLSMu         sync.Mutex
	mysqlTLSRegistered = map[string]bool{}
)

// mysqlTLSConfigName derives the driver-level registration name for a host's
// verify-full TLS config (sanitized to DSN-safe characters).
func mysqlTLSConfigName(host string) string {
	var b strings.Builder
	b.WriteString("dbpro_verify_full_")
	for _, r := range host {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	return b.String()
}

// registerMysqlVerifyFullTLS registers (once per name) a TLS config using the
// system root certificate pool (RootCAs nil) with ServerName=host so
// certificate name verification works, and returns its registration name.
// Registration is idempotent: repeated DSN builds for the same host reuse it.
func registerMysqlVerifyFullTLS(host string) (string, error) {
	name := mysqlTLSConfigName(host)
	mysqlTLSMu.Lock()
	defer mysqlTLSMu.Unlock()
	if !mysqlTLSRegistered[name] {
		if err := mysql.RegisterTLSConfig(name, &tls.Config{
			ServerName: host,
			MinVersion: tls.VersionTLS12,
		}); err != nil {
			return "", fmt.Errorf("register tls config: %w", err)
		}
		mysqlTLSRegistered[name] = true
	}
	return name, nil
}

// GetName returns the client name.
func (c *MysqlClient) GetName() string { return "mysql" }

// GetType returns the real connection type ("mysql" or "tidb").
func (c *MysqlClient) GetType() string { return string(c.connType) }

// Connect verifies the server is still reachable.
func (c *MysqlClient) Connect(ctx context.Context) error {
	if err := c.db.PingContext(ctx); err != nil {
		return wrapMysqlPingError(err)
	}
	return nil
}

// Ping verifies reachability within the dial timeout.
func (c *MysqlClient) Ping(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, mysqlDialTimeout)
	defer cancel()
	return c.db.PingContext(ctx)
}

// Close releases the underlying connection pool.
func (c *MysqlClient) Close() error { return c.db.Close() }

// Databases lists user schemas, excluding the four built-in system schemas,
// ordered by name.
func (c *MysqlClient) Databases(ctx context.Context) ([]string, error) {
	args := make([]any, len(mysqlSystemDatabases))
	for i, s := range mysqlSystemDatabases {
		args[i] = s
	}
	rows, err := c.db.QueryContext(ctx, mysqlDatabasesQuery(), args...)
	if err != nil {
		return nil, fmt.Errorf("list databases: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("scan database name: %w", err)
		}
		if isMysqlSystemDatabase(name) { // 防御:大小写变体等仍不允许漏网
			continue
		}
		out = append(out, name)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if out == nil {
		out = []string{}
	}
	return out, nil
}

// Tables lists a database's base tables with engine, approximate row count
// and comment (views are excluded: table_type = 'BASE TABLE').
func (c *MysqlClient) Tables(ctx context.Context, database string) ([]model.MysqlTableInfo, error) {
	rows, err := c.db.QueryContext(ctx,
		"SELECT table_name, engine, table_rows, table_comment FROM information_schema.tables"+
			" WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name", database)
	if err != nil {
		return nil, fmt.Errorf("list tables: %w", err)
	}
	defer rows.Close()
	var out []model.MysqlTableInfo
	for rows.Next() {
		var name string
		var engine, comment sql.NullString
		var tableRows sql.NullInt64
		if err := rows.Scan(&name, &engine, &tableRows, &comment); err != nil {
			return nil, fmt.Errorf("scan table: %w", err)
		}
		info := model.MysqlTableInfo{Name: name, Engine: engine.String, Comment: comment.String}
		if tableRows.Valid {
			v := tableRows.Int64
			info.TableRows = &v
		}
		out = append(out, info)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if out == nil {
		out = []model.MysqlTableInfo{}
	}
	return out, nil
}

// PageRows returns one page of `SELECT *` over the table with pre-formatted
// string cells (nil = NULL), plus the engine, exact total row count (COUNT(*))
// and primary key metadata.
func (c *MysqlClient) PageRows(ctx context.Context, database, table, where, orderBy string, asc bool, limit, offset int) (model.MysqlPageRowsResult, error) {
	var res model.MysqlPageRowsResult

	engine, err := c.tableMeta(ctx, database, table)
	if err != nil {
		return res, err
	}
	res.Engine = engine

	cols, pk, err := c.tableColumnsWithPK(ctx, c.db, database, table)
	if err != nil {
		return res, err
	}
	res.Columns, res.PrimaryKey = cols, pk

	if err := c.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM "+quoteMysqlIdent(database)+"."+quoteMysqlIdent(table)).Scan(&res.TotalRows); err != nil {
		return res, fmt.Errorf("count rows: %w", err)
	}

	query := "SELECT * FROM " + quoteMysqlIdent(database) + "." + quoteMysqlIdent(table)
	if w := strings.TrimSpace(where); w != "" {
		query += " WHERE " + w
	}
	if o := strings.TrimSpace(orderBy); o != "" {
		direction := "ASC"
		if !asc {
			direction = "DESC"
		}
		query += " ORDER BY " + o + " " + direction
	}
	query += " LIMIT ? OFFSET ?"

	rows, err := c.db.QueryContext(ctx, query, limit, offset)
	if err != nil {
		return res, fmt.Errorf("page rows: %w", err)
	}
	defer rows.Close()
	_, dataRows, err := collectMysqlRows(rows)
	if err != nil {
		return res, err
	}
	res.Rows = dataRows
	// wire 形状防御:Go nil 切片会被 JSON 序列化为 null,前端按数组直接使用,
	// null 会导致渲染崩溃。空表统一归一为空数组。
	if res.Rows == nil {
		res.Rows = [][]*string{}
	}
	if res.Columns == nil {
		res.Columns = []model.MysqlColumn{}
	}
	if res.PrimaryKey == nil {
		res.PrimaryKey = []string{}
	}
	return res, nil
}

// tableMeta reads the engine from information_schema.tables; an empty result
// means the table does not exist.
func (c *MysqlClient) tableMeta(ctx context.Context, database, table string) (string, error) {
	rows, err := c.db.QueryContext(ctx,
		"SELECT engine FROM information_schema.tables WHERE table_schema = ? AND table_name = ?", database, table)
	if err != nil {
		return "", fmt.Errorf("table meta: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return "", err
		}
		return "", fmt.Errorf("table %s.%s not found", database, table)
	}
	var engine sql.NullString
	if err := rows.Scan(&engine); err != nil {
		return "", fmt.Errorf("scan table meta: %w", err)
	}
	return engine.String, rows.Err()
}

// tableColumnsWithPK reads the table's column metadata in definition order
// plus the primary key column names (information_schema.columns.column_key =
// 'PRI', in ordinal position order). 单元格编辑的 WHERE、分页与单表 SELECT
// 结果的 primary_key 元数据同源于这一条查询。exec 由调用方给出(连接池或
// USE 固定的专用连接),查询只读且全限定,不依赖会话状态。
func (c *MysqlClient) tableColumnsWithPK(ctx context.Context, exec mysqlExecutor, database, table string) ([]model.MysqlColumn, []string, error) {
	rows, err := exec.QueryContext(ctx,
		"SELECT column_name, column_type, column_comment, column_key FROM information_schema.columns"+
			" WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position", database, table)
	if err != nil {
		return nil, nil, fmt.Errorf("table columns: %w", err)
	}
	defer rows.Close()
	var cols []model.MysqlColumn
	var pk []string
	for rows.Next() {
		var name, key sql.NullString
		var colType, comment sql.NullString
		if err := rows.Scan(&name, &colType, &comment, &key); err != nil {
			return nil, nil, fmt.Errorf("scan column: %w", err)
		}
		col := model.MysqlColumn{
			Name:    name.String,
			Type:    colType.String,
			Comment: comment.String,
		}
		if strings.EqualFold(strings.TrimSpace(key.String), "PRI") {
			col.IsInPrimaryKey = true
			pk = append(pk, col.Name)
		}
		cols = append(cols, col)
	}
	return cols, pk, rows.Err()
}

// TruncateTable empties the table.
func (c *MysqlClient) TruncateTable(ctx context.Context, database, table string) error {
	query := "TRUNCATE TABLE " + quoteMysqlIdent(database) + "." + quoteMysqlIdent(table)
	if _, err := c.db.ExecContext(ctx, query); err != nil {
		return fmt.Errorf("truncate: %w", err)
	}
	return nil
}

// mysqlExecutor abstracts the shared query/exec surface of *sql.DB and
// *sql.Conn so the statement loop runs against the pool or a dedicated pinned
// connection alike, and unit tests can inject fakes without dialing.
type mysqlExecutor interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// Execute runs the script statement by statement (autocommit; no explicit
// transaction). database 非空时取一条专用连接先执行 USE,随后全部语句固定在
// 该连接上运行(在 *sql.DB 连接池上 USE 的会话状态不跨语句保持);为空时
// 沿用连接池路径。Each result carries its duration, and either columns+rows
// (statements that return a result set) or an error text. A failing statement
// records its error and stops the run; the results gathered so far are
// returned. 单表 SELECT 的结果额外附带 primary_key(查询失败静默置空)。
func (c *MysqlClient) Execute(ctx context.Context, database, sqlText string) ([]model.MysqlStatementResult, error) {
	statements := SplitSQLStatements(sqlText)
	if len(statements) == 0 {
		return nil, errors.New("没有可执行的 SQL 语句")
	}
	if db := strings.TrimSpace(database); db != "" {
		return c.executeOnPinnedDatabase(ctx, db, statements)
	}
	return c.runMysqlStatements(ctx, c.db, c.defaultDB, statements)
}

// executeOnPinnedDatabase grabs one dedicated connection, pins it to the
// database with a backtick-escaped USE, and runs every statement there so the
// selected schema persists across the script. The connection goes back to the
// pool afterwards. USE 失败即中止(库不存在等),不执行任何语句。
func (c *MysqlClient) executeOnPinnedDatabase(ctx context.Context, database string, statements []string) ([]model.MysqlStatementResult, error) {
	conn, err := c.db.Conn(ctx)
	if err != nil {
		return nil, fmt.Errorf("acquire connection: %w", err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, buildMysqlUseDatabase(database)); err != nil {
		return nil, fmt.Errorf("use database: %w", err)
	}
	return c.runMysqlStatements(ctx, conn, database, statements)
}

// buildMysqlUseDatabase renders the USE statement: the identifier is
// backtick-quoted with embedded backticks doubled.
func buildMysqlUseDatabase(database string) string {
	return "USE " + quoteMysqlIdent(database)
}

// runMysqlStatements runs the statements in order against exec, collecting
// per-statement results; the first failure records its error and stops the
// run with the results gathered so far. defaultSchema 是未限定表名解析到的
// 库(USE 过的专用连接为该库,连接池路径为连接默认库),供单表 SELECT 的
// 主键元数据查询使用。
func (c *MysqlClient) runMysqlStatements(ctx context.Context, exec mysqlExecutor, defaultSchema string, statements []string) ([]model.MysqlStatementResult, error) {
	out := make([]model.MysqlStatementResult, 0, len(statements))
	for _, stmt := range statements {
		res := model.MysqlStatementResult{SQL: stmt}
		start := time.Now()
		if mysqlStatementReturnsRows(stmt) {
			rows, err := exec.QueryContext(ctx, stmt)
			if err != nil {
				res.DurationMs = msSince(start)
				res.Error = err.Error()
				return append(out, res), nil
			}
			cols, dataRows, err := collectMysqlRows(rows)
			closeErr := rows.Close()
			if err != nil {
				res.DurationMs = msSince(start)
				res.Error = err.Error()
				return append(out, res), nil
			}
			if closeErr != nil {
				res.DurationMs = msSince(start)
				res.Error = closeErr.Error()
				return append(out, res), nil
			}
			res.Columns, res.Rows = cols, dataRows
		} else {
			if _, err := exec.ExecContext(ctx, stmt); err != nil {
				res.DurationMs = msSince(start)
				res.Error = err.Error()
				return append(out, res), nil
			}
		}
		res.DurationMs = msSince(start)
		// 单表 SELECT 附带主键列(information_schema,与 PageRows 同源),
		// 供前端「复制为 INSERT」可选剥离主键;任何失败静默置空,不计入
		// 语句耗时,不影响语句结果。
		res.PrimaryKey = c.mysqlStatementPrimaryKey(ctx, exec, stmt, defaultSchema)
		out = append(out, res)
	}
	return out, nil
}

// mysqlStatementPrimaryKey 在语句是单表 SELECT 时查它的主键列
// (information_schema.columns,与 PageRows 的 primary_key 同源同序)。
// 未限定表名按 defaultSchema 解析;解析失败、无库可解析、查询报错、无主键
// 一律返回 nil,绝不影响语句本身的执行结果。
func (c *MysqlClient) mysqlStatementPrimaryKey(ctx context.Context, exec mysqlExecutor, stmt, defaultSchema string) []string {
	schema, table, ok := singleTableName(stmt)
	if !ok {
		return nil
	}
	if schema == "" {
		schema = defaultSchema
	}
	if strings.TrimSpace(schema) == "" {
		return nil // 未限定且连接无默认库,information_schema 无从查起
	}
	_, pk, err := c.tableColumnsWithPK(ctx, exec, schema, table)
	if err != nil || len(pk) == 0 {
		return nil
	}
	return pk
}

// singleTableName 判断一条 SQL 是否为「单表 SELECT」:首关键字 SELECT,
// 顶层恰好一个 FROM,表引用为标识符(可带一段库限定),其后只跟子句关键字
// 或语句结束。是则返回 (限定库, 表名, true);未限定时 schema 为空,由调用
// 方按当前库解析。JOIN/逗号多表、UNION、FROM 子查询、WITH、非 SELECT、
// 无法词法解析等一律 ("", "", false)。复用 essql_translate.go 的 tokenizer
// 与解析游标(其 EsSqlStatement 不对外暴露表名,故按契约以纯函数最小扩展;
// 返回值比 (string, bool) 多一个 schema:库限定必须由解析器按反引号拆分,
// 否则会把 `a.b`.`c` 之类的名字错误切分)。
func singleTableName(sql string) (schema, table string, ok bool) {
	toks, err := esTokenizeSQL(sql)
	if err != nil {
		return "", "", false
	}
	p := &esSQLParser{toks: toks}
	if !p.eatKeyword("SELECT") {
		return "", "", false
	}
	// 跳过 SELECT 列表:推进到第一个顶层 FROM(括号深度屏蔽子查询与
	// 函数列里的 FROM;字符串字面量是独立 token,天然免疫)。
	depth := 0
	for {
		t := p.peek()
		if t.Kind == esTokIdent && depth == 0 && !t.Quoted && strings.EqualFold(t.Text, "FROM") {
			p.next()
			break
		}
		switch t.Kind {
		case esTokEOF:
			return "", "", false // 没有 FROM(如 SELECT 1)
		case esTokPunct:
			switch t.Text {
			case "(":
				depth++
			case ")":
				if depth == 0 {
					return "", "", false
				}
				depth--
			case ";":
				return "", "", false
			}
		}
		p.next()
	}
	// 表引用:ident(.ident)*;括号开头(FROM 子查询)等一律不支持。
	t := p.peek()
	if t.Kind != esTokIdent {
		return "", "", false
	}
	p.next()
	parts := []string{t.Text}
	for p.isPunct(".") {
		if nx := p.toks[p.pos+1]; nx.Kind != esTokIdent {
			return "", "", false
		}
		p.next() // .
		parts = append(parts, p.next().Text)
	}
	if len(parts) > 2 {
		return "", "", false // MySQL 表引用最多 db.table 两段
	}
	// 可选别名:AS x 或裸的非关键字标识符(JOIN/UNION 等不可被误吃为别名)。
	if p.eatKeyword("AS") {
		if t := p.peek(); t.Kind != esTokIdent {
			return "", "", false
		}
		p.next()
	} else if t := p.peek(); t.Kind == esTokIdent && !t.Quoted && !isMysqlClauseKeyword(t.Text) {
		p.next()
	}
	// 表引用之后只允许子句关键字或语句结束,否则视为多表/复合查询。
	switch t := p.peek(); {
	case t.Kind == esTokEOF:
	case t.Kind == esTokPunct && t.Text == ";":
	case t.Kind == esTokIdent && !t.Quoted && mysqlSelectFollowKeyword(t.Text):
	default:
		return "", "", false
	}
	if len(parts) == 2 {
		return parts[0], parts[1], true
	}
	return "", parts[0], true
}

// mysqlSelectFollowKeyword 判断哪些子句关键字可以合法出现在单表 SELECT 的
// 表引用(及其别名)之后:命中即认为 FROM 仅引用了这一张表。JOIN/UNION/
// 逗号等不在此列。
func mysqlSelectFollowKeyword(text string) bool {
	switch strings.ToUpper(text) {
	case "WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "OFFSET",
		"FOR", "INTO", "WINDOW", "LOCK":
		return true
	}
	return false
}

// isMysqlClauseKeyword 判断裸标识符是否为 MySQL 子句关键字(不能当作表
// 别名)。比 ES 侧的关键字集更宽:LEFT/UNION/PARTITION 等一旦被误吃为别名,
// 多表形态就会被漏判成单表。
func isMysqlClauseKeyword(text string) bool {
	switch strings.ToUpper(text) {
	case "SELECT", "FROM", "WHERE", "GROUP", "BY", "HAVING", "ORDER",
		"LIMIT", "OFFSET", "JOIN", "INNER", "LEFT", "RIGHT", "FULL",
		"OUTER", "CROSS", "NATURAL", "STRAIGHT_JOIN", "ON", "USING",
		"UNION", "AS", "AND", "OR", "NOT", "LIKE", "IN", "IS", "NULL",
		"BETWEEN", "ASC", "DESC", "DISTINCT", "WITH", "FOR", "LOCK",
		"INTO", "WINDOW", "SET", "VALUES", "USE", "FORCE", "IGNORE",
		"PARTITION", "LATERAL", "TABLESAMPLE", "CASE", "WHEN", "THEN",
		"ELSE", "END", "EXISTS", "ALL", "ANY", "SOME":
		return true
	}
	return false
}

// mysqlStatementReturnsRows reports whether the statement's first keyword is
// one that produces a result set and should go through Query instead of Exec.
func mysqlStatementReturnsRows(stmt string) bool {
	first := stmt
	if i := strings.IndexAny(stmt, " \t\n\r("); i >= 0 {
		first = stmt[:i]
	}
	switch strings.ToUpper(first) {
	case "SELECT", "SHOW", "DESC", "DESCRIBE", "EXPLAIN", "WITH":
		return true
	}
	return false
}

// mysqlDatetimeLayout 是 DATETIME/TIMESTAMP 单元格的显示布局:本地墙钟、
// 空格分隔、不带时区后缀。
const mysqlDatetimeLayout = "2006-01-02 15:04:05"

// mysqlDateLayout 是 DATE 单元格的显示布局:只保留日期部分。
const mysqlDateLayout = "2006-01-02"

// formatMysqlCell renders one MySQL cell for the wire: time-family values are
// shown as local wall-clock text (DATETIME/TIMESTAMP "2006-01-02 15:04:05",
// DATE date-only) instead of RFC3339 with a timezone suffix; everything else
// delegates to FormatCHCell unchanged.
func formatMysqlCell(v any, colType string, maxBytes int) *string {
	if t, ok := v.(time.Time); ok {
		layout := mysqlDatetimeLayout
		if strings.EqualFold(colType, "DATE") {
			layout = mysqlDateLayout
		}
		s := t.Format(layout)
		if maxBytes > 0 && len(s) > maxBytes {
			s = s[:maxBytes] + CHCellTruncatedSuffix
		}
		return &s
	}
	return FormatCHCell(v, maxBytes)
}

// collectMysqlRows drains a result set into wire-shaped columns and
// pre-formatted string cells (nil = NULL). 列名来自 driver Rows.Columns(),
// 类型名可能为空(驱动未报告时保持空串)。
func collectMysqlRows(rows *sql.Rows) ([]model.MysqlColumn, [][]*string, error) {
	types, err := rows.ColumnTypes()
	if err != nil {
		return nil, nil, fmt.Errorf("column types: %w", err)
	}
	cols := make([]model.MysqlColumn, len(types))
	for i, ct := range types {
		cols[i] = model.MysqlColumn{Name: ct.Name(), Type: ct.DatabaseTypeName()}
	}
	// 通用扫描:每个单元格扫进 *any;std 适配层对 NULL 行给出 nil。
	width := len(types)
	values := make([]any, width)
	pointers := make([]any, width)
	var out [][]*string
	for rows.Next() {
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			return nil, nil, fmt.Errorf("scan row: %w", err)
		}
		row := make([]*string, width)
		for i, v := range values {
			row[i] = formatMysqlCell(v, cols[i].Type, CHCellMaxBytes)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return cols, out, nil
}

// --- 单元格更新(表详情/SQL 结果编辑,全程参数化) ---

// resolveDatabase 兜底空库名:请求未指定库时使用连接配置的默认库。
func (c *MysqlClient) resolveDatabase(database string) string {
	if strings.TrimSpace(database) == "" {
		return c.defaultDB
	}
	return database
}

// PreviewCellUpdate renders the display text of the UPDATE statement and
// counts the rows matched by the same WHERE conditions (a parameterized
// SELECT COUNT(*), executed read-only). 只读:更新语句本身不执行。
func (c *MysqlClient) PreviewCellUpdate(ctx context.Context, database, table string, set model.MysqlCellValue, where []model.MysqlCellValue) (model.MysqlCellUpdatePreview, error) {
	var preview model.MysqlCellUpdatePreview
	db := c.resolveDatabase(database)
	if err := c.validateCellEdit(ctx, db, table, where); err != nil {
		return preview, err
	}
	stmt, err := buildMysqlCellUpdateStatement(db, table, set, where)
	if err != nil {
		return preview, err
	}
	countQuery, args, err := buildMysqlCountQuery(db, table, where)
	if err != nil {
		return preview, err // 语句构造已校验,防御性兜底
	}
	var matched int64
	if err := c.db.QueryRowContext(ctx, countQuery, args...).Scan(&matched); err != nil {
		return preview, fmt.Errorf("count matched rows: %w", err)
	}
	return model.MysqlCellUpdatePreview{Statement: stmt, MatchedRows: matched}, nil
}

// UpdateCell executes the cell update as a parameterized UPDATE (? 占位 +
// 值参数)。执行路径不使用预览文本;主键校验与语句构造重新走一遍。
func (c *MysqlClient) UpdateCell(ctx context.Context, database, table string, set model.MysqlCellValue, where []model.MysqlCellValue) error {
	db := c.resolveDatabase(database)
	if err := c.validateCellEdit(ctx, db, table, where); err != nil {
		return err
	}
	query, args, err := buildMysqlUpdateExec(db, table, set, where)
	if err != nil {
		return err
	}
	if _, err := c.db.ExecContext(ctx, query, args...); err != nil {
		return fmt.Errorf("update cell: %w", err)
	}
	return nil
}

// validateCellEdit enforces the WHERE contract for cell edits: the table must
// have a primary key (information_schema, same source as PageRows metadata)
// and every where condition must reference a primary key column.
func (c *MysqlClient) validateCellEdit(ctx context.Context, database, table string, where []model.MysqlCellValue) error {
	if strings.TrimSpace(table) == "" {
		return errors.New("表名不能为空")
	}
	_, pk, err := c.tableColumnsWithPK(ctx, c.db, database, table)
	if err != nil {
		return err
	}
	if err := requireMysqlPrimaryKey(pk); err != nil {
		return err
	}
	return validateMysqlEditWhere(where, pk)
}

// requireMysqlPrimaryKey rejects edits on primary-key-less tables.
func requireMysqlPrimaryKey(pk []string) error {
	if len(pk) == 0 {
		return errors.New("表无主键,不支持编辑")
	}
	return nil
}

// validateMysqlEditWhere verifies the WHERE conditions: non-empty, every
// condition column named and every column part of the primary key.
func validateMysqlEditWhere(where []model.MysqlCellValue, pk []string) error {
	if len(where) == 0 {
		return errors.New("where 条件不能为空:已拒绝无定位的全表 UPDATE")
	}
	pkSet := make(map[string]bool, len(pk))
	for _, name := range pk {
		pkSet[name] = true
	}
	for _, cond := range where {
		if strings.TrimSpace(cond.Column) == "" {
			return errors.New("where 条件列名不能为空")
		}
		if !pkSet[cond.Column] {
			return fmt.Errorf("where 条件列 %q 不是主键列,仅允许按主键定位", cond.Column)
		}
	}
	return nil
}

// buildMysqlCellUpdateStatement renders the display text of the full UPDATE:
// identifiers backtick-quoted, values rendered as string literals with `'`
// doubled (nil → NULL). 展示专用:执行路径走 buildMysqlUpdateExec 的参数化
// 语句,绝不运行这段文本。
func buildMysqlCellUpdateStatement(database, table string, set model.MysqlCellValue, conds []model.MysqlCellValue) (string, error) {
	if strings.TrimSpace(table) == "" {
		return "", errors.New("表名不能为空")
	}
	if strings.TrimSpace(set.Column) == "" {
		return "", errors.New("set 列名不能为空")
	}
	conds, err := renderMysqlConditions(conds)
	if err != nil {
		return "", err
	}
	parts := make([]string, 0, len(conds))
	for _, cond := range conds {
		if cond.Value == nil {
			parts = append(parts, quoteMysqlIdent(cond.Column)+" IS NULL")
			continue
		}
		parts = append(parts, quoteMysqlIdent(cond.Column)+" = "+mysqlDisplayLiteral(cond.Value))
	}
	return "UPDATE " + quoteMysqlIdent(database) + "." + quoteMysqlIdent(table) +
		" SET " + quoteMysqlIdent(set.Column) + " = " + mysqlDisplayLiteral(set.Value) +
		" WHERE " + strings.Join(parts, " AND "), nil
}

// buildMysqlUpdateExec builds the parameterized UPDATE: `?` placeholders plus
// value args. SET 值 nil → 参数 nil(驱动发送 SQL NULL);WHERE 值 nil →
// 渲染为 IS NULL 且不带参数。
func buildMysqlUpdateExec(database, table string, set model.MysqlCellValue, conds []model.MysqlCellValue) (string, []any, error) {
	if strings.TrimSpace(table) == "" {
		return "", nil, errors.New("表名不能为空")
	}
	if strings.TrimSpace(set.Column) == "" {
		return "", nil, errors.New("set 列名不能为空")
	}
	conds, err := renderMysqlConditions(conds)
	if err != nil {
		return "", nil, err
	}
	wheres, whereArgs, err := mysqlWherePlaceholders(conds)
	if err != nil {
		return "", nil, err // renderMysqlConditions 已校验,防御性兜底
	}
	args := append([]any{mysqlArg(set.Value)}, whereArgs...)
	return "UPDATE " + quoteMysqlIdent(database) + "." + quoteMysqlIdent(table) +
		" SET " + quoteMysqlIdent(set.Column) + " = ?" +
		" WHERE " + wheres, args, nil
}

// buildMysqlCountQuery builds the parameterized SELECT COUNT(*) over the same
// WHERE conditions used by the update (preview 命中行数与执行同源)。
func buildMysqlCountQuery(database, table string, conds []model.MysqlCellValue) (string, []any, error) {
	if strings.TrimSpace(table) == "" {
		return "", nil, errors.New("表名不能为空")
	}
	conds, err := renderMysqlConditions(conds)
	if err != nil {
		return "", nil, err
	}
	wheres, args, err := mysqlWherePlaceholders(conds)
	if err != nil {
		return "", nil, err // renderMysqlConditions 已校验,防御性兜底
	}
	return "SELECT COUNT(*) FROM " + quoteMysqlIdent(database) + "." + quoteMysqlIdent(table) +
		" WHERE " + wheres, args, nil
}

// renderMysqlConditions validates the WHERE conditions (non-empty, named
// columns) and returns a defensive copy.
func renderMysqlConditions(conds []model.MysqlCellValue) ([]model.MysqlCellValue, error) {
	if len(conds) == 0 {
		return nil, errors.New("where 条件不能为空:已拒绝无定位的全表 UPDATE")
	}
	out := make([]model.MysqlCellValue, len(conds))
	copy(out, conds)
	for _, cond := range out {
		if strings.TrimSpace(cond.Column) == "" {
			return nil, errors.New("where 条件列名不能为空")
		}
	}
	return out, nil
}

// mysqlWherePlaceholders renders the AND-joined parameterized conditions and
// their args (nil 值 → IS NULL,不带参数)。
func mysqlWherePlaceholders(conds []model.MysqlCellValue) (string, []any, error) {
	if len(conds) == 0 {
		return "", nil, errors.New("where 条件不能为空:已拒绝无定位的全表 UPDATE")
	}
	var (
		parts []string
		args  []any
	)
	for _, cond := range conds {
		if cond.Value == nil {
			parts = append(parts, quoteMysqlIdent(cond.Column)+" IS NULL")
			continue
		}
		parts = append(parts, quoteMysqlIdent(cond.Column)+" = ?")
		args = append(args, mysqlArg(cond.Value))
	}
	return strings.Join(parts, " AND "), args, nil
}

// mysqlArg converts a cell value into a driver argument: nil → untyped nil
// (SQL NULL), otherwise the dereferenced string.
func mysqlArg(v *string) any {
	if v == nil {
		return nil
	}
	return *v
}

// mysqlDisplayLiteral renders a value as a display-only SQL literal: nil →
// NULL, otherwise a single-quoted string with embedded quotes doubled.
func mysqlDisplayLiteral(value *string) string {
	if value == nil {
		return "NULL"
	}
	return quoteMysqlString(*value)
}

// quoteMysqlString single-quotes a string literal for display, doubling any
// embedded single quote.
func quoteMysqlString(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// quoteMysqlIdent backtick-quotes an identifier, escaping embedded backticks.
func quoteMysqlIdent(name string) string {
	return "`" + strings.ReplaceAll(name, "`", "``") + "`"
}

// --- Service 层委托(危险操作的审计由 app 层落) ---

// MysqlDatabases lists the user schemas of the connection's MySQL/TiDB server.
func (s *Service) MysqlDatabases(ctx context.Context, id string) ([]string, error) {
	m, err := s.mysql(ctx, id)
	if err != nil {
		return nil, err
	}
	return m.Databases(ctx)
}

// MysqlTables lists a database's base tables (engine + row counts + comments).
func (s *Service) MysqlTables(ctx context.Context, id, database string) ([]model.MysqlTableInfo, error) {
	m, err := s.mysql(ctx, id)
	if err != nil {
		return nil, err
	}
	return m.Tables(ctx, database)
}

// MysqlPageRows returns one page of a table's rows with metadata.
func (s *Service) MysqlPageRows(ctx context.Context, id, database, table, where, orderBy string, asc bool, limit, offset int) (model.MysqlPageRowsResult, error) {
	m, err := s.mysql(ctx, id)
	if err != nil {
		return model.MysqlPageRowsResult{}, err
	}
	return m.PageRows(ctx, database, table, where, orderBy, asc, limit, offset)
}

// MysqlTruncateTable empties a table (dangerous, audited by the caller).
func (s *Service) MysqlTruncateTable(ctx context.Context, id, database, table string) error {
	m, err := s.mysql(ctx, id)
	if err != nil {
		return err
	}
	return m.TruncateTable(ctx, database, table)
}

// MysqlExecute runs a SQL script statement by statement; database 非空时全部
// 语句固定在一条 USE 过的专用连接上执行,为空时走连接池。
func (s *Service) MysqlExecute(ctx context.Context, id, database, sqlText string) ([]model.MysqlStatementResult, error) {
	m, err := s.mysql(ctx, id)
	if err != nil {
		return nil, err
	}
	return m.Execute(ctx, database, sqlText)
}

// MysqlPreviewCellUpdate 预览单元格更新:构造展示语句 + 同 WHERE 命中行数
// (只读)。
func (s *Service) MysqlPreviewCellUpdate(ctx context.Context, id, database, table string, set model.MysqlCellValue, where []model.MysqlCellValue) (model.MysqlCellUpdatePreview, error) {
	m, err := s.mysql(ctx, id)
	if err != nil {
		return model.MysqlCellUpdatePreview{}, err
	}
	return m.PreviewCellUpdate(ctx, database, table, set, where)
}

// MysqlUpdateCell 执行参数化单元格更新(危险操作,审计由 app 层落)。
func (s *Service) MysqlUpdateCell(ctx context.Context, id, database, table string, set model.MysqlCellValue, where []model.MysqlCellValue) error {
	m, err := s.mysql(ctx, id)
	if err != nil {
		return err
	}
	return m.UpdateCell(ctx, database, table, set, where)
}
