package model

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// Supported MySQL/TiDB TLS modes. TiDB speaks the MySQL wire protocol, so one
// implementation serves both connection types. "" normalizes to "disabled".
const (
	MysqlTLSDisabled   = "disabled"
	MysqlTLSSkipVerify = "skip-verify"
	MysqlTLSVerifyFull = "verify-full"
)

// MysqlConfig holds the connection settings for a MySQL or TiDB server. An
// empty Port defaults to 3306 (TiDB deployments usually override it to 4000)
// and Database may be empty to connect without a default schema.
type MysqlConfig struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password,omitempty"`
	Database string `json:"database"`
	// TLSMode is one of disabled/skip-verify/verify-full ("" normalizes to
	// disabled during Validate).
	TLSMode string `json:"tls_mode,omitempty"`
}

// Validate checks the MySQL configuration and normalizes it in place: the
// host is required (trimmed), a zero port becomes 3306 (any other value must
// be in 1..65535) and the TLS mode is trimmed, lower-cased and must be one of
// disabled/skip-verify/verify-full.
func (c *MysqlConfig) Validate() error {
	h := strings.TrimSpace(c.Host)
	if h == "" {
		return errors.New("mysql host 不能为空")
	}
	c.Host = h
	if c.Port == 0 {
		c.Port = 3306
	}
	if c.Port < 1 || c.Port > 65535 {
		return fmt.Errorf("mysql 端口超出范围(1..65535): %s", strconv.Itoa(c.Port))
	}
	switch m := strings.ToLower(strings.TrimSpace(c.TLSMode)); m {
	case "":
		c.TLSMode = MysqlTLSDisabled
	case MysqlTLSDisabled, MysqlTLSSkipVerify, MysqlTLSVerifyFull:
		c.TLSMode = m
	default:
		return fmt.Errorf("不支持的 TLS 模式 %q(仅支持 disabled/skip-verify/verify-full)", c.TLSMode)
	}
	return nil
}

// MysqlColumn is one result column: name, MySQL type string (e.g. "bigint",
// "varchar(255)"), the column comment (empty string = no description; omitted
// on the wire) and whether the column is part of the table's primary key
// (information_schema.columns.column_key = 'PRI'). For SQL-console results
// Type may be empty (the driver does not always report a type name).
type MysqlColumn struct {
	Name           string `json:"name"`
	Type           string `json:"type"`
	Comment        string `json:"comment,omitempty"`
	IsInPrimaryKey bool   `json:"is_in_primary_key"`
}

// MysqlTableInfo is one row of the table listing. TableRows mirrors
// information_schema.tables.table_rows: nil (null on the wire) when the
// engine cannot report an approximate row count.
type MysqlTableInfo struct {
	Name      string `json:"name"`
	Engine    string `json:"engine"`
	TableRows *int64 `json:"table_rows"`
	Comment   string `json:"comment,omitempty"`
}

// MysqlPageRowsResult is one page of a table's rows. Cells are pre-formatted
// strings; a nil cell means SQL NULL. PrimaryKey lists the primary key column
// names in defining order (empty when the table has none); TotalRows is the
// exact table row count (COUNT(*)), driving the paginator.
type MysqlPageRowsResult struct {
	Columns    []MysqlColumn `json:"columns"`
	Rows       [][]*string   `json:"rows"`
	TotalRows  int64         `json:"total_rows"`
	PrimaryKey []string      `json:"primary_key"`
	Engine     string        `json:"engine"`
}

// MysqlCellValue binds one column to a value: a nil Value means SQL NULL.
// Unlike the ClickHouse counterpart there is no Type field — the execution
// path is fully parameterized and the preview renders string literals.
type MysqlCellValue struct {
	Column string  `json:"column"`
	Value  *string `json:"value"`
}

// MysqlCellUpdateRequest locates rows by Where and rewrites Set.Column in them
// (single cell edit in the table detail / SQL result grid). Where conditions
// may only reference primary key columns (enforced server-side); Database may
// be empty to target the connection's configured default database.
type MysqlCellUpdateRequest struct {
	ConnectionID string           `json:"connection_id"`
	Database     string           `json:"database"`
	Table        string           `json:"table"`
	Set          MysqlCellValue   `json:"set"`
	Where        []MysqlCellValue `json:"where"`
}

// MysqlCellUpdatePreview is the read-only outcome of a cell-update preview:
// the statement text for display (values rendered as escaped SQL literals)
// plus the number of rows matched by the same WHERE conditions. The actual
// update never runs this text — it executes a parameterized statement.
type MysqlCellUpdatePreview struct {
	Statement   string `json:"statement"`
	MatchedRows int64  `json:"matched_rows"`
}

// MysqlStatementResult is the per-statement outcome of a multi-statement
// script: duration in ms, and either columns+rows (statements returning a
// result set) or an error text (failed statement; execution stops there).
type MysqlStatementResult struct {
	SQL        string        `json:"sql"`
	DurationMs int64         `json:"duration_ms"`
	Error      string        `json:"error,omitempty"`
	Columns    []MysqlColumn `json:"columns,omitempty"`
	Rows       [][]*string   `json:"rows,omitempty"`
}
