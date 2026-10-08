package store

import (
	"database/sql"
	"errors"
	"path/filepath"
	"testing"

	"sheng-shou-yun-he/backend/internal/model"
)

// oldSchema 复刻引入 sort_order 列之前的 connections 建表语句,用于构造
// 存量数据库验证迁移。
const oldSchema = `
CREATE TABLE IF NOT EXISTS connections (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    config_json TEXT NOT NULL,
    created_at  INTEGER,
    updated_at  INTEGER
);
`

// seedLegacyStore 按旧 schema 建库并写入三条 created_at 乱序的连接:
// c2(200)、c3(100)、c1(100)。c1/c3 的 created_at 相同,用于覆盖次级键
// id 的并列排序。
func seedLegacyStore(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open legacy db: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(oldSchema); err != nil {
		t.Fatalf("create legacy schema: %v", err)
	}
	for _, row := range [][3]any{{"c2", "conn-2", int64(200)}, {"c3", "conn-3", int64(100)}, {"c1", "conn-1", int64(100)}} {
		if _, err := db.Exec(
			`INSERT INTO connections (id, name, type, config_json, created_at, updated_at) VALUES (?, ?, 'kafka', '{}', ?, ?)`,
			row[0], row[1], row[2], row[2],
		); err != nil {
			t.Fatalf("seed %v: %v", row[0], err)
		}
	}
	return path
}

// idsOf 提取列表中的连接 id,便于断言整体顺序。
func idsOf(list []*model.Connection) []string {
	out := make([]string, 0, len(list))
	for _, c := range list {
		out = append(out, c.ID)
	}
	return out
}

// TestStoreMigrationBackfillsSortOrder 验证打开旧版数据库时自动补
// sort_order 列,并按 created_at(次级键 id)回填 0..n-1 连续序号,
// 保证升级后列表顺序与升级前一致。
func TestStoreMigrationBackfillsSortOrder(t *testing.T) {
	path := seedLegacyStore(t)
	s, err := Open(path, "master")
	if err != nil {
		t.Fatalf("Open on legacy db: %v", err)
	}
	defer s.Close()

	list, err := s.ListConnections()
	if err != nil {
		t.Fatalf("ListConnections: %v", err)
	}
	if len(list) != 3 {
		t.Fatalf("expected 3 connections, got %d", len(list))
	}
	// 回填按 created_at 升序,id 为次级键:c1(100) < c3(100) < c2(200)。
	// (列表返回顺序由 ListConnections 的 ORDER BY 保证,单独在排序切片验证。)
	wantOrder := map[string]int64{"c1": 0, "c3": 1, "c2": 2}
	for _, c := range list {
		if c.SortOrder != wantOrder[c.ID] {
			t.Fatalf("connection %s: got sort_order %d want %d", c.ID, c.SortOrder, wantOrder[c.ID])
		}
	}
	// GetConnection 也必须带回 sort_order。
	got, err := s.GetConnection("c2")
	if err != nil {
		t.Fatalf("GetConnection: %v", err)
	}
	if got.SortOrder != 2 {
		t.Fatalf("GetConnection sort_order: got %d want 2", got.SortOrder)
	}
}

// TestStoreCreateConnectionAppendsToEnd 验证新建连接的 sort_order 取
// MAX(sort_order)+1(空表为 0),保证新连接始终排在列表末尾;返回的结构体
// 也必须带回该值。
func TestStoreCreateConnectionAppendsToEnd(t *testing.T) {
	s := newTestStore(t)

	c1 := sampleConnection("c1")
	if err := s.CreateConnection(c1); err != nil {
		t.Fatalf("create c1: %v", err)
	}
	if c1.SortOrder != 0 {
		t.Fatalf("first connection sort_order must be 0, got %d", c1.SortOrder)
	}

	c2 := sampleConnection("c2")
	if err := s.CreateConnection(c2); err != nil {
		t.Fatalf("create c2: %v", err)
	}
	if c2.SortOrder != 1 {
		t.Fatalf("second connection sort_order must be 1, got %d", c2.SortOrder)
	}

	// 制造非连续的存量最大值,验证 MAX+1 语义。
	if _, err := s.db.Exec(`UPDATE connections SET sort_order = 7 WHERE id = 'c1'`); err != nil {
		t.Fatalf("seed max sort_order: %v", err)
	}
	c3 := sampleConnection("c3")
	if err := s.CreateConnection(c3); err != nil {
		t.Fatalf("create c3: %v", err)
	}
	if c3.SortOrder != 8 {
		t.Fatalf("new connection must append after max sort_order, got %d want 8", c3.SortOrder)
	}
	got, err := s.GetConnection("c3")
	if err != nil {
		t.Fatalf("GetConnection c3: %v", err)
	}
	if got.SortOrder != 8 {
		t.Fatalf("sort_order not persisted: got %d want 8", got.SortOrder)
	}
}

