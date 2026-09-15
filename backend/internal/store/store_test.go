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
		Config: model.MustConfigJSON(model.KafkaConfig{
			BootstrapServers: []string{"localhost:9092"},
			SASL: &model.SASLConfig{
				Enabled:   true,
				Mechanism: model.SaslPlain,
				Username:  "user",
				Password:  "super-secret",
			},
		}),
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
	gotCfg, err := got.KafkaConfig()
	if err != nil {
		t.Fatalf("decode config: %v", err)
	}
	if gotCfg.SASL.Password != "super-secret" {
		t.Fatalf("password not round-tripped: %q", gotCfg.SASL.Password)
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

func TestStoreClickHouseCreateAndGet(t *testing.T) {
	s := newTestStore(t)
	c := &model.Connection{
		ID:   "ch1",
		Name: "ch-dev",
		Type: model.ConnectionTypeClickHouse,
		Config: model.MustConfigJSON(model.ClickHouseConfig{
			Hosts:    []string{"10.0.0.1:8123"},
			Username: "ops",
			Password: "ch-secret",
			Database: "logs",
			TLS:      true,
			Protocol: "http",
		}),
	}
	if err := s.CreateConnection(c); err != nil {
		t.Fatalf("CreateConnection failed: %v", err)
	}
	// 原始落盘 JSON:不得含明文密码,且必须带加密前缀。
	var raw string
	if err := s.db.QueryRow(`SELECT config_json FROM connections WHERE id = ?`, "ch1").Scan(&raw); err != nil {
		t.Fatalf("query raw config failed: %v", err)
	}
	if strings.Contains(raw, "ch-secret") {
		t.Fatal("plaintext clickhouse password must not appear in stored config_json")
	}
	if !strings.Contains(raw, "enc:v1:") {
		t.Fatal("stored clickhouse config_json must contain an encrypted password field")
	}
	// 回读:tls 必须保持 bool(true),密码解密还原。
	got, err := s.GetConnection("ch1")
	if err != nil {
		t.Fatalf("GetConnection failed: %v", err)
	}
	gotCfg, err := got.ClickHouseConfig()
	if err != nil {
		t.Fatalf("decode clickhouse config: %v", err)
	}
	if !gotCfg.TLS {
		t.Fatal("clickhouse tls bool must round-trip as true")
	}
	if gotCfg.Password != "ch-secret" {
		t.Fatalf("clickhouse password not round-tripped: %q", gotCfg.Password)
	}
	if gotCfg.Protocol != "http" {
		t.Fatalf("clickhouse protocol not round-tripped: %q", gotCfg.Protocol)
	}
	if gotCfg.Username != "ops" || gotCfg.Database != "logs" {
		t.Fatalf("unexpected decoded config: %+v", gotCfg)
	}
}

// MySQL/TiDB 与 ClickHouse 同样必须按类型编解码:config 不得被默认的
// kafka 分支重写,密码加密落盘、回读解密,host/port/tls_mode 保真。
// 回归背景:缺分支时 config 被写成 {"bootstrap_servers":null},连接
// 保存成功但打开报「mysql host 不能为空」。
func TestStoreMysqlCreateAndGet(t *testing.T) {
	s := newTestStore(t)
	c := &model.Connection{
		ID:   "my1",
		Name: "mysql-dev",
		Type: model.ConnectionTypeMySQL,
		Config: model.MustConfigJSON(model.MysqlConfig{
			Host:     "10.0.0.8",
			Port:     3307,
			Username: "app",
			Password: "mysql-secret",
			Database: "orders",
			TLSMode:  model.MysqlTLSSkipVerify,
		}),
	}
	if err := s.CreateConnection(c); err != nil {
		t.Fatalf("CreateConnection failed: %v", err)
	}
	// 原始落盘 JSON:不得含明文密码,且必须带加密前缀。
	var raw string
	if err := s.db.QueryRow(`SELECT config_json FROM connections WHERE id = ?`, "my1").Scan(&raw); err != nil {
		t.Fatalf("query raw config failed: %v", err)
	}
	if strings.Contains(raw, "mysql-secret") {
		t.Fatal("plaintext mysql password must not appear in stored config_json")
	}
	if !strings.Contains(raw, "enc:v1:") {
		t.Fatal("stored mysql config_json must contain an encrypted password field")
	}
	if strings.Contains(raw, "bootstrap_servers") {
		t.Fatal("mysql config must not be rewritten into the kafka shape")
	}
	// 回读:类型相关字段全部保真,密码解密还原。
	got, err := s.GetConnection("my1")
	if err != nil {
		t.Fatalf("GetConnection failed: %v", err)
	}
	gotCfg, err := got.MysqlConfig()
	if err != nil {
		t.Fatalf("decode mysql config: %v", err)
	}
	if gotCfg.Host != "10.0.0.8" || gotCfg.Port != 3307 || gotCfg.TLSMode != model.MysqlTLSSkipVerify {
		t.Fatalf("mysql config fields not round-tripped: %+v", gotCfg)
	}
	if gotCfg.Username != "app" || gotCfg.Database != "orders" {
		t.Fatalf("unexpected decoded config: %+v", gotCfg)
	}
	if gotCfg.Password != "mysql-secret" {
		t.Fatalf("mysql password not round-tripped: %q", gotCfg.Password)
	}
}

// TiDB 与 MySQL 共用 MysqlConfig 编解码,同样不得落 kafka 分支。
func TestStoreTiDBCreateAndGet(t *testing.T) {
	s := newTestStore(t)
	c := &model.Connection{
		ID:   "tb1",
		Name: "tidb-dev",
		Type: model.ConnectionTypeTiDB,
		Config: model.MustConfigJSON(model.MysqlConfig{
			Host:     "tidb.internal",
			Port:     4000,
			Username: "root",
			Password: "tidb-secret",
			TLSMode:  model.MysqlTLSVerifyFull,
		}),
	}
	if err := s.CreateConnection(c); err != nil {
		t.Fatalf("CreateConnection failed: %v", err)
	}
	got, err := s.GetConnection("tb1")
	if err != nil {
		t.Fatalf("GetConnection failed: %v", err)
	}
	gotCfg, err := got.MysqlConfig()
	if err != nil {
		t.Fatalf("decode tidb config: %v", err)
	}
	if gotCfg.Host != "tidb.internal" || gotCfg.Port != 4000 || gotCfg.Password != "tidb-secret" {
		t.Fatalf("tidb config not round-tripped: %+v", gotCfg)
	}
}

func TestStoreUpdate(t *testing.T) {
	s := newTestStore(t)
	c := sampleConnection("c1")
	if err := s.CreateConnection(c); err != nil {
		t.Fatalf("create failed: %v", err)
	}
	c.Name = "renamed"
	c.Config = model.MustConfigJSON(model.KafkaConfig{BootstrapServers: []string{"broker-a:9092", "broker-b:9092"}})
	if err := s.UpdateConnection(c); err != nil {
		t.Fatalf("update failed: %v", err)
	}
	got, _ := s.GetConnection("c1")
	gotCfg, err := got.KafkaConfig()
	if err != nil {
		t.Fatalf("decode config: %v", err)
	}
	if got.Name != "renamed" || len(gotCfg.BootstrapServers) != 2 {
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
	cfg, err := c.KafkaConfig()
	if err != nil {
		t.Fatalf("decode config: %v", err)
	}
	cfg.SASL.Password = "rotated-secret"
	c.Config = model.MustConfigJSON(cfg)
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
	gotCfg, err := got.KafkaConfig()
	if err != nil {
		t.Fatalf("decode config: %v", err)
	}
	if gotCfg.SASL.Password != "rotated-secret" {
		t.Fatalf("updated password not round-tripped: %q", gotCfg.SASL.Password)
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
	gotCfg, err := got.KafkaConfig()
	if err != nil {
		t.Fatalf("decode config: %v", err)
	}
	if gotCfg.SASL.Password != "super-secret" {
		t.Fatalf("password must survive reopen, got %q", gotCfg.SASL.Password)
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

// ES 连接必须按类型编解码:config 不得被默认的 kafka 分支重写成
// {"bootstrap_servers":null};password 与 api_key 两个凭据都要加密落盘、
// 回读解密,其余字段保真。
func TestStoreESCreateAndGet(t *testing.T) {
	s := newTestStore(t)
	c := &model.Connection{
		ID:   "es1",
		Name: "es-dev",
		Type: model.ConnectionTypeES,
		Config: model.MustConfigJSON(model.EsConfig{
			Hosts:    []string{"10.0.0.2:9200"},
			Username: "elastic",
			Password: "es-secret",
			ApiKey:   "es-key-material",
			AuthMode: model.EsAuthBasic,
			TLSMode:  model.EsTLSSkipVerify,
		}),
	}
	if err := s.CreateConnection(c); err != nil {
		t.Fatalf("CreateConnection failed: %v", err)
	}
	// 原始落盘 JSON:不得含明文凭据,且必须带加密前缀。
	var raw string
	if err := s.db.QueryRow(`SELECT config_json FROM connections WHERE id = ?`, "es1").Scan(&raw); err != nil {
		t.Fatalf("query raw config failed: %v", err)
	}
	if strings.Contains(raw, "es-secret") || strings.Contains(raw, "es-key-material") {
		t.Fatalf("plaintext es credentials must not appear in stored config_json: %s", raw)
	}
	if !strings.Contains(raw, "enc:v1:") {
		t.Fatal("stored es config_json must contain encrypted credential fields")
	}
	// 回读:凭据解密还原,其余字段保真。
	got, err := s.GetConnection("es1")
	if err != nil {
		t.Fatalf("GetConnection failed: %v", err)
	}
	gotCfg, err := got.EsConfig()
	if err != nil {
		t.Fatalf("decode es config: %v", err)
	}
	if gotCfg.Password != "es-secret" {
		t.Fatalf("es password not round-tripped: %q", gotCfg.Password)
	}
	if gotCfg.ApiKey != "es-key-material" {
		t.Fatalf("es api_key not round-tripped: %q", gotCfg.ApiKey)
	}
	if gotCfg.Username != "elastic" || gotCfg.AuthMode != model.EsAuthBasic || gotCfg.TLSMode != model.EsTLSSkipVerify {
		t.Fatalf("unexpected decoded config: %+v", gotCfg)
	}
	if len(gotCfg.Hosts) != 1 || gotCfg.Hosts[0] != "10.0.0.2:9200" {
		t.Fatalf("es hosts must round-trip, got %+v", gotCfg.Hosts)
	}
}
