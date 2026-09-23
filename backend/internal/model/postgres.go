package model

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// ConnectionTypePostgres identifies a PostgreSQL data source.
const ConnectionTypePostgres ConnectionType = "postgres"

// PostgreSQL TLS modes accepted by libpq/pgx.
const (
	PostgresTLSDisable    = "disable"
	PostgresTLSRequire    = "require"
	PostgresTLSVerifyCA   = "verify-ca"
	PostgresTLSVerifyFull = "verify-full"
)

// PostgresConfig stores the details required to connect to PostgreSQL. The
// password is encrypted by the store layer before persistence.
type PostgresConfig struct {
	Host             string `json:"host"`
	Port             int    `json:"port"`
	Username         string `json:"username"`
	Password         string `json:"password,omitempty"`
	Database         string `json:"database"`
	TLSMode          string `json:"tls_mode"`
	SearchPath       string `json:"search_path"`
	ConnectTimeoutMs int    `json:"connect_timeout_ms"`
}

// Validate checks and normalizes the PostgreSQL configuration in place.
func (c *PostgresConfig) Validate() error {
	c.Host = strings.TrimSpace(c.Host)
	if c.Host == "" {
		return errors.New("postgres host 不能为空")
	}
	c.Database = strings.TrimSpace(c.Database)
	if c.Database == "" {
		return errors.New("postgres database 不能为空")
	}
	if c.Port == 0 {
		c.Port = 5432
	}
	if c.Port < 1 || c.Port > 65535 {
		return fmt.Errorf("postgres 端口超出范围(1..65535): %s", strconv.Itoa(c.Port))
	}
	switch m := strings.ToLower(strings.TrimSpace(c.TLSMode)); m {
	case "":
		c.TLSMode = PostgresTLSDisable
	case PostgresTLSDisable, PostgresTLSRequire, PostgresTLSVerifyCA, PostgresTLSVerifyFull:
		c.TLSMode = m
	default:
		return fmt.Errorf("不支持的 TLS 模式 %q(仅支持 disable/require/verify-ca/verify-full)", c.TLSMode)
	}
	c.SearchPath = strings.TrimSpace(c.SearchPath)
	if c.ConnectTimeoutMs == 0 {
		c.ConnectTimeoutMs = 5000
	}
	if c.ConnectTimeoutMs < 0 {
		return errors.New("postgres connect_timeout_ms 不能为负数")
	}
	return nil
}

// PostgresRelationKind is the semantic relation type exposed to the UI.
type PostgresRelationKind string

const (
	PostgresRelationKindTable            PostgresRelationKind = "table"
	PostgresRelationKindView             PostgresRelationKind = "view"
	PostgresRelationKindMaterializedView PostgresRelationKind = "materialized_view"
)

// Valid reports whether kind is one of the supported semantic kinds.
func (k PostgresRelationKind) Valid() bool {
	switch k {
	case PostgresRelationKindTable, PostgresRelationKindView, PostgresRelationKindMaterializedView:
		return true
	}
	return false
}

// CanTruncate reports whether TRUNCATE is allowed for this kind.
func (k PostgresRelationKind) CanTruncate() bool {
	return k == PostgresRelationKindTable
}

// PostgresTableInfo describes one relation and its primary-key metadata.
type PostgresTableInfo struct {
	Relation string `json:"relation"`
	Schema   string `json:"schema"`
	// RelationType is semantic for the frontend contract; RawRelationType
	// preserves pg_class.relkind when diagnostics need the original code.
	RelationType string               `json:"relation_type"`
	RelationKind PostgresRelationKind `json:"relation_kind"`
	// RawRelationType preserves the PostgreSQL pg_class relkind code (r/p/f/v/m)
	// when the frontend or diagnostics need it; relation_type stays semantic.
	RawRelationType string   `json:"raw_relation_type,omitempty"`
	PrimaryKey      []string `json:"primary_key"`
	Comment         string   `json:"comment,omitempty"`
}

// PostgresColumn is one result column with primary-key membership.
type PostgresColumn struct {
	Name           string `json:"name"`
	Type           string `json:"type"`
	IsInPrimaryKey bool   `json:"is_in_primary_key"`
}

// PostgresPageRowsResult is one page of rows plus table metadata.
type PostgresPageRowsResult struct {
	Columns    []PostgresColumn `json:"columns"`
	Rows       [][]*string      `json:"rows"`
	PrimaryKey []string         `json:"primary_key"`
	TotalRows  int64            `json:"total_rows"`
}

// PostgresCellValue binds one column to a string (nil = SQL NULL).
type PostgresCellValue struct {
	Column string  `json:"column"`
	Value  *string `json:"value"`
}

// PostgresCellUpdateRequest locates rows only by primary-key conditions.
type PostgresCellUpdateRequest struct {
	ConnectionID string               `json:"connection_id"`
	Database     string               `json:"database"`
	Schema       string               `json:"schema"`
	Relation     string               `json:"relation"`
	RelationKind PostgresRelationKind `json:"relation_kind"`
	Set          PostgresCellValue    `json:"set"`
	Where        []PostgresCellValue  `json:"where"`
}

// PostgresCellUpdatePreview is the read-only parameterized statement preview.
type PostgresCellUpdatePreview struct {
	Statement   string `json:"statement"`
	MatchedRows int64  `json:"matched_rows"`
}

// PostgresStatementResult is one statement's execution outcome.
type PostgresStatementResult struct {
	Statement    string           `json:"statement"`
	HasRows      bool             `json:"has_rows"`
	DurationMs   int64            `json:"duration_ms"`
	Error        string           `json:"error,omitempty"`
	Columns      []PostgresColumn `json:"columns,omitempty"`
	Rows         [][]*string      `json:"rows,omitempty"`
	PrimaryKey   []string         `json:"primary_key,omitempty"`
	AffectedRows int64            `json:"affected_rows"`
}
