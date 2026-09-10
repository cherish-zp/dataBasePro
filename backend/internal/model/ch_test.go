package model

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestClickHouseConfigValidate(t *testing.T) {
	// 合法多 host;空用户名/空库名归一 default。
	cfg := ClickHouseConfig{Hosts: []string{" ch-1:9000 ", "ch-2:9000"}}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if cfg.Username != "default" {
		t.Fatalf("empty username must default to \"default\", got %q", cfg.Username)
	}
	if cfg.Database != "default" {
		t.Fatalf("empty database must default to \"default\", got %q", cfg.Database)
	}
	if cfg.Hosts[0] != "ch-1:9000" || cfg.Hosts[1] != "ch-2:9000" {
		t.Fatalf("hosts must be trimmed: %+v", cfg.Hosts)
	}

	// 显式用户名与库名保持不变。
	cfg = ClickHouseConfig{Hosts: []string{"ch:9000"}, Username: "ops", Database: "logs"}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if cfg.Username != "ops" || cfg.Database != "logs" {
		t.Fatalf("explicit values must be kept: %+v", cfg)
	}
}

func TestClickHouseConfigValidateProtocol(t *testing.T) {
	// 空 Protocol 归一 native。
	cfg := ClickHouseConfig{Hosts: []string{"ch:9000"}}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if cfg.Protocol != CHProtocolNative {
		t.Fatalf("empty protocol must normalize to %q, got %q", CHProtocolNative, cfg.Protocol)
	}

	// 合法值原样保留。
	for _, p := range []string{CHProtocolNative, CHProtocolHTTP} {
		cfg = ClickHouseConfig{Hosts: []string{"ch:9000"}, Protocol: p}
		if err := cfg.Validate(); err != nil {
			t.Fatalf("Validate protocol %q: %v", p, err)
		}
		if cfg.Protocol != p {
			t.Fatalf("protocol %q must be kept, got %q", p, cfg.Protocol)
		}
	}

	// 非法值报错并点名 native/http。
	cfg = ClickHouseConfig{Hosts: []string{"ch:9000"}, Protocol: "grpc"}
	err := cfg.Validate()
	if err == nil {
		t.Fatal("invalid protocol must be rejected")
	}
	for _, want := range []string{"不支持的协议", "grpc", "native/http"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q must mention %q", err, want)
		}
	}
}

func TestClickHouseConfigValidateErrors(t *testing.T) {
	cases := []struct {
		name string
		cfg  ClickHouseConfig
		want string
	}{
		{"empty hosts", ClickHouseConfig{}, "hosts"},
		{"nil hosts", ClickHouseConfig{Username: "u", Database: "d"}, "hosts"},
		{"host without port", ClickHouseConfig{Hosts: []string{"ch-1"}}, "host:port"},
		{"second host without port", ClickHouseConfig{Hosts: []string{"ch-1:9000", "ch-2"}}, "host:port"},
	}
	for _, tc := range cases {
		err := tc.cfg.Validate()
		if err == nil {
			t.Fatalf("%s: expected error", tc.name)
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s: error %q must mention %q", tc.name, err, tc.want)
		}
	}
}

func TestConnectionValidateClickHouse(t *testing.T) {
	ok := &Connection{
		Name:   "ch",
		Type:   ConnectionTypeClickHouse,
		Config: MustConfigJSON(ClickHouseConfig{Hosts: []string{"ch-1:9000"}}),
	}
	if err := ok.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if !ConnectionTypeClickHouse.Valid() {
		t.Fatal("clickhouse type must be valid")
	}

	bad := &Connection{Name: "ch", Type: ConnectionTypeClickHouse}
	if err := bad.Validate(); err == nil {
		t.Fatal("empty clickhouse config must be rejected")
	}

	badCfg := &Connection{
		Name:   "ch",
		Type:   ConnectionTypeClickHouse,
		Config: MustConfigJSON(ClickHouseConfig{Hosts: []string{"no-port"}}),
	}
	if err := badCfg.Validate(); err == nil {
		t.Fatal("invalid clickhouse config must be rejected")
	}
}

