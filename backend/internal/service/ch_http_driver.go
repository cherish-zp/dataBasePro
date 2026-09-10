package service

import (
	"context"
	"crypto/tls"
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"dataBasePro/backend/internal/model"
)

// CH HTTP 自实现通道:clickhouse-go 的 HTTP 传输会在所有请求上固化
// client_protocol_version setting,老服务器(如 22.8)对该 setting 报
// 404 UNKNOWN_SETTING。HTTP 协议模式因此绕开驱动传输,以 database/sql
// 驱动直发 POST(default_format=JSONCompactEachRowWithNamesAndTypes),
// 老服务器全兼容。native 模式不受影响,仍走 clickhouse-go。

const chHTTPFormat = "JSONCompactEachRowWithNamesAndTypes"

// chHTTPConnector implements driver.Connector so sql.OpenDB can build an
// *sql.DB over the HTTP transport without a global sql.Register name.
type chHTTPConnector struct {
	cfg    model.ClickHouseConfig
	tlsCfg *tls.Config
}

func (c chHTTPConnector) Connect(ctx context.Context) (driver.Conn, error) {
	return &chHTTPConn{cfg: c.cfg, tlsCfg: c.tlsCfg, client: &http.Client{Timeout: 30 * time.Second}}, nil
}

func (c chHTTPConnector) Driver() driver.Driver { return chHTTPDriver{} }

type chHTTPDriver struct{}

func (d chHTTPDriver) Open(string) (driver.Conn, error) {
	return nil, fmt.Errorf("ch-http: 请使用 Connector 打开")
}

// chHTTPConn implements driver.Conn + QueryerContext + ExecerContext +
// Pinger over plain HTTP POSTs.
type chHTTPConn struct {
	cfg     model.ClickHouseConfig
	tlsCfg  *tls.Config
	client  *http.Client
	lastErr error
}

func (c *chHTTPConn) Prepare(query string) (driver.Stmt, error) {
	return nil, fmt.Errorf("ch-http: 预编译语句不受支持,请直接执行")
}

func (c *chHTTPConn) Close() error { return nil }

func (c *chHTTPConn) Begin() (driver.Tx, error) {
	return nil, fmt.Errorf("ch-http: 不支持事务")
}

// Ping issues a trivial query; HTTP success (200) proves reachability.
func (c *chHTTPConn) Ping(ctx context.Context) error {
	_, _, err := c.query(ctx, "SELECT 1", nil)
	return err
}

// query posts the SQL text and decodes the response according to format:
// JSONCompactEachRowWithNamesAndTypes for row sets, plain body for execs.
// 多节点按 Hosts 顺序尝试,首个成功的主机用于后续请求。
func (c *chHTTPConn) query(ctx context.Context, sqlText string, args []driver.NamedValue) ([]string, [][]*string, error) {
	sqlText = substituteArgs(sqlText, args)
	fmt.Printf("DBG query sqlText=%q args=%v\n", sqlText, args)
	transport := &http.Transport{}
	if c.tlsCfg != nil {
		transport.TLSClientConfig = c.tlsCfg
	}
	client := &http.Client{Timeout: 60 * time.Second, Transport: transport}

	var lastErr error
	for _, host := range c.cfg.Hosts {
		scheme := "http"
		if c.tlsCfg != nil {
			scheme = "https"
		}
		u := fmt.Sprintf("%s://%s/?database=%s&default_format=%s", scheme, host, c.cfg.Database, chHTTPFormat)
		req, rerr := http.NewRequestWithContext(ctx, http.MethodPost, u, strings.NewReader(sqlText))
		if rerr != nil {
			return nil, nil, rerr
		}
		req.Header.Set("Content-Type", "text/plain; charset=UTF-8")
		req.Header.Set("X-ClickHouse-User", c.cfg.Username)
		if c.cfg.Password != "" {
			req.Header.Set("X-ClickHouse-Key", c.cfg.Password)
		}
		resp, rerr := client.Do(req)
		if rerr != nil {
			lastErr = rerr
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("clickhouse http: HTTP %d: %s", resp.StatusCode, truncateBody(string(body), 300))
			continue
		}
		if len(strings.TrimSpace(string(body))) == 0 {
			return nil, nil, nil // 无结果集(DDL/INSERT 等)
		}
		names, types, rows, perr := parseCHHTTPJSONCompact(body)
		if perr != nil {
			return nil, nil, perr
		}
		_ = types
		return names, rows, nil
	}
	return nil, nil, fmt.Errorf("clickhouse http: %w", lastErr)
}

// exec posts a statement without expecting a result set.
func (c *chHTTPConn) exec(ctx context.Context, sqlText string, args []driver.NamedValue) error {
	_, _, err := c.query(ctx, sqlText, args)
	return err
}

