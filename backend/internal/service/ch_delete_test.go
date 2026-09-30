package service

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"dataBasePro/backend/internal/model"
)

// --- 纯函数:DELETE mutation 语句构造 ---

func TestCHDeleteRowStatementBuilds(t *testing.T) {
	// 数值列不引号、字符串列单引号转义、多条件 AND 连接。
	stmt, err := buildCHDeleteStatement("logs", "events", []model.CHCellValue{
		{Column: "id", Type: "UInt64", Value: strP("7")},
		{Column: "note", Type: "String", Value: strP("it's")},
	})
	if err != nil {
		t.Fatalf("buildCHDeleteStatement: %v", err)
	}
	want := "ALTER TABLE `logs`.`events` DELETE WHERE `id` = 7 AND `note` = 'it\\'s' SETTINGS mutations_sync = 1"
	if stmt != want {
		t.Fatalf("statement = %q, want %q", stmt, want)
	}

	// Nullable 列 nil 值渲染为 IS NULL。
	stmt, err = buildCHDeleteStatement("logs", "events", []model.CHCellValue{
		{Column: "note", Type: "Nullable(String)"},
	})
	if err != nil {
		t.Fatalf("nullable nil: %v", err)
	}
	if !strings.Contains(stmt, "`note` IS NULL") {
		t.Fatalf("nil nullable must render IS NULL, got %s", stmt)
	}

	// 非空表名、非空条件、类型合法性:逐一拒绝。
	if _, err := buildCHDeleteStatement("logs", " ", []model.CHCellValue{{Column: "id", Type: "UInt64", Value: strP("1")}}); err == nil {
		t.Fatal("empty table must fail")
	}
	if _, err := buildCHDeleteStatement("logs", "events", nil); err == nil || !strings.Contains(err.Error(), "DELETE") {
		t.Fatalf("empty where must fail in delete wording, got %v", err)
	}
	if _, err := buildCHDeleteStatement("logs", "events", []model.CHCellValue{{Column: "cnt", Type: "UInt64", Value: strP("abc")}}); err == nil {
		t.Fatal("non-numeric text for numeric type must fail")
	}
	if _, err := buildCHDeleteStatement("logs", "events", []model.CHCellValue{{Column: "cnt", Type: "UInt64"}}); err == nil {
		t.Fatal("nil value on non-Nullable type must fail")
	}
}

// TestCHDeleteRowJSONContract 锁定按行删除的 wire 契约:字段全部 snake_case,
// 与前端 api/types.ts 严格一致(nil value 显式为 null)。
func TestCHDeleteRowJSONContract(t *testing.T) {
	b, err := json.Marshal(CHDeleteRowRequest{
		ConnectionID: "c", Database: "d", Table: "t",
		Where: []model.CHCellValue{{Column: "id", Type: "UInt64", Value: strP("1")}},
	})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	for _, key := range []string{`"connection_id"`, `"database"`, `"table"`, `"where"`, `"column"`, `"type"`, `"value"`} {
		if !strings.Contains(string(b), key) {
			t.Fatalf("CHDeleteRowRequest JSON must expose %s, got %s", key, b)
		}
	}
	b, err = json.Marshal(CHDeleteRowPreview{Statement: "ALTER", MatchedRows: 3})
	if err != nil {
		t.Fatalf("marshal preview: %v", err)
	}
	for _, key := range []string{`"statement"`, `"matched_rows"`} {
		if !strings.Contains(string(b), key) {
			t.Fatalf("CHDeleteRowPreview JSON must expose %s, got %s", key, b)
		}
	}
}

// --- 客户端:httptest 离线验证(http 驱动) ---

func TestCHDeleteRowPreviewReadOnly(t *testing.T) {
	var countSQL string
	var alterSeen bool
	cl := newCHHTTPClient(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		sqlText := string(body)
		if strings.Contains(sqlText, "SELECT 1") {
			io.WriteString(w, "1")
			return
		}
		if strings.Contains(sqlText, "ALTER TABLE") {
			alterSeen = true
			io.WriteString(w, "")
			return
		}
		if strings.Contains(sqlText, "SELECT count()") {
			countSQL = sqlText
			io.WriteString(w, `["count()"]
["UInt64"]
[3]`)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		io.WriteString(w, "unexpected query: "+sqlText)
	})
	where := []model.CHCellValue{{Column: "id", Type: "UInt64", Value: strP("7")}}
	preview, err := cl.PreviewDeleteRow(context.Background(), "logs", "events", where)
	if err != nil {
		t.Fatalf("PreviewDeleteRow: %v", err)
	}
	want := "ALTER TABLE `logs`.`events` DELETE WHERE `id` = 7 SETTINGS mutations_sync = 1"
	if preview.Statement != want {
		t.Fatalf("statement = %q, want %q", preview.Statement, want)
	}
	if preview.MatchedRows != 3 {
		t.Fatalf("matched_rows = %d, want 3", preview.MatchedRows)
	}
	if !strings.Contains(countSQL, "SELECT count() FROM `logs`.`events` WHERE `id` = 7") {
		t.Fatalf("count sql must reuse the same WHERE, got %q", countSQL)
	}
	if alterSeen {
		t.Fatal("preview must not execute the mutation")
	}
}

