package store

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"dataBasePro/backend/internal/model"
)

func TestPostgresPasswordEncryptedAtRest(t *testing.T) {
	s, err := Open(t.TempDir()+"/config.db", "test-master")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	c := &model.Connection{
		ID:   "pg-1",
		Name: "pg",
		Type: model.ConnectionTypePostgres,
		Config: model.MustConfigJSON(model.PostgresConfig{
			Host: "db", Port: 5432, Username: "u", Password: "plain-secret", Database: "app",
		}),
	}
	if err := s.CreateConnection(c); err != nil {
		t.Fatalf("create: %v", err)
	}
	rows, err := s.db.Query("SELECT config_json FROM connections WHERE id = ?", "pg-1")
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	if !rows.Next() {
		t.Fatal("connection row missing")
	}
	var raw string
	if err := rows.Scan(&raw); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if strings.Contains(raw, "plain-secret") {
		t.Fatalf("stored config must not contain plaintext password: %s", raw)
	}
	if !strings.Contains(raw, "enc:v1:") {
		t.Fatalf("stored password should use encrypted prefix, got %s", raw)
	}
	rows.Close()
	loaded, err := s.GetConnection("pg-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	var cfg model.PostgresConfig
	if err := json.Unmarshal(loaded.Config, &cfg); err != nil {
		t.Fatalf("unmarshal loaded: %v", err)
	}
	if !bytes.Equal([]byte(cfg.Password), []byte("plain-secret")) {
		t.Fatalf("password roundtrip = %q", cfg.Password)
	}
}
