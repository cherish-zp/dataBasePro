package service

import (
	"context"
	"crypto/tls"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"

	"dataBasePro/backend/internal/model"
)

// CHCellMaxBytes 是结果单元格格式化后的截断阈值;超出部分替换为截断标记。
const CHCellMaxBytes = 8192

// CHCellTruncatedSuffix 追加在被截断的单元格文本之后。
const CHCellTruncatedSuffix = "…(截断)"

// chDialTimeout bounds the initial connect/ping of a new client.
const chDialTimeout = 5 * time.Second

// chHTTPPortHint is appended to ping failures that look like a native-protocol
// handshake against an HTTP endpoint (e.g. port 8123 serving 'H' = packet 72).
const chHTTPPortHint = "端口疑似 HTTP(如 8123),请在连接配置中将协议切换为 HTTP,或改用原生端口 9000"

// CHClient 是 ClickHouseDataSource 的生产实现:以 Options(native 或 HTTP
// 协议)经 clickhouse.Connector 适配到 database/sql(*sql.DB)。std 行适配层
// 把每个单元格解码为 driver.Value(Nullable 列的 NULL 行为 nil),因此
// *sql.Rows 可以对任意结果集做通用扫描;原生 driver.Rows.Scan 不支持
// *any 目标。
type CHClient struct {
	db *sql.DB
	// httpMode:HTTP 协议走自实现 database/sql 驱动,元数据查询需显式
	// 追加 FORMAT 子句(native 模式由 URL default_format 承担)。
	httpMode bool
}

// compile-time proof that CHClient implements the ClickHouse data source.
var _ ClickHouseDataSource = (*CHClient)(nil)

// NewCHClient builds the client over the given config and verifies
// reachability with a Ping before returning.
func NewCHClient(cfg model.ClickHouseConfig) (*CHClient, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), chDialTimeout)
	defer cancel()
	var db *sql.DB
	if cfg.Protocol == model.CHProtocolHTTP {
		// HTTP 模式走自实现驱动:clickhouse-go 的 HTTP 传输固化
		// client_protocol_version,老服务器(如 22.8)会 404 UNKNOWN_SETTING。
		connector, cerr := buildHTTPConnector(cfg)
		if cerr != nil {
			return nil, cerr
		}
		db = sql.OpenDB(connector)
	} else {
		db = sql.OpenDB(clickhouse.Connector(buildCHOptions(cfg)))
	}
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, wrapCHPingError(err)
	}
	return &CHClient{db: db, httpMode: cfg.Protocol == model.CHProtocolHTTP}, nil
}

// buildCHOptions maps a validated ClickHouseConfig onto clickhouse.Options.
// Protocol picks the wire protocol: native TCP (default, port 9000) or HTTP
// (port 8123). TLS, when enabled, applies to both protocols the same way,
// with ServerName taken from the first host so certificate name verification
// works with host:port addresses.
func buildCHOptions(cfg model.ClickHouseConfig) *clickhouse.Options {
	opt := &clickhouse.Options{
		Addr: cfg.Hosts,
		Auth: clickhouse.Auth{
			Database: cfg.Database,
			Username: cfg.Username,
			Password: cfg.Password,
		},
		DialTimeout: chDialTimeout,
	}
	if cfg.Protocol == model.CHProtocolHTTP {
		opt.Protocol = clickhouse.HTTP
	} else {
		opt.Protocol = clickhouse.Native
	}
	if cfg.TLS {
		opt.TLS = chTLSConfig(cfg.Hosts[0])
	}
	return opt
}

// wrapCHPingError wraps a ping failure with the standard prefix; when the
// error looks like a protocol/port mismatch ("unexpected packet" — the server
// answered in a foreign wire format), a hint about switching to the HTTP
// protocol is appended.
func wrapCHPingError(err error) error {
	if err != nil && strings.Contains(err.Error(), "unexpected packet") {
		return fmt.Errorf("clickhouse ping: %w(%s)", err, chHTTPPortHint)
	}
	return fmt.Errorf("clickhouse ping: %w", err)
}

// chTLSConfig derives the TLS config when enabled; ServerName comes from the
// first host so certificate name verification works with host:port addresses.
func chTLSConfig(addr string) *tls.Config {
	host := addr
	if i := strings.LastIndex(addr, ":"); i > 0 {
		host = addr[:i]
	}
	return &tls.Config{ServerName: host}
}

// GetName returns the connection name.
func (c *CHClient) GetName() string { return "clickhouse" }

// GetType returns the connection type.
func (c *CHClient) GetType() string { return string(model.ConnectionTypeClickHouse) }

