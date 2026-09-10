package model

import (
	"encoding/json"
	"strings"
	"testing"
)

// --- MysqlConfig.Validate ---

func TestMysqlConfigValidate_DefaultsPort(t *testing.T) {
	cfg := MysqlConfig{Host: " 127.0.0.1 "}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if cfg.Host != "127.0.0.1" {
		t.Fatalf("host must be trimmed, got %q", cfg.Host)
	}
	if cfg.Port != 3306 {
		t.Fatalf("port 0 must default to 3306, got %d", cfg.Port)
	}
	if cfg.TLSMode != MysqlTLSDisabled {
		t.Fatalf("empty tls_mode must normalize to disabled, got %q", cfg.TLSMode)
	}
}

func TestMysqlConfigValidate_PortBounds(t *testing.T) {
	cfg := MysqlConfig{Host: "h", Port: 65535}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("port 65535 must be accepted: %v", err)
	}
	for _, port := range []int{-1, 65536, 100000} {
		cfg := MysqlConfig{Host: "h", Port: port}
		if err := cfg.Validate(); err == nil {
			t.Fatalf("port %d must be rejected", port)
		}
	}
}

func TestMysqlConfigValidate_RequiresHost(t *testing.T) {
	cfg := MysqlConfig{Host: "   "}
	if err := cfg.Validate(); err == nil {
		t.Fatal("empty host must be rejected")
	}
}

func TestMysqlConfigValidate_TLSModeNormalized(t *testing.T) {
	cases := map[string]string{
		"":            MysqlTLSDisabled,
		" disabled ":  MysqlTLSDisabled,
		"SKIP-VERIFY": MysqlTLSSkipVerify,
		"Verify-Full": MysqlTLSVerifyFull,
	}
	for in, want := range cases {
		cfg := MysqlConfig{Host: "h", TLSMode: in}
		if err := cfg.Validate(); err != nil {
			t.Fatalf("tls_mode %q: %v", in, err)
		}
		if cfg.TLSMode != want {
			t.Fatalf("tls_mode %q must normalize to %q, got %q", in, want, cfg.TLSMode)
		}
	}
	bad := MysqlConfig{Host: "h", TLSMode: "insecure"}
	if err := bad.Validate(); err == nil {
		t.Fatal("unknown tls_mode must be rejected")
	}
}

// --- Connection.Validate / MysqlConfig 解码 ---

func TestConnectionValidate_MysqlAndTiDBTypesValid(t *testing.T) {
	for _, typ := range []ConnectionType{ConnectionTypeMySQL, ConnectionTypeTiDB} {
		if !typ.Valid() {
			t.Fatalf("type %q must be valid", typ)
		}
		c := &Connection{
			Name:   "local",
			Type:   typ,
			Config: MustConfigJSON(MysqlConfig{Host: "127.0.0.1"}),
		}
		if err := c.Validate(); err != nil {
			t.Fatalf("connection type %q: %v", typ, err)
		}
	}
}

func TestConnectionValidate_MysqlEmptyConfigRejected(t *testing.T) {
	c := &Connection{Name: "local", Type: ConnectionTypeTiDB}
	if err := c.Validate(); err == nil {
		t.Fatal("empty mysql config must be rejected")
	}
}

func TestConnectionValidate_MysqlInvalidConfigRejected(t *testing.T) {
	c := &Connection{Name: "local", Type: ConnectionTypeMySQL, Config: json.RawMessage(`{"port":0}`)}
	// port 0 合法(归一 3306),host 缺失才是非法。
	if err := c.Validate(); err == nil {
		t.Fatal("config without host must be rejected")
	}
	c.Config = json.RawMessage(`not-json`)
	if err := c.Validate(); err == nil {
		t.Fatal("malformed config must be rejected")
	}
}

func TestConnectionMysqlConfigDecode(t *testing.T) {
	c := &Connection{
		Name: "tidb",
		Type: ConnectionTypeTiDB,
		Config: MustConfigJSON(MysqlConfig{
			Host: "tidb.local", Port: 4000, Username: "root",
			Password: "pw", Database: "app", TLSMode: MysqlTLSSkipVerify,
		}),
	}
	cfg, err := c.MysqlConfig()
	if err != nil {
		t.Fatalf("MysqlConfig: %v", err)
	}
	if cfg.Host != "tidb.local" || cfg.Port != 4000 || cfg.Username != "root" ||
		cfg.Password != "pw" || cfg.Database != "app" || cfg.TLSMode != MysqlTLSSkipVerify {
		t.Fatalf("unexpected config: %+v", cfg)
	}
}

// --- wire 形状:json 字段全部 snake_case,nil 值显式 null ---

func TestMysqlWireJSONShapes(t *testing.T) {
	rows := int64(12)
	b, err := json.Marshal(MysqlTableInfo{Name: "events", Engine: "InnoDB", TableRows: &rows})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"name", "engine", "table_rows"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("MysqlTableInfo JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(MysqlColumn{Name: "id", Type: "bigint", Comment: "pk", IsInPrimaryKey: true})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"name", "type", "comment", "is_in_primary_key"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("MysqlColumn JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(MysqlPageRowsResult{
		Columns: []MysqlColumn{}, Rows: [][]*string{}, PrimaryKey: []string{"id"}, TotalRows: 3, Engine: "InnoDB",
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"columns", "rows", "total_rows", "primary_key", "engine"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("MysqlPageRowsResult JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(MysqlStatementResult{SQL: "SELECT 1", DurationMs: 2})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"sql", "duration_ms"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("MysqlStatementResult JSON must expose %q, got %s", key, b)
		}
	}

	// 单元格编辑:set/where 的 value 为 nil 时必须显式序列化为 null(SQL NULL 语义)。
	b, err = json.Marshal(MysqlCellUpdateRequest{
		ConnectionID: "c", Database: "d", Table: "t",
		Set:   MysqlCellValue{Column: "note"},
		Where: []MysqlCellValue{{Column: "id", Value: strPtr("1")}},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "database", "table", "set", "where", "column", "value"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("MysqlCellUpdateRequest JSON must expose %q, got %s", key, b)
		}
	}
	if !strings.Contains(string(b), `"value":null`) {
		t.Fatalf("nil cell value must marshal as null, got %s", b)
	}

	b, err = json.Marshal(MysqlCellUpdatePreview{Statement: "UPDATE", MatchedRows: 2})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"statement", "matched_rows"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("MysqlCellUpdatePreview JSON must expose %q, got %s", key, b)
		}
	}
}