// TestStoreListOrdersBySortOrder 验证列表按 sort_order 升序返回,而非
// created_at:sort_order 相同的行回退到 created_at 次级排序。
func TestStoreListOrdersBySortOrder(t *testing.T) {
	s := newTestStore(t)
	for _, id := range []string{"c1", "c2", "c3"} {
		if err := s.CreateConnection(sampleConnection(id)); err != nil {
			t.Fatalf("create %s: %v", id, err)
		}
	}
	// 写入与创建顺序不同的自定义顺序:c3(0) < c1(1) < c2(2)。
	if _, err := s.db.Exec(`UPDATE connections SET sort_order = CASE id WHEN 'c3' THEN 0 WHEN 'c1' THEN 1 ELSE 2 END`); err != nil {
		t.Fatalf("seed custom order: %v", err)
	}

	list, err := s.ListConnections()
	if err != nil {
		t.Fatalf("ListConnections: %v", err)
	}
	if got := idsOf(list); got[0] != "c3" || got[1] != "c1" || got[2] != "c2" {
		t.Fatalf("list must follow sort_order, got %v want [c3 c1 c2]", got)
	}
}

// TestStoreReorderConnections 验证按给定 id 顺序整体重写 sort_order,
// 下标即新顺序(0..n-1)。
func TestStoreReorderConnections(t *testing.T) {
	s := newTestStore(t)
	for _, id := range []string{"c1", "c2", "c3"} {
		if err := s.CreateConnection(sampleConnection(id)); err != nil {
			t.Fatalf("create %s: %v", id, err)
		}
	}

	if err := s.ReorderConnections([]string{"c3", "c1", "c2"}); err != nil {
		t.Fatalf("ReorderConnections: %v", err)
	}
	list, err := s.ListConnections()
	if err != nil {
		t.Fatalf("ListConnections: %v", err)
	}
	if got := idsOf(list); got[0] != "c3" || got[1] != "c1" || got[2] != "c2" {
		t.Fatalf("unexpected order after reorder: %v want [c3 c1 c2]", got)
	}
	for i, c := range list {
		if c.SortOrder != int64(i) {
			t.Fatalf("connection %s: sort_order must be compacted to index, got %d want %d", c.ID, c.SortOrder, i)
		}
	}
}

// TestStoreReorderUnknownIDRollsBack 验证传入未知 id 时整体失败并回滚,
// 已写入的顺序不得残留半套。
func TestStoreReorderUnknownIDRollsBack(t *testing.T) {
	s := newTestStore(t)
	for _, id := range []string{"c1", "c2"} {
		if err := s.CreateConnection(sampleConnection(id)); err != nil {
			t.Fatalf("create %s: %v", id, err)
		}
	}

	err := s.ReorderConnections([]string{"c2", "nope"})
	if err == nil {
		t.Fatal("reorder with an unknown id must fail")
	}
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("error must wrap ErrNotFound, got %v", err)
	}
	// 回滚:c1 仍保持原顺序 0。
	list, err := s.ListConnections()
	if err != nil {
		t.Fatalf("ListConnections after rollback: %v", err)
	}
	if got := idsOf(list); got[0] != "c1" || got[1] != "c2" {
		t.Fatalf("order must be unchanged after rollback, got %v", got)
	}
	if list[0].SortOrder != 0 || list[1].SortOrder != 1 {
		t.Fatalf("sort_order must be unchanged after rollback: %+v", list)
	}
}

// TestStoreUpdateConnectionKeepsSortOrder 验证编辑连接(改名/改配置)不得
// 打乱用户已保存的顺序。
func TestStoreUpdateConnectionKeepsSortOrder(t *testing.T) {
	s := newTestStore(t)
	for _, id := range []string{"c1", "c2"} {
		if err := s.CreateConnection(sampleConnection(id)); err != nil {
			t.Fatalf("create %s: %v", id, err)
		}
	}
	if err := s.ReorderConnections([]string{"c2", "c1"}); err != nil {
		t.Fatalf("ReorderConnections: %v", err)
	}

	c1 := sampleConnection("c1")
	c1.Name = "renamed"
	if err := s.UpdateConnection(c1); err != nil {
		t.Fatalf("UpdateConnection: %v", err)
	}

	list, err := s.ListConnections()
	if err != nil {
		t.Fatalf("ListConnections after update: %v", err)
	}
	if got := idsOf(list); got[0] != "c2" || got[1] != "c1" {
		t.Fatalf("update must not touch sort_order, got %v want [c2 c1]", got)
	}
}

// TestStoreMigrationIsIdempotent 验证迁移只发生一次:用户已保存的自定义
// 顺序在重新打开数据库后不得被回填覆盖。
func TestStoreMigrationIsIdempotent(t *testing.T) {
	path := seedLegacyStore(t)
	s, err := Open(path, "master")
	if err != nil {
		t.Fatalf("open 1: %v", err)
	}
	// 直接写入自定义顺序(模拟已持久化的用户排序)。
	if _, err := s.db.Exec(`UPDATE connections SET sort_order = CASE id WHEN 'c2' THEN 0 WHEN 'c1' THEN 1 ELSE 2 END`); err != nil {
		t.Fatalf("seed custom order: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("close 1: %v", err)
	}

	s2, err := Open(path, "master")
	if err != nil {
		t.Fatalf("open 2: %v", err)
	}
	defer s2.Close()
	list, err := s2.ListConnections()
	if err != nil {
		t.Fatalf("ListConnections after reopen: %v", err)
	}
	// 自定义序号不得被二次回填覆盖。
	wantOrder := map[string]int64{"c2": 0, "c1": 1, "c3": 2}
	for _, c := range list {
		if c.SortOrder != wantOrder[c.ID] {
			t.Fatalf("connection %s: custom sort_order must survive reopen, got %d want %d", c.ID, c.SortOrder, wantOrder[c.ID])
		}
	}
}