func (c *chHTTPConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	names, rows, err := c.query(ctx, query, args)
	if err != nil {
		return nil, err
	}
	return &chHTTPRows{names: names, rows: rows, pos: -1}, nil
}

func (c *chHTTPConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if err := c.exec(ctx, query, args); err != nil {
		return nil, err
	}
	return driver.RowsAffected(0), nil
}

// chHTTPRows adapts the decoded rows to driver.Rows.
type chHTTPRows struct {
	names []string
	rows  [][]*string
	pos   int
}

func (r *chHTTPRows) Columns() []string { return r.names }

func (r *chHTTPRows) Close() error { return nil }

func (r *chHTTPRows) Next(dest []driver.Value) error {
	r.pos++
	if r.pos >= len(r.rows) {
		return io.EOF
	}
	for i, cell := range r.rows[r.pos] {
		if i >= len(dest) {
			break
		}
		if cell == nil {
			dest[i] = nil
		} else {
			dest[i] = *cell
		}
	}
	return nil
}

// parseCHHTTPJSONCompact decodes the CH HTTP rowset: real servers emit
// JSONCompactEachRowWithNamesAndTypes as newline-delimited JSON arrays —
// line 1 = column names, line 2 = column types, then one data row per line.
// 每个单元格:null → nil(= SQL NULL),数字保留原文文本(避免 UInt64
// 精度丢失),字符串去引号,复杂类型保留原始 JSON 文本。
func parseCHHTTPJSONCompact(body []byte) (names []string, types []string, rows [][]*string, err error) {
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" || !strings.HasPrefix(trimmed, "[") {
		// 无结果集(DDL/INSERT/标量等)。
		return nil, nil, nil, nil
	}
	lines := strings.Split(trimmed, "\n")
	lineArr := func(line string) ([]json.RawMessage, error) {
		var arr []json.RawMessage
		if err := json.Unmarshal([]byte(line), &arr); err != nil {
			return nil, fmt.Errorf("解析行 %q 失败: %w", line, err)
		}
		return arr, nil
	}
	namesRow, err := lineArr(lines[0])
	if err != nil {
		return nil, nil, nil, err
	}
	cellText := func(v json.RawMessage) *string {
		if string(v) == "null" {
			return nil
		}
		if v[0] == '"' {
			var s string
			if err := json.Unmarshal(v, &s); err == nil {
				return &s
			}
		}
		s := string(v)
		return &s
	}
	for _, v := range namesRow {
		if s := cellText(v); s != nil {
			names = append(names, *s)
		}
	}
	if len(lines) < 2 {
		return names, nil, nil, nil
	}
	typesRow, err := lineArr(lines[1])
	if err != nil {
		return nil, nil, nil, err
	}
	for _, v := range typesRow {
		if s := cellText(v); s != nil {
			types = append(types, *s)
		}
	}
	for _, line := range lines[2:] {
		if strings.TrimSpace(line) == "" {
			continue
		}
		dataRow, err := lineArr(line)
		if err != nil {
			return nil, nil, nil, err
		}
		cells := make([]*string, len(dataRow))
		for i, v := range dataRow {
			cells[i] = cellText(v)
		}
		rows = append(rows, cells)
	}
	return names, types, rows, nil
}

// truncateBody bounds an error body for readability.
func truncateBody(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) > max {
		return s[:max] + "…"
	}
	return s
}

// buildHTTPConnector builds the database/sql connector for HTTP protocol.
func buildHTTPConnector(cfg model.ClickHouseConfig) (driver.Connector, error) {
	var tlsCfg *tls.Config
	if cfg.TLS {
		host := cfg.Hosts[0]
		if i := strings.LastIndex(host, ":"); i > 0 {
			host = host[:i]
		}
		tlsCfg = &tls.Config{ServerName: host}
	}
	return chHTTPConnector{cfg: cfg, tlsCfg: tlsCfg}, nil
}

// substituteArgs 把 ? 占位符按序替换为字面量(HTTP 端点不支持绑定参数)。
func substituteArgs(query string, args []driver.NamedValue) string {
	if len(args) == 0 {
		return query
	}
	var b strings.Builder
	ai := 0
	for i := 0; i < len(query); i++ {
		if query[i] == '?' && ai < len(args) {
			arg := args[ai].Value
			ai++
			if arg == nil {
				b.WriteString("NULL")
				continue
			}
			switch v := arg.(type) {
			case string:
				b.WriteString("'" + strings.ReplaceAll(v, "'", "''") + "'")
			case []byte:
				b.WriteString("'" + strings.ReplaceAll(string(v), "'", "''") + "'")
			case time.Time:
				b.WriteString("'" + v.Format(time.RFC3339) + "'")
			case bool:
				if v {
					b.WriteString("1")
				} else {
					b.WriteString("0")
				}
			default:
				b.WriteString(fmt.Sprint(v))
			}
			continue
		}
		b.WriteByte(query[i])
	}
	return b.String()
}
