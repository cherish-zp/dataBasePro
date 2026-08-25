package store

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"dataBasePro/backend/internal/model"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.db")
	s, err := Open(path, "test-master-password")
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func sampleConnection(id string) *model.Connection {
	return &model.Connection{
		ID:   id,
		Name: "local-dev",
		Type: model.ConnectionTypeKafka,
		Config: model.KafkaConfig{
			BootstrapServers: []string{"localhost:9092"},
			SASL: &model.SASLConfig{
				Enabled:   true,
				Mechanism: model.SaslPlain,
				Username:  "user",
				Password:  "super-secret",
			},
		},
	}
}

func TestStoreCreateAndGet(t *testing.T) {
	s := newTestStore(t)
	if err := s.CreateConnection(sampleConnection("c1")); err != nil {
		t.Fatalf("CreateConnection failed: %v", err)
	}
	got, err := s.GetConnection("c1")
	if err != nil {
		t.Fatalf("GetConnection failed: %v", err)
	}
	if got.Name != "local-dev" || got.Type != model.ConnectionTypeKafka {
		t.Fatalf("unexpected connection: %+v", got)
	}
	if got.Config.SASL.Password != "super-secret" {
		t.Fatalf("password not round-tripped: %q", got.Config.SASL.Password)
	}
	if got.CreatedAt == 0 || got.UpdatedAt == 0 {
		t.Fatal("timestamps must be set")
	}
}

func TestStorePasswordEncryptedAtRest(t *testing.T) {
	s := newTestStore(t)
	if err := s.CreateConnection(sampleConnection("c1")); err != nil {
		t.Fatalf("CreateConnection failed: %v", err)
	}
	var raw string
	if err := s.db.QueryRow(`SELECT config_json FROM connections WHERE id = ?`, "c1").Scan(&raw); err != nil {
		t.Fatalf("query raw config failed: %v", err)
	}
	if strings.Contains(raw, "super-secret") {
		t.Fatal("plaintext password must not appear in stored config_json")
	}
	if !strings.Contains(raw, "enc:v1:") {
		t.Fatal("stored config_json must contain an encrypted password field")
	}
}

func TestStoreUpdate(t *testing.T) {
	s := newTestStore(t)
	c := sampleConnection("c1")
	if err := s.CreateConnection(c); err != nil {
		t.Fatalf("create failed: %v", err)
	}
	c.Name = "renamed"
	c.Config.BootstrapServers = []string{"broker-a:9092", "broker-b:9092"}
	if err := s.UpdateConnection(c); err != nil {
		t.Fatalf("update failed: %v", err)
	}
	got, _ := s.GetConnection("c1")
	if got.Name != "renamed" || len(got.Config.BootstrapServers) != 2 {
		t.Fatalf("update not applied: %+v", got)
	}
}

func TestStoreUpdateMissing(t *testing.T) {
	s := newTestStore(t)
	if err := s.UpdateConnection(sampleConnection("nope")); err == nil {
		t.Fatal("updating a missing connection must fail")
	}
}

func TestStoreDelete(t *testing.T) {
	s := newTestStore(t)
	if err := s.CreateConnection(sampleConnection("c1")); err != nil {
		t.Fatalf("create failed: %v", err)
	}
	if err := s.DeleteConnection("c1"); err != nil {
		t.Fatalf("delete failed: %v", err)
	}
	if _, err := s.GetConnection("c1"); err == nil {
		t.Fatal("connection must be gone after delete")
	}
}

func TestStoreList(t *testing.T) {
	s := newTestStore(t)
	for _, id := range []string{"a", "b", "c"} {
		if err := s.CreateConnection(sampleConnection(id)); err != nil {
			t.Fatalf("create %s failed: %v", id, err)
		}
	}
	list, err := s.ListConnections()
	if err != nil {
		t.Fatalf("ListConnections failed: %v", err)
	}
	if len(list) != 3 {
		t.Fatalf("expected 3 connections, got %d", len(list))
	}
}

func TestStorePersistenceAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.db")

	s1, err := Open(path, "master")
	if err != nil {
		t.Fatalf("open 1 failed: %v", err)
	}
	if err := s1.CreateConnection(sampleConnection("c1")); err != nil {
		t.Fatalf("create failed: %v", err)
	}
	s1.Close()

	s2, err := Open(path, "master")
	if err != nil {
		t.Fatalf("open 2 failed: %v", err)
	}
	defer s2.Close()
	got, err := s2.GetConnection("c1")
	if err != nil {
		t.Fatalf("get after reopen failed: %v", err)
	}
	if got.Config.SASL.Password != "super-secret" {
		t.Fatalf("password must survive reopen, got %q", got.Config.SASL.Password)
	}
}

func TestStoreReopenWrongMasterPassword(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.db")

	s1, err := Open(path, "right-password")
	if err != nil {
		t.Fatalf("open 1 failed: %v", err)
	}
	if err := s1.CreateConnection(sampleConnection("c1")); err != nil {
		t.Fatalf("create failed: %v", err)
	}
	s1.Close()

	s2, err := Open(path, "wrong-password")
	if err != nil {
		t.Fatalf("open 2 failed: %v", err)
	}
	defer s2.Close()
	if _, err := s2.GetConnection("c1"); err == nil {
		t.Fatal("decrypting config with the wrong master password must fail")
	}
}

func TestStoreGetMissing(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.GetConnection("missing"); err == nil {
		t.Fatal("get missing must fail")
	}
}

func TestStoreListEmptyReturnsSlice(t *testing.T) {
	s := newTestStore(t)
	list, err := s.ListConnections()
	if err != nil {
		t.Fatalf("ListConnections failed: %v", err)
	}
	if list == nil {
		t.Fatal("ListConnections on an empty DB must return a non-nil slice")
	}
	if len(list) != 0 {
		t.Fatalf("expected 0 connections, got %d", len(list))
	}
	b, err := json.Marshal(list)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(b) != "[]" {
		t.Fatalf("empty list must serialize to [] over JSON, got %s", b)
	}
}