// Connect verifies the server is still reachable.
func (c *CHClient) Connect(ctx context.Context) error {
	if err := c.db.PingContext(ctx); err != nil {
		return wrapCHPingError(err)
	}
	return nil
}

// Close releases the underlying connection pool.
func (c *CHClient) Close() error { return c.db.Close() }

// Ping verifies reachability over the active protocol.
func (c *CHClient) Ping(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, chDialTimeout)
	defer cancel()
	return c.db.PingContext(ctx)
}

// Databases lists user databases, excluding the built-in system and
// INFORMATION_SCHEMA catalogs, ordered by name.
// rowFormat 返回行集查询需要追加的 FORMAT 子句:http 模式必须显式指定
// (驱动 URL 的 default_format 仅对未带 FORMAT 的查询生效,这里统一显式
// 以免歧义);native 模式由 URL default_format 承担,无需追加。
func (c *CHClient) rowFormat() string {
	if c.httpMode {
		return " FORMAT JSONCompactEachRowWithNamesAndTypes"
	}
	return ""
}

func (c *CHClient) Databases(ctx context.Context) ([]string, error) {
	rows, err := c.db.QueryContext(ctx,
		"SELECT name FROM system.databases WHERE name != 'system' AND name != 'INFORMATION_SCHEMA' ORDER BY name" + c.rowFormat())
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
		out = append(out, name)
	}
	return out, rows.Err()
}

// Tables lists a database's tables with engine and approximate row count.
// Unless showSystem is set, the built-in system catalogs stay hidden.
func (c *CHClient) Tables(ctx context.Context, database string, showSystem bool) ([]model.CHTableInfo, error) {
	query := "SELECT name, engine, total_rows FROM system.tables WHERE database = ?"
	if !showSystem {
		query += " AND database NOT IN ('system', 'INFORMATION_SCHEMA')"
	}
	query += " ORDER BY name" + c.rowFormat()
	rows, err := c.db.QueryContext(ctx, query, database)
	if err != nil {
		return nil, fmt.Errorf("list tables: %w", err)
	}
	defer rows.Close()
	var out []model.CHTableInfo
	for rows.Next() {
		var name, engine string
		var totalRows sql.NullInt64
		if err := rows.Scan(&name, &engine, &totalRows); err != nil {
			return nil, fmt.Errorf("scan table: %w", err)
		}
		info := model.CHTableInfo{Name: name, Engine: engine}
		if totalRows.Valid {
			v := totalRows.Int64
			info.TotalRows = &v
		}
		out = append(out, info)
	}
	return out, rows.Err()
}

// PageRows returns one page of `SELECT *` over the table with pre-formatted
// string cells (nil = NULL), plus the table's engine and approximate
// total_rows metadata.
func (c *CHClient) PageRows(ctx context.Context, database, table, where, orderBy string, asc bool, limit, offset int) (model.CHPageRowsResult, error) {
	var res model.CHPageRowsResult

	engine, totalRows, err := c.tableMeta(ctx, database, table)
	if err != nil {
		return res, err
	}
	res.Engine, res.TotalRows = engine, totalRows

	cols, err := c.tableColumns(ctx, database, table)
	if err != nil {
		return res, err
	}
	res.Columns = cols

	query := "SELECT * FROM " + quoteCHIdent(database) + "." + quoteCHIdent(table)
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
	_, dataRows, err := collectCHRows(rows)
	if err != nil {
		return res, err
	}
	res.Rows = dataRows
	// 列信息始终取自 system.columns(权威来源):部分老服务端对 0 行结果
	// 的数据查询不返回列信息(ColumnTypes 为空),此时表头仍需完整渲染。
	if len(res.Columns) == 0 {
		cols, cerr := c.tableColumns(ctx, database, table)
		if cerr != nil {
			return res, cerr
		}
		res.Columns = cols
	}
	return res, nil
}

// tableMeta reads engine and total_rows from system.tables; total_rows is
// Nullable so it maps to *int64 (nil = engine cannot report it).
func (c *CHClient) tableMeta(ctx context.Context, database, table string) (string, *int64, error) {
	rows, err := c.db.QueryContext(ctx,
		"SELECT engine, total_rows FROM system.tables WHERE database = ? AND name = ?" + c.rowFormat() + "", database, table)
	if err != nil {
		return "", nil, fmt.Errorf("table meta: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return "", nil, err
		}
		return "", nil, fmt.Errorf("table %s.%s not found", database, table)
	}
	var engine string
	var totalRows sql.NullInt64
	if err := rows.Scan(&engine, &totalRows); err != nil {
		return "", nil, fmt.Errorf("scan table meta: %w", err)
	}
	var total *int64
	if totalRows.Valid {
		v := totalRows.Int64
		total = &v
	}
	return engine, total, nil
}