func TestCHDeleteRowExecutesMutation(t *testing.T) {
	var execSQL string
	cl := newCHHTTPClient(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		sqlText := string(body)
		if strings.Contains(sqlText, "ALTER TABLE") {
			execSQL = sqlText
			io.WriteString(w, "")
			return
		}
		io.WriteString(w, "1")
	})
	where := []model.CHCellValue{
		{Column: "id", Type: "UInt64", Value: strP("7")},
		{Column: "day", Type: "Date", Value: strP("2026-09-10")},
	}
	if err := cl.DeleteRow(context.Background(), "logs", "events", where); err != nil {
		t.Fatalf("DeleteRow: %v", err)
	}
	want := "ALTER TABLE `logs`.`events` DELETE WHERE `id` = 7 AND `day` = '2026-09-10' SETTINGS mutations_sync = 1"
	if execSQL != want {
		t.Fatalf("exec sql = %q, want %q", execSQL, want)
	}
}

// 空库名必须落到连接配置的默认库。
func TestCHDeleteRowUsesConfiguredDefaultDatabase(t *testing.T) {
	var execSQL string
	cl := newCHHTTPClient(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		sqlText := string(body)
		if strings.Contains(sqlText, "ALTER TABLE") {
			execSQL = sqlText
			io.WriteString(w, "")
			return
		}
		io.WriteString(w, "1")
	})
	// newCHHTTPClient 的配置默认库为 "default"。
	if err := cl.DeleteRow(context.Background(), "", "events", []model.CHCellValue{
		{Column: "id", Type: "UInt64", Value: strP("1")},
	}); err != nil {
		t.Fatalf("DeleteRow: %v", err)
	}
	if !strings.Contains(execSQL, "ALTER TABLE `default`.`events` DELETE") {
		t.Fatalf("empty database must resolve to the configured default, got %q", execSQL)
	}
}

// --- Service 层委托(复用 s.ch;危险操作的审计由 app 层落) ---

// deleteRecordingCH 在既有 fakeCH 上补按行删除能力,记录委托参数并回放
// 预设结果(方法可在同包任意文件定义)。
type deleteRecordingCH struct {
	*fakeCH
	deleteDB    string
	deleteTable string
	deleteWhere []model.CHCellValue
	deleteOut   CHDeleteRowPreview
	deleteErr   error
}

func (f *deleteRecordingCH) PreviewDeleteRow(_ context.Context, database, table string, where []model.CHCellValue) (CHDeleteRowPreview, error) {
	f.deleteDB, f.deleteTable, f.deleteWhere = database, table, where
	return f.deleteOut, f.deleteErr
}

func (f *deleteRecordingCH) DeleteRow(_ context.Context, database, table string, where []model.CHCellValue) error {
	f.deleteDB, f.deleteTable, f.deleteWhere = database, table, where
	return f.deleteErr
}

func TestCHDeleteRowServiceDelegates(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()
	c, err := svc.CreateConnection(ctx, &model.Connection{
		Name:   "ch-local",
		Type:   model.ConnectionTypeClickHouse,
		Config: model.MustConfigJSON(model.ClickHouseConfig{Hosts: []string{"127.0.0.1:9000"}}),
	})
	if err != nil {
		t.Fatalf("create clickhouse connection: %v", err)
	}
	fake := &deleteRecordingCH{fakeCH: &fakeCH{}}
	if err := svc.PutPooledForTest(c.ID, fake); err != nil {
		t.Fatalf("pool fake: %v", err)
	}
	id := c.ID
	where := []model.CHCellValue{{Column: "id", Type: "UInt64", Value: strP("1")}}

	fake.deleteOut = CHDeleteRowPreview{Statement: "ALTER TABLE `logs`.`events` DELETE WHERE `id` = 1 SETTINGS mutations_sync = 1", MatchedRows: 1}
	preview, err := svc.CHPreviewDeleteRow(ctx, id, "logs", "events", where)
	if err != nil {
		t.Fatalf("CHPreviewDeleteRow: %v", err)
	}
	if preview.Statement != fake.deleteOut.Statement || preview.MatchedRows != 1 {
		t.Fatalf("unexpected preview: %+v", preview)
	}
	if fake.deleteDB != "logs" || fake.deleteTable != "events" || len(fake.deleteWhere) != 1 {
		t.Fatalf("preview args must pass through: %s %s %+v", fake.deleteDB, fake.deleteTable, fake.deleteWhere)
	}

	if err := svc.CHDeleteRow(ctx, id, "logs", "events", where); err != nil {
		t.Fatalf("CHDeleteRow: %v", err)
	}
	if fake.deleteTable != "events" {
		t.Fatalf("delete args must pass through: %s %s", fake.deleteDB, fake.deleteTable)
	}

	fake.deleteErr = errors.New("boom")
	if err := svc.CHDeleteRow(ctx, id, "logs", "events", where); err == nil {
		t.Fatal("delete failure must surface")
	}
}

// 复用 ch_test.go 的 legacyCH(只有 ClickHouseDataSource 方法集):按行删除
// 必须得到明确错误而非 panic。
func TestCHDeleteRowRejectsLegacyClient(t *testing.T) {
	svc, id := newTestServiceWithCH(t, &fakeCH{})
	if err := svc.pool.Put(id, &legacyCH{&fakeCH{}}); err != nil {
		t.Fatalf("pool put: %v", err)
	}
	ctx := context.Background()
	where := []model.CHCellValue{{Column: "id", Type: "UInt64", Value: strP("1")}}
	if _, err := svc.CHPreviewDeleteRow(ctx, id, "logs", "events", where); err == nil || !strings.Contains(err.Error(), "不支持按行删除") {
		t.Fatalf("legacy client must be rejected on preview, got %v", err)
	}
	if err := svc.CHDeleteRow(ctx, id, "logs", "events", where); err == nil || !strings.Contains(err.Error(), "不支持按行删除") {
		t.Fatalf("legacy client must be rejected on delete, got %v", err)
	}
}
