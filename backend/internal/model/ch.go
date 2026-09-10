package model

import (
	"errors"
	"fmt"
	"net"
	"strings"
)

// ConnectionTypeClickHouse identifies a ClickHouse data source.
const ConnectionTypeClickHouse ConnectionType = "clickhouse"

// Supported ClickHouse wire protocols. "native" is the TCP protocol on port
// 9000; "http" is the HTTP protocol on port 8123. The driver must match the
// server's exposed port, otherwise the handshake fails with an "unexpected
// packet" error.
const (
	CHProtocolNative = "native"
	CHProtocolHTTP   = "http"
)

// ClickHouseConfig holds the connection settings for a ClickHouse server
// (cluster or single node). Hosts are host:port pairs on the port matching
// Protocol (native 9000 or HTTP 8123); the driver tries them per its open
// strategy. Username and Database normalize to "default" when empty, matching
// ClickHouse defaults.
type ClickHouseConfig struct {
	Hosts    []string `json:"hosts"`
	Username string   `json:"username"`
	Password string   `json:"password,omitempty"`
	Database string   `json:"database"`
	TLS      bool     `json:"tls,omitempty"`
	Protocol string   `json:"protocol,omitempty"`
}

// Validate checks the ClickHouse configuration and normalizes it in place:
// hosts are trimmed and must be host:port pairs; an empty username or
// database becomes "default"; an empty Protocol becomes "native" and any
// other value must be one of native/http (case-insensitive input).
func (c *ClickHouseConfig) Validate() error {
	if len(c.Hosts) == 0 {
		return errors.New("clickhouse hosts must not be empty")
	}
	for i, h := range c.Hosts {
		h = strings.TrimSpace(h)
		if _, _, err := net.SplitHostPort(h); err != nil {
			return fmt.Errorf("invalid clickhouse host %q (expected host:port): %w", h, err)
		}
		c.Hosts[i] = h
	}
	if u := strings.TrimSpace(c.Username); u == "" {
		c.Username = "default"
	} else {
		c.Username = u
	}
	if d := strings.TrimSpace(c.Database); d == "" {
		c.Database = "default"
	} else {
		c.Database = d
	}
	switch p := strings.ToLower(strings.TrimSpace(c.Protocol)); p {
	case "":
		c.Protocol = CHProtocolNative
	case CHProtocolNative, CHProtocolHTTP:
		c.Protocol = p
	default:
		return fmt.Errorf("不支持的协议 %q(仅支持 native/http)", c.Protocol)
	}
	return nil
}

// CHColumn is one result column: its name plus the ClickHouse type string
// (e.g. "UInt64", "Nullable(String)"). Comment mirrors system.columns.comment
// (empty string = no description; omitted on the wire).
type CHColumn struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	Comment string `json:"comment,omitempty"`
}

// CHTableInfo is one row of the table listing. TotalRows mirrors
// system.tables.total_rows: nil (null on the wire) when the engine cannot
// report an approximate row count.
type CHTableInfo struct {
	Name      string `json:"name"`
	Engine    string `json:"engine"`
	TotalRows *int64 `json:"total_rows"`
}

// CHPageRowsResult is one page of a table's rows. Cells are pre-formatted
// strings; a nil cell means SQL NULL. PrimaryKey lists the primary key column
// names in defining order (system.columns.is_in_primary_key); empty when the
// table has none.
type CHPageRowsResult struct {
	Columns    []CHColumn  `json:"columns"`
	Rows       [][]*string `json:"rows"`
	Engine     string      `json:"engine"`
	TotalRows  *int64      `json:"total_rows"`
	PrimaryKey []string    `json:"primary_key"`
}

// CHCellValue binds one column to a typed value: Type carries the ClickHouse
// type string (it drives how the backend renders the SQL literal) and a nil
// Value means SQL NULL.
type CHCellValue struct {
	Column string  `json:"column"`
	Type   string  `json:"type"`
	Value  *string `json:"value"`
}

// CHCellUpdateRequest locates rows by Where and rewrites Set.Column in them
// (single cell edit in the table detail / SQL result grid). Database may be
// empty to target the connection's configured default database.
type CHCellUpdateRequest struct {
	ConnectionID string        `json:"connection_id"`
	Database     string        `json:"database"`
	Table        string        `json:"table"`
	Set          CHCellValue   `json:"set"`
	Where        []CHCellValue `json:"where"`
}

// CHCellUpdatePreview is the read-only outcome of a cell-update preview: the
// exact statement the backend would run plus the number of rows matched by
// the same WHERE conditions.
type CHCellUpdatePreview struct {
	Statement   string `json:"statement"`
	MatchedRows int64  `json:"matched_rows"`
}

// CHStatementResult is the per-statement outcome of a multi-statement script:
// duration in ms, and either columns+rows (statements returning a result set)
// or an error text (failed statement; execution stops there).
type CHStatementResult struct {
	SQL        string      `json:"sql"`
	DurationMs int64       `json:"duration_ms"`
	Error      string      `json:"error,omitempty"`
	Columns    []CHColumn  `json:"columns,omitempty"`
	Rows       [][]*string `json:"rows,omitempty"`
}