// tableColumns reads the table's column names, types and comments in
// definition order. comment 以 sql.NullString 防御扫描:CH 对空描述正常返回
// 空串,但若异常数据给出 NULL 也统一落为空串。
func (c *CHClient) tableColumns(ctx context.Context, database, table string) ([]model.CHColumn, error) {
	rows, err := c.db.QueryContext(ctx,
		"SELECT name, type, comment FROM system.columns WHERE database = ? AND table = ? ORDER BY position"+c.rowFormat(), database, table)
	if err != nil {
		return nil, fmt.Errorf("table columns: %w", err)
	}
	defer rows.Close()
	var cols []model.CHColumn
	for rows.Next() {
		var name, typ string
		var comment sql.NullString
		if err := rows.Scan(&name, &typ, &comment); err != nil {
			return nil, fmt.Errorf("scan column: %w", err)
		}
		cols = append(cols, model.CHColumn{Name: name, Type: typ, Comment: comment.String})
	}
	return cols, rows.Err()
}

// TruncateTable empties the table; with onCluster it resolves the cluster
// holding the most nodes (system.clusters) and appends ON CLUSTER.
func (c *CHClient) TruncateTable(ctx context.Context, database, table string, onCluster bool) error {
	query := "TRUNCATE TABLE " + quoteCHIdent(database) + "." + quoteCHIdent(table)
	if onCluster {
		cluster, err := c.largestCluster(ctx)
		if err != nil {
			return fmt.Errorf("resolve cluster: %w", err)
		}
		query += " ON CLUSTER " + quoteCHIdent(cluster)
	}
	if _, err := c.db.ExecContext(ctx, query); err != nil {
		return fmt.Errorf("truncate: %w", err)
	}
	return nil
}

// largestCluster picks the cluster with the most declared nodes from
// system.clusters as the ON CLUSTER target heuristic.
func (c *CHClient) largestCluster(ctx context.Context) (string, error) {
	rows, err := c.db.QueryContext(ctx,
		"SELECT cluster FROM system.clusters GROUP BY cluster ORDER BY count() DESC LIMIT 1" + c.rowFormat())
	if err != nil {
		return "", err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return "", err
		}
		return "", errors.New("system.clusters has no clusters")
	}
	var cluster string
	if err := rows.Scan(&cluster); err != nil {
		return "", err
	}
	return cluster, nil
}

// Execute runs the script statement by statement. Each result carries its
// duration, and either columns+rows (statements that return a result set) or
// an error text. A failing statement records its error and stops the run; the
// results gathered so far are returned.
func (c *CHClient) Execute(ctx context.Context, sqlText string) ([]model.CHStatementResult, error) {
	statements := SplitSQLStatements(sqlText)
	if len(statements) == 0 {
		return nil, errors.New("没有可执行的 SQL 语句")
	}
	out := make([]model.CHStatementResult, 0, len(statements))
	for _, stmt := range statements {
		res := model.CHStatementResult{SQL: stmt}
		start := time.Now()
		if chStatementReturnsRows(stmt) {
			rows, err := c.db.QueryContext(ctx, stmt)
			if err != nil {
				res.DurationMs = msSince(start)
				res.Error = err.Error()
				return append(out, res), nil
			}
			cols, dataRows, err := collectCHRows(rows)
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
			if _, err := c.db.ExecContext(ctx, stmt); err != nil {
				res.DurationMs = msSince(start)
				res.Error = err.Error()
				return append(out, res), nil
			}
		}
		res.DurationMs = msSince(start)
		out = append(out, res)
	}
	return out, nil
}