func TestConnectionClickHouseConfigDecode(t *testing.T) {
	c := Connection{
		Type: ConnectionTypeClickHouse,
		Config: MustConfigJSON(ClickHouseConfig{
			Hosts: []string{"a:9000", "b:9000"}, Username: "u", Password: "p",
			Database: "db", TLS: true, Protocol: CHProtocolHTTP,
		}),
	}
	cfg, err := c.ClickHouseConfig()
	if err != nil {
		t.Fatalf("ClickHouseConfig: %v", err)
	}
	if len(cfg.Hosts) != 2 || cfg.Hosts[1] != "b:9000" || cfg.Username != "u" ||
		cfg.Password != "p" || cfg.Database != "db" || !cfg.TLS || cfg.Protocol != CHProtocolHTTP {
		t.Fatalf("unexpected decoded config: %+v", cfg)
	}

	// JSON 字段名锁定 wire 契约(snake_case,hosts 为数组)。
	raw, err := json.Marshal(ClickHouseConfig{Hosts: []string{"a:9000"}, Username: "u", Database: "d", TLS: true, Protocol: CHProtocolHTTP})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"hosts", "username", "database", "tls", "protocol"} {
		if _, ok := m[key]; !ok {
			t.Fatalf("ClickHouseConfig JSON must expose key %q, got %s", key, raw)
		}
	}
}

func TestCHTypesJSONShape(t *testing.T) {
	rows59 := int64(59)
	b, err := json.Marshal(CHTableInfo{Name: "events", Engine: "MergeTree", TotalRows: &rows59})
	if err != nil {
		t.Fatalf("marshal table: %v", err)
	}
	var tm map[string]any
	if err := json.Unmarshal(b, &tm); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"name", "engine", "total_rows"} {
		if _, ok := tm[key]; !ok {
			t.Fatalf("CHTableInfo JSON must expose %q, got %s", key, b)
		}
	}

	// total_rows 可空:null 序列化。
	b, err = json.Marshal(CHTableInfo{Name: "log", Engine: "StripeLog"})
	if err != nil {
		t.Fatalf("marshal table: %v", err)
	}
	if !strings.Contains(string(b), `"total_rows":null`) {
		t.Fatalf("nil total_rows must marshal as null, got %s", b)
	}

	// CHColumn 形状:comment 有值序列化;空值 omitempty 省略。
	b, err = json.Marshal(CHColumn{Name: "id", Type: "UInt64", Comment: "主键"})
	if err != nil {
		t.Fatalf("marshal column: %v", err)
	}
	if !strings.Contains(string(b), `"comment":"主键"`) {
		t.Fatalf("CHColumn must expose comment, got %s", b)
	}
	b, err = json.Marshal(CHColumn{Name: "id", Type: "UInt64"})
	if err != nil {
		t.Fatalf("marshal column: %v", err)
	}
	if strings.Contains(string(b), `"comment"`) {
		t.Fatalf("empty comment must be omitted, got %s", b)
	}

	// CHPageRowsResult 形状。
	b, err = json.Marshal(CHPageRowsResult{
		Columns: []CHColumn{{Name: "id", Type: "UInt64"}},
		Rows:    [][]*string{{strPtr("1"), nil}},
		Engine:  "MergeTree",
	})
	if err != nil {
		t.Fatalf("marshal page: %v", err)
	}
	if !strings.Contains(string(b), `"columns"`) || !strings.Contains(string(b), `"rows"`) ||
		!strings.Contains(string(b), `"engine"`) || !strings.Contains(string(b), `"total_rows":null`) {
		t.Fatalf("unexpected CHPageRowsResult JSON: %s", b)
	}

	// CHStatementResult 形状:成功带 columns/rows,失败带 error。
	b, err = json.Marshal(CHStatementResult{SQL: "SELECT 1", DurationMs: 3})
	if err != nil {
		t.Fatalf("marshal stmt: %v", err)
	}
	if !strings.Contains(string(b), `"sql"`) || !strings.Contains(string(b), `"duration_ms":3`) {
		t.Fatalf("unexpected CHStatementResult JSON: %s", b)
	}
	if strings.Contains(string(b), `"error"`) {
		t.Fatalf("success statement must omit error, got %s", b)
	}
	b, err = json.Marshal(CHStatementResult{SQL: "SELECT bad", DurationMs: 1, Error: "boom"})
	if err != nil {
		t.Fatalf("marshal stmt: %v", err)
	}
	if !strings.Contains(string(b), `"error":"boom"`) {
		t.Fatalf("failed statement must carry error, got %s", b)
	}
}

func strPtr(s string) *string { return &s }
