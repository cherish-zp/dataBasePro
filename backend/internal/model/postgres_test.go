package model

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPostgresConfigValidateDefaults(t *testing.T) {
	cfg := PostgresConfig{Host: " 127.0.0.1 ", Database: " app "}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if cfg.Host != "127.0.0.1" {
		t.Fatalf("host = %q", cfg.Host)
	}
	if cfg.Port != 5432 {
		t.Fatalf("port = %d, want 5432", cfg.Port)
	}
	if cfg.TLSMode != PostgresTLSDisable {
		t.Fatalf("tls_mode = %q", cfg.TLSMode)
	}
	if cfg.ConnectTimeoutMs != 5000 {
		t.Fatalf("connect_timeout_ms = %d", cfg.ConnectTimeoutMs)
	}
}

func TestPostgresConfigValidateTLSModesAndRequiredDatabase(t *testing.T) {
	cfg := PostgresConfig{Host: "db", Database: "app", TLSMode: " VERIFY-CA "}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Verify-CA: %v", err)
	}
	if cfg.TLSMode != PostgresTLSVerifyCA {
		t.Fatalf("tls_mode = %q", cfg.TLSMode)
	}
	cfg = PostgresConfig{Host: "db"}
	if err := cfg.Validate(); err == nil {
		t.Fatal("empty database must fail")
	}
	cfg = PostgresConfig{Host: "db", Database: "app", TLSMode: "invalid"}
	if err := cfg.Validate(); err == nil {
		t.Fatal("invalid tls mode must fail")
	}
	cfg = PostgresConfig{Host: "", Database: "app"}
	if err := cfg.Validate(); err == nil {
		t.Fatal("empty host must fail")
	}
	cfg = PostgresConfig{Host: "db", Database: "app", Port: 70000}
	if err := cfg.Validate(); err == nil {
		t.Fatal("invalid port must fail")
	}
}

func TestPostgresConfigJSONShape(t *testing.T) {
	raw, err := json.Marshal(PostgresConfig{
		Host: "db", Port: 5433, Username: "u", Password: "secret",
		Database: "app", TLSMode: "require", SearchPath: "public,app",
		ConnectTimeoutMs: 1500,
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var shape map[string]any
	if err := json.Unmarshal(raw, &shape); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"host", "port", "username", "password", "database", "tls_mode", "search_path", "connect_timeout_ms"} {
		if _, ok := shape[key]; !ok {
			t.Fatalf("missing JSON key %q in %s", key, string(raw))
		}
	}
}

func TestConnectionValidateAndDecodePostgres(t *testing.T) {
	c := Connection{
		Name: "pg-local",
		Type: ConnectionTypePostgres,
		Config: MustConfigJSON(PostgresConfig{
			Host: "db", Port: 5432, Username: "u", Password: "secret", Database: "app",
		}),
	}
	if err := c.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	cfg, err := c.PostgresConfig()
	if err != nil {
		t.Fatalf("PostgresConfig: %v", err)
	}
	if cfg.Host != "db" || cfg.Database != "app" || cfg.Port != 5432 {
		t.Fatalf("unexpected config: %+v", cfg)
	}
	bad := c
	bad.Type = ConnectionType("unknown")
	if err := bad.Validate(); err == nil {
		t.Fatal("invalid connection type must fail")
	}
}

func TestPostgresTableInfoJSONContract(t *testing.T) {
	raw, err := json.Marshal(PostgresTableInfo{
		Relation:        "users",
		Schema:          "public",
		RelationType:    string(PostgresRelationKindTable),
		RelationKind:    PostgresRelationKindTable,
		RawRelationType: "r",
		PrimaryKey:      []string{"id"},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var shape map[string]any
	if err := json.Unmarshal(raw, &shape); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"relation", "schema", "relation_type", "relation_kind", "raw_relation_type", "primary_key"} {
		if _, ok := shape[key]; !ok {
			t.Fatalf("missing JSON key %q in %s", key, string(raw))
		}
	}
	if shape["relation_type"] != string(PostgresRelationKindTable) {
		t.Fatalf("relation_type = %v, want %q", shape["relation_type"], PostgresRelationKindTable)
	}
}

func TestPostgresStatementResultJSONContract(t *testing.T) {
	query, err := json.Marshal(PostgresStatementResult{
		Statement: "SELECT 1",
		HasRows:   true,
		Columns:   []PostgresColumn{{Name: "id"}},
		Rows:      [][]*string{{strPointer("1")}},
	})
	if err != nil {
		t.Fatalf("marshal query: %v", err)
	}
	if strings.Contains(string(query), `"sql"`) || strings.Contains(string(query), `"relation_name"`) || !strings.Contains(string(query), `"statement"`) || !strings.Contains(string(query), `"has_rows":true`) {
		t.Fatalf("query result contract mismatch: %s", string(query))
	}

	nonQuery, err := json.Marshal(PostgresStatementResult{Statement: "UPDATE users SET id = id", HasRows: false})
	if err != nil {
		t.Fatalf("marshal update: %v", err)
	}
	if strings.Contains(string(nonQuery), `"sql"`) || !strings.Contains(string(nonQuery), `"statement"`) || !strings.Contains(string(nonQuery), `"has_rows":false`) {
		t.Fatalf("non-query result contract mismatch: %s", string(nonQuery))
	}
}

func TestPostgresCellUpdateRequestJSONContract(t *testing.T) {
	raw, err := json.Marshal(PostgresCellUpdateRequest{RelationKind: PostgresRelationKindTable})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var shape map[string]any
	if err := json.Unmarshal(raw, &shape); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := shape["relation_kind"]; !ok {
		t.Fatalf("missing JSON key relation_kind in %s", string(raw))
	}
}

func TestPostgresRelationKindTruncate(t *testing.T) {
	if PostgresRelationKindTable.CanTruncate() != true {
		t.Fatal("table must be truncatable")
	}
	for _, kind := range []PostgresRelationKind{PostgresRelationKindView, PostgresRelationKindMaterializedView} {
		if kind.CanTruncate() {
			t.Fatalf("%s must reject truncate", kind)
		}
	}
}

func strPointer(value string) *string { return &value }