// collectCHRows drains a result set into wire-shaped columns and pre-formatted
// string cells (nil = NULL).
func collectCHRows(rows *sql.Rows) ([]model.CHColumn, [][]*string, error) {
	types, err := rows.ColumnTypes()
	if err != nil {
		return nil, nil, fmt.Errorf("column types: %w", err)
	}
	cols := make([]model.CHColumn, len(types))
	for i, ct := range types {
		cols[i] = model.CHColumn{Name: ct.Name(), Type: ct.DatabaseTypeName()}
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
			row[i] = FormatCHCell(v, CHCellMaxBytes)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return cols, out, nil
}

// FormatCHCell renders one cell for the wire: nil means SQL NULL, values are
// formatted to strings (time in RFC3339), and text longer than maxBytes is
// truncated with a marker. maxBytes<=0 disables truncation.
func FormatCHCell(v any, maxBytes int) *string {
	if v == nil {
		return nil
	}
	var s string
	switch t := v.(type) {
	case string:
		s = t
	case []byte:
		s = string(t)
	case bool:
		s = strconv.FormatBool(t)
	case int:
		s = strconv.Itoa(t)
	case int8:
		s = strconv.FormatInt(int64(t), 10)
	case int16:
		s = strconv.FormatInt(int64(t), 10)
	case int32:
		s = strconv.FormatInt(int64(t), 10)
	case int64:
		s = strconv.FormatInt(t, 10)
	case uint:
		s = strconv.FormatUint(uint64(t), 10)
	case uint8:
		s = strconv.FormatUint(uint64(t), 10)
	case uint16:
		s = strconv.FormatUint(uint64(t), 10)
	case uint32:
		s = strconv.FormatUint(uint64(t), 10)
	case uint64:
		s = strconv.FormatUint(t, 10)
	case float32:
		s = strconv.FormatFloat(float64(t), 'f', -1, 32)
	case float64:
		s = strconv.FormatFloat(t, 'f', -1, 64)
	case time.Time:
		s = t.Format(time.RFC3339)
	default:
		s = fmt.Sprintf("%v", t)
	}
	if maxBytes > 0 && len(s) > maxBytes {
		s = s[:maxBytes] + CHCellTruncatedSuffix
	}
	return &s
}

// SplitSQLStatements splits a script on statement-terminating semicolons while
// respecting single quotes (backslash and doubled-quote escapes), double
// quotes, backtick identifiers, `--` line comments and `/* */` block comments.
// Chunks that hold no content beyond comments and whitespace are dropped;
// surviving statements are trimmed.
func SplitSQLStatements(sqlText string) []string {
	var (
		out        []string
		buf        strings.Builder
		hasContent bool
		flush      = func() {
			if s := strings.TrimSpace(buf.String()); hasContent && s != "" {
				out = append(out, s)
			}
			buf.Reset()
			hasContent = false
		}
	)
	n := len(sqlText)
	i := 0
	for i < n {
		c := sqlText[i]
		switch {
		case c == '\'' || c == '"' || c == '`':
			buf.WriteByte(c)
			i++
			for i < n {
				ch := sqlText[i]
				// 反斜杠转义仅存在于引号字符串;标识符反引号靠双写转义。
				if c != '`' && ch == '\\' && i+1 < n {
					buf.WriteString(sqlText[i : i+2])
					i += 2
					continue
				}
				if ch == c {
					buf.WriteByte(ch)
					i++
					// 双写引号仍在字符串内(''、" "、``)。
					if i < n && sqlText[i] == c {
						buf.WriteByte(c)
						i++
						continue
					}
					break
				}
				buf.WriteByte(ch)
				i++
			}
		case c == '-' && i+1 < n && sqlText[i+1] == '-':
			// 行注释:吞到换行前,不写入缓冲。
			for i < n && sqlText[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < n && sqlText[i+1] == '*':
			// 块注释:折叠为单个空格,保留词法边界。
			i += 2
			for i+1 < n && !(sqlText[i] == '*' && sqlText[i+1] == '/') {
				i++
			}
			if i+1 < n {
				i += 2
			} else {
				i = n
			}
			buf.WriteByte(' ')
		case c == ';':
			i++
			flush()
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			buf.WriteByte(c)
			i++
		default:
			hasContent = true
			buf.WriteByte(c)
			i++
		}
	}
	flush()
	return out
}

// chStatementReturnsRows reports whether the statement's first keyword is one
// that produces a result set and should go through Query instead of Exec.
func chStatementReturnsRows(stmt string) bool {
	first := stmt
	if i := strings.IndexAny(stmt, " \t\n\r("); i >= 0 {
		first = stmt[:i]
	}
	switch strings.ToUpper(first) {
	case "SELECT", "SHOW", "DESC", "DESCRIBE", "EXPLAIN", "EXISTS", "CHECK", "WITH":
		return true
	}
	return false
}

// quoteCHIdent backtick-quotes an identifier, escaping embedded backticks.
func quoteCHIdent(name string) string {
	return "`" + strings.ReplaceAll(name, "`", "``") + "`"
}

// msSince returns elapsed whole milliseconds since start.
func msSince(start time.Time) int64 {
	return time.Since(start).Milliseconds()
}
