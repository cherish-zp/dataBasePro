package store

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// writeQueryFileRaw 直接落盘一个查询文件(绕过 store.Write),便于构造
// 旧格式(无头注释)文件与控制修改时间。
func writeQueryFileRaw(t *testing.T, dir, name, content string, modTime time.Time) {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write raw query file %s: %v", name, err)
	}
	if err := os.Chtimes(path, modTime, modTime); err != nil {
		t.Fatalf("chtimes %s: %v", name, err)
	}
}

func TestQueryFileListEmptyDirReturnsEmptySlice(t *testing.T) {
	s := NewQueryFileStore(t.TempDir())
	list, err := s.List()
	if err != nil {
		t.Fatalf("List on empty dir: %v", err)
	}
	if list == nil || len(list) != 0 {
		t.Fatalf("empty dir must yield a non-nil empty slice, got %+v", list)
	}
}

func TestQueryFileListMissingDirReturnsEmptySlice(t *testing.T) {
	s := NewQueryFileStore(filepath.Join(t.TempDir(), "not-created-yet"))
	list, err := s.List()
	if err != nil {
		t.Fatalf("List on missing dir must not fail: %v", err)
	}
	if list == nil || len(list) != 0 {
		t.Fatalf("missing dir must yield a non-nil empty slice, got %+v", list)
	}
}

func TestQueryFileListOrdersByModTimeDescAndParsesHeader(t *testing.T) {
	dir := t.TempDir()
	base := time.Now()
	// 旧格式文件(无头注释)也要能列出,connectionID 为空。
	writeQueryFileRaw(t, dir, "最早.sql", "SELECT 1;\n", base.Add(-2*time.Hour))
	writeQueryFileRaw(t, dir, "居中.sql", "-- connection: conn-2\nSELECT 2;\n", base.Add(-1*time.Hour))
	writeQueryFileRaw(t, dir, "最新.sql", "-- connection: conn-3\nSELECT 3;\n", base)

	s := NewQueryFileStore(dir)
	list, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 3 {
		t.Fatalf("expected 3 query files, got %d: %+v", len(list), list)
	}
	if list[0].Name != "最新" || list[1].Name != "居中" || list[2].Name != "最早" {
		t.Fatalf("expected newest-first order, got %v", []string{list[0].Name, list[1].Name, list[2].Name})
	}
	if list[0].ConnectionID != "conn-3" {
		t.Fatalf("newest file must carry its header connection id, got %q", list[0].ConnectionID)
	}
	if list[1].ConnectionID != "conn-2" {
		t.Fatalf("middle file must carry its header connection id, got %q", list[1].ConnectionID)
	}
	if list[2].ConnectionID != "" {
		t.Fatalf("legacy file without header must have an empty connection id, got %q", list[2].ConnectionID)
	}
	if list[0].ModTimeMs < list[1].ModTimeMs || list[1].ModTimeMs < list[2].ModTimeMs {
		t.Fatalf("mod_time_ms must be descending: %+v", list)
	}
	if list[0].SizeBytes != int64(len("-- connection: conn-3\nSELECT 3;\n")) {
		t.Fatalf("unexpected size_bytes: %+v", list[0])
	}
}

