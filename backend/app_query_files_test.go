package backend

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dataBasePro/backend/internal/store"
)

// TestAppQueryFileRoundTrip 走通「写入 → 列表 → 读取 → 删除」:前端传目录与
// 不带扩展名的展示名,后端负责展开 `~` 并补齐 .sql 扩展名。
func TestAppQueryFileRoundTrip(t *testing.T) {
	app := newTestApp(t)
	dir := t.TempDir()

	if err := app.WriteQueryFile(QueryFileWriteRequest{
		Dir:          dir,
		Name:         "每日消费延迟",
		Content:      "SELECT * FROM orders;\n",
		ConnectionID: "conn-1",
	}); err != nil {
		t.Fatalf("WriteQueryFile: %v", err)
	}

	list, err := app.ListQueryFiles(QueryFileListRequest{Dir: dir})
	if err != nil {
		t.Fatalf("ListQueryFiles: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 query file, got %+v", list)
	}
	if list[0].Name != "每日消费延迟" {
		t.Fatalf("list name must exclude the .sql extension, got %q", list[0].Name)
	}
	if list[0].ConnectionID != "conn-1" {
		t.Fatalf("list must expose the header connection id, got %q", list[0].ConnectionID)
	}

	// 读取时带不带 .sql 扩展名都必须命中同一文件。
	got, err := app.ReadQueryFile(QueryFileReadRequest{Dir: dir, Name: "每日消费延迟"})
	if err != nil {
		t.Fatalf("ReadQueryFile: %v", err)
	}
	if got.ConnectionID != "conn-1" {
		t.Fatalf("read connection_id = %q, want conn-1", got.ConnectionID)
	}
	if got.Content != "-- connection: conn-1\nSELECT * FROM orders;\n" {
		t.Fatalf("read must return the full original text, got %q", got.Content)
	}
	if _, err := app.ReadQueryFile(QueryFileReadRequest{Dir: dir, Name: "每日消费延迟.sql"}); err != nil {
		t.Fatalf("ReadQueryFile with explicit extension: %v", err)
	}

	if err := app.DeleteQueryFile(QueryFileDeleteRequest{Dir: dir, Name: "每日消费延迟"}); err != nil {
		t.Fatalf("DeleteQueryFile: %v", err)
	}
	empty, err := app.ListQueryFiles(QueryFileListRequest{Dir: dir})
	if err != nil {
		t.Fatalf("ListQueryFiles after delete: %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("expected no query files after delete, got %+v", empty)
	}
}

// TestAppQueryFileRejectsIllegalName 经由绑定验证非法文件名必须报中文错误。
func TestAppQueryFileRejectsIllegalName(t *testing.T) {
	app := newTestApp(t)
	dir := t.TempDir()

	for _, name := range []string{"../escape", "sub/dir"} {
		err := app.WriteQueryFile(QueryFileWriteRequest{Dir: dir, Name: name, Content: "SELECT 1"})
		if err == nil {
			t.Fatalf("illegal name %q must be rejected", name)
		}
		if !strings.Contains(err.Error(), "非法") {
			t.Fatalf("expected 非法 in error for %q, got %q", name, err.Error())
		}
	}
	if _, err := app.ReadQueryFile(QueryFileReadRequest{Dir: dir, Name: "../escape"}); err == nil {
		t.Fatal("reading an illegal name must be rejected")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("rejected requests must not leave files, got %v", entries)
	}
}

// TestExpandQueryDir 验证 `~` 前缀展开与路径清洗(os.UserHomeDir 无法注入,
// 直接与同一环境下的展开结果比对)。
func TestExpandQueryDir(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("os.UserHomeDir unavailable: %v", err)
	}
	if got := expandQueryDir("~/查询仓库"); got != filepath.Join(home, "查询仓库") {
		t.Fatalf("expandQueryDir(~/查询仓库) = %q, want %q", got, filepath.Join(home, "查询仓库"))
	}
	if got := expandQueryDir("~"); got != home {
		t.Fatalf("expandQueryDir(~) = %q, want %q", got, home)
	}
	if got := expandQueryDir("/tmp/queries//sub/"); got != filepath.Clean("/tmp/queries/sub") {
		t.Fatalf("expandQueryDir must clean the path, got %q", got)
	}
	// 无 `~` 前缀时原样(仅清洗),不能把中间的 ~ 当作家目录。
	if got := expandQueryDir("/data/~user/仓库"); got != filepath.Clean("/data/~user/仓库") {
		t.Fatalf("expandQueryDir must not expand embedded ~, got %q", got)
	}
}

// TestQueryFileWireShape 锁定前后端 JSON 契约:请求与列表条目均为 snake_case。
func TestQueryFileWireShape(t *testing.T) {
	req := QueryFileWriteRequest{Dir: "~/q", Name: "a.sql", Content: "SELECT 1", ConnectionID: "c1"}
	raw, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"dir", "name", "content", "connection_id"} {
		if _, ok := m[key]; !ok {
			t.Fatalf("QueryFileWriteRequest JSON must expose key %q, got %s", key, raw)
		}
	}

	info := store.QueryFileInfo{Name: "a", ConnectionID: "c1", SizeBytes: 7, ModTimeMs: 42}
	raw, err = json.Marshal(info)
	if err != nil {
		t.Fatalf("marshal info: %v", err)
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal info: %v", err)
	}
	for _, key := range []string{"name", "connection_id", "size_bytes", "mod_time_ms"} {
		if _, ok := m[key]; !ok {
			t.Fatalf("QueryFileInfo JSON must expose key %q, got %s", key, raw)
		}
	}

	content := QueryFileContent{Content: "SELECT 1", ConnectionID: "c1"}
	raw, err = json.Marshal(content)
	if err != nil {
		t.Fatalf("marshal content: %v", err)
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal content: %v", err)
	}
	for _, key := range []string{"content", "connection_id"} {
		if _, ok := m[key]; !ok {
			t.Fatalf("QueryFileContent JSON must expose key %q, got %s", key, raw)
		}
	}
}
