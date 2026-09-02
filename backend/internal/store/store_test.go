package store

import (
	"encoding/json"
	"fmt"
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

func TestStoreUpdateRefreshesUpdatedAtAndKeepsCreatedAt(t *testing.T) {
	s := newTestStore(t)
	c := sampleConnection("c1")
	if err := s.CreateConnection(c); err != nil {
		t.Fatalf("create failed: %v", err)
	}
	createdAt, updatedAt := c.CreatedAt, c.UpdatedAt
	c.Name = "renamed"
	if err := s.UpdateConnection(c); err != nil {
		t.Fatalf("update failed: %v", err)
	}
	if c.CreatedAt != createdAt {
		t.Fatalf("created_at must not change on update: got %d want %d", c.CreatedAt, createdAt)
	}
	if c.UpdatedAt <= updatedAt {
		t.Fatalf("updated_at must be refreshed on update: got %d <= %d", c.UpdatedAt, updatedAt)
	}
	got, err := s.GetConnection("c1")
	if err != nil {
		t.Fatalf("get after update failed: %v", err)
	}
	if got.CreatedAt != createdAt || got.UpdatedAt != c.UpdatedAt {
		t.Fatalf("timestamps not persisted: created %d/%d updated %d/%d", got.CreatedAt, createdAt, got.UpdatedAt, c.UpdatedAt)
	}
}

func TestStoreUpdateReencryptsPassword(t *testing.T) {
	s := newTestStore(t)
	c := sampleConnection("c1")
	if err := s.CreateConnection(c); err != nil {
		t.Fatalf("create failed: %v", err)
	}
	c.Config.SASL.Password = "rotated-secret"
	if err := s.UpdateConnection(c); err != nil {
		t.Fatalf("update failed: %v", err)
	}
	var raw string
	if err := s.db.QueryRow(`SELECT config_json FROM connections WHERE id = ?`, "c1").Scan(&raw); err != nil {
		t.Fatalf("query raw config failed: %v", err)
	}
	if strings.Contains(raw, "rotated-secret") {
		t.Fatal("plaintext password must not appear in stored config_json after update")
	}
	if !strings.Contains(raw, "enc:v1:") {
		t.Fatal("stored config_json must contain an encrypted password field after update")
	}
	got, err := s.GetConnection("c1")
	if err != nil {
		t.Fatalf("get after update failed: %v", err)
	}
	if got.Config.SASL.Password != "rotated-secret" {
		t.Fatalf("updated password not round-tripped: %q", got.Config.SASL.Password)
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

func sampleAudit(action, target string) *model.AuditEntry {
	return &model.AuditEntry{
		ConnectionID: "c1",
		Action:       action,
		Target:       target,
		Result:       "ok",
	}
}

func auditTargets(list []*model.AuditEntry) []string {
	out := make([]string, 0, len(list))
	for _, e := range list {
		out = append(out, e.Target)
	}
	return out
}

func TestStoreAuditRoundTripNewestFirst(t *testing.T) {
	s := newTestStore(t)
	for i := 0; i < 3; i++ {
		e := sampleAudit("create_topic", fmt.Sprintf("t%d", i))
		e.Timestamp = int64(1000 + i)
		if err := s.RecordAudit(e); err != nil {
			t.Fatalf("RecordAudit #%d: %v", i, err)
		}
	}
	list, err := s.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if len(list) != 3 {
		t.Fatalf("expected 3 audit entries, got %d", len(list))
	}
	if got := auditTargets(list); got[0] != "t2" || got[1] != "t1" || got[2] != "t0" {
		t.Fatalf("audit must list newest first, got %v", got)
	}
	if list[0].ID <= list[1].ID || list[1].ID <= list[2].ID {
		t.Fatalf("audit ids must be descending, got %+v", list)
	}
}

func TestStoreAuditAutoTimestamp(t *testing.T) {
	s := newTestStore(t)
	if err := s.RecordAudit(sampleAudit("create_topic", "t1")); err != nil {
		t.Fatalf("RecordAudit: %v", err)
	}
	list, err := s.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 audit entry, got %d", len(list))
	}
	e := list[0]
	if e.Timestamp == 0 {
		t.Fatal("zero timestamp must be auto-filled to unix ms")
	}
	if e.Action != "create_topic" || e.Result != "ok" || e.ConnectionID != "c1" {
		t.Fatalf("fields not round-tripped: %+v", e)
	}
}

func TestStoreAuditLimit(t *testing.T) {
	s := newTestStore(t)
	for i := 0; i < 10; i++ {
		if err := s.RecordAudit(&model.AuditEntry{Action: "a", Target: fmt.Sprintf("t%d", i), Result: "ok"}); err != nil {
			t.Fatalf("RecordAudit #%d: %v", i, err)
		}
	}
	list, err := s.ListAudit(3)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if len(list) != 3 || list[0].Target != "t9" {
		t.Fatalf("limit not applied: %d entries, newest %q", len(list), list[0].Target)
	}
	// A non-positive limit falls back to the store default cap.
	def, err := s.ListAudit(0)
	if err != nil {
		t.Fatalf("ListAudit(0): %v", err)
	}
	if len(def) != 10 {
		t.Fatalf("ListAudit(0) should fall back to the default, got %d", len(def))
	}
}

func TestStoreAuditPersistenceAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.db")

	s1, err := Open(path, "master")
	if err != nil {
		t.Fatalf("open 1 failed: %v", err)
	}
	if err := s1.RecordAudit(sampleAudit("delete_topic", "gone")); err != nil {
		t.Fatalf("record failed: %v", err)
	}
	s1.Close()

	s2, err := Open(path, "master")
	if err != nil {
		t.Fatalf("open 2 failed: %v", err)
	}
	defer s2.Close()
	list, err := s2.ListAudit(10)
	if err != nil {
		t.Fatalf("list after reopen failed: %v", err)
	}
	if len(list) != 1 || list[0].Action != "delete_topic" || list[0].Target != "gone" {
		t.Fatalf("audit must survive reopen: %+v", list)
	}
}

func TestStoreAuditEmptyReturnsSlice(t *testing.T) {
	s := newTestStore(t)
	list, err := s.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list == nil {
		t.Fatal("ListAudit on an empty table must return a non-nil slice")
	}
	if len(list) != 0 {
		t.Fatalf("expected 0 audit entries, got %d", len(list))
	}
	b, err := json.Marshal(list)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(b) != "[]" {
		t.Fatalf("empty audit list must serialize to [] over JSON, got %s", b)
	}
}