func TestQueryFileListIgnoresNonSQLAndSubdirsAndTempFiles(t *testing.T) {
	dir := t.TempDir()
	base := time.Now()
	writeQueryFileRaw(t, dir, "keep.sql", "SELECT 1;\n", base)
	writeQueryFileRaw(t, dir, "notes.txt", "hello", base)         // 非 .sql
	writeQueryFileRaw(t, dir, ".hidden.sql", "SELECT 2;\n", base) // 隐藏临时文件
	writeQueryFileRaw(t, dir, "draft.sql.tmp", "x", base)         // 编辑器临时文件
	if err := os.Mkdir(filepath.Join(dir, "sub.sql"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	list, err := NewQueryFileStore(dir).List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 || list[0].Name != "keep" {
		t.Fatalf("only keep.sql must be listed, got %+v", list)
	}
}

func TestQueryFileReadRoundTripsHeaderAndBody(t *testing.T) {
	dir := t.TempDir()
	s := NewQueryFileStore(dir)
	header := "-- connection: conn-9\n"
	body := "SELECT count(*) FROM events;\n"
	if err := s.Write("消费统计.sql", body, "conn-9"); err != nil {
		t.Fatalf("Write: %v", err)
	}
	content, connectionID, err := s.Read("消费统计.sql")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if content != header+body {
		t.Fatalf("Read must return the full original text, got %q", content)
	}
	if connectionID != "conn-9" {
		t.Fatalf("connection id = %q, want conn-9", connectionID)
	}
}

func TestQueryFileReadLegacyFileWithoutHeader(t *testing.T) {
	dir := t.TempDir()
	raw := "SELECT 1;\n-- connection: 不在头部,不算数\n"
	writeQueryFileRaw(t, dir, "legacy.sql", raw, time.Now())

	content, connectionID, err := NewQueryFileStore(dir).Read("legacy.sql")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if content != raw {
		t.Fatalf("legacy content must be returned verbatim, got %q", content)
	}
	if connectionID != "" {
		t.Fatalf("legacy file must have an empty connection id, got %q", connectionID)
	}
}

func TestQueryFileReadMissing(t *testing.T) {
	s := NewQueryFileStore(t.TempDir())
	_, _, err := s.Read("missing.sql")
	if err == nil {
		t.Fatal("reading a missing query file must fail")
	}
	if !strings.Contains(err.Error(), "查询文件不存在") || !strings.Contains(err.Error(), "missing.sql") {
		t.Fatalf("expected Chinese not-found error naming the file, got %q", err.Error())
	}
}

func TestQueryFileWriteCreatesDirAndPersistsHeader(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "queries")
	s := NewQueryFileStore(dir)
	if err := s.Write("订单查询.sql", "SELECT * FROM orders;\n", "conn-1"); err != nil {
		t.Fatalf("Write: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "订单查询.sql"))
	if err != nil {
		t.Fatalf("read written file: %v", err)
	}
	if string(raw) != "-- connection: conn-1\nSELECT * FROM orders;\n" {
		t.Fatalf("file must start with the header comment line, got %q", string(raw))
	}
	info, err := os.Stat(filepath.Join(dir, "订单查询.sql"))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("query files must be written 0600, got %v", info.Mode().Perm())
	}
}

func TestQueryFileWriteWithoutConnectionKeepsContentVerbatim(t *testing.T) {
	dir := t.TempDir()
	s := NewQueryFileStore(dir)
	if err := s.Write("plain.sql", "SELECT 2;\n", ""); err != nil {
		t.Fatalf("Write: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "plain.sql"))
	if err != nil {
		t.Fatalf("read written file: %v", err)
	}
	if string(raw) != "SELECT 2;\n" {
		t.Fatalf("no-header write must store the content verbatim, got %q", string(raw))
	}
}

func TestQueryFileWriteOverwritesSameName(t *testing.T) {
	dir := t.TempDir()
	s := NewQueryFileStore(dir)
	if err := s.Write("同名.sql", "SELECT 1;\n", "conn-1"); err != nil {
		t.Fatalf("first write: %v", err)
	}
	if err := s.Write("同名.sql", "SELECT 22;\n", "conn-2"); err != nil {
		t.Fatalf("second write must overwrite: %v", err)
	}
	list, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("overwrite must not create extra files, got %+v", list)
	}
	content, connectionID, err := s.Read("同名.sql")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if content != "-- connection: conn-2\nSELECT 22;\n" || connectionID != "conn-2" {
		t.Fatalf("overwrite not applied: %q / %q", content, connectionID)
	}
}

func TestQueryFileWriteRejectsIllegalNames(t *testing.T) {
	s := NewQueryFileStore(t.TempDir())
	for _, name := range []string{"../x.sql", "a/b.sql", `a\b.sql`, "noext", "x.txt"} {
		if err := s.Write(name, "SELECT 1", "conn-1"); err == nil {
			t.Fatalf("illegal name %q must be rejected", name)
		}
	}
	entries, err := os.ReadDir(s.Dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("rejected writes must not leave files, got %v", entries)
	}
}

func TestQueryFileDelete(t *testing.T) {
	dir := t.TempDir()
	s := NewQueryFileStore(dir)
	if err := s.Write("待删.sql", "SELECT 1;\n", "conn-1"); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := s.Delete("待删.sql"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, _, err := s.Read("待删.sql"); err == nil {
		t.Fatal("file must be gone after delete")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("delete must remove the file, dir still has %v", entries)
	}
}

func TestQueryFileDeleteMissing(t *testing.T) {
	s := NewQueryFileStore(t.TempDir())
	err := s.Delete("nope.sql")
	if err == nil {
		t.Fatal("deleting a missing query file must fail")
	}
	if !strings.Contains(err.Error(), "查询文件不存在") {
		t.Fatalf("expected Chinese not-found error, got %q", err.Error())
	}
}

func TestValidateQueryFileName(t *testing.T) {
	cases := []struct {
		name    string
		wantErr bool
		wantMsg string // 断言错误文案包含的关键字;为空则只断言通过
	}{
		{name: "a.sql"},
		{name: "UPPER.SQL"},
		{name: "查询-1.Sql"},
		{name: "2026 订单大盘.sql"},
		{name: "", wantErr: true, wantMsg: "不能为空"},
		{name: "../x.sql", wantErr: true, wantMsg: "非法"},
		{name: "a/b.sql", wantErr: true, wantMsg: "非法"},
		{name: `a\b.sql`, wantErr: true, wantMsg: "非法"},
		{name: "..", wantErr: true, wantMsg: "非法"},
		{name: "noext", wantErr: true, wantMsg: ".sql"},
		{name: "x.txt", wantErr: true, wantMsg: ".sql"},
	}
	for _, tc := range cases {
		err := ValidateQueryFileName(tc.name)
		if !tc.wantErr {
			if err != nil {
				t.Errorf("ValidateQueryFileName(%q) = %v, want nil", tc.name, err)
			}
			continue
		}
		if err == nil {
			t.Errorf("ValidateQueryFileName(%q) = nil, want error", tc.name)
			continue
		}
		if tc.wantMsg != "" && !strings.Contains(err.Error(), tc.wantMsg) {
			t.Errorf("ValidateQueryFileName(%q) error %q must contain %q", tc.name, err.Error(), tc.wantMsg)
		}
	}
}

func TestParseQueryFileHeader(t *testing.T) {
	cases := []struct {
		label    string
		content  string
		wantID   string
		wantBody string
	}{
		{"带头注释", "-- connection: conn-1\nSELECT 1;", "conn-1", "SELECT 1;"},
		{"头注释后空行", "-- connection: conn-1\n\nSELECT 1;", "conn-1", "\nSELECT 1;"},
		{"无头注释", "SELECT 1;", "", "SELECT 1;"},
		{"空内容", "", "", ""},
		{
			"connectionID 含空格",
			"-- connection: my conn-1 \nSELECT 1;",
			"my conn-1",
			"SELECT 1;",
		},
		{
			"注释块中混有多行注释",
			"-- tool: dbclient\n-- connection: conn-2\n-- note: 日常巡检\nSELECT 2;",
			"conn-2",
			"SELECT 2;",
		},
		{
			"connection 行出现在正文不算头注释",
			"SELECT 1;\n-- connection: conn-3\n",
			"",
			"SELECT 1;\n-- connection: conn-3\n",
		},
		{"仅头注释无正文", "-- connection: conn-4\n", "conn-4", ""},
	}
	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			id, body := ParseQueryFileHeader(tc.content)
			if id != tc.wantID || body != tc.wantBody {
				t.Fatalf("ParseQueryFileHeader(%q) = (%q, %q), want (%q, %q)",
					tc.content, id, body, tc.wantID, tc.wantBody)
			}
		})
	}
}
