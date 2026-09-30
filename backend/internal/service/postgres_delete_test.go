package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"dataBasePro/backend/internal/model"
)

// --- 纯函数:参数化 DELETE 语句构造 ---

func TestPostgresDeleteRowStatementBuilds(t *testing.T) {
	where := []model.PostgresCellValue{
		{Column: "id", Value: strP("7")},
		{Column: "tenant", Value: strP("x")},
	}
	sqlText, args, err := buildPostgresDeleteStatement("app", "public", "users", where, []string{"id", "tenant"})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if sqlText != `DELETE FROM "public"."users" WHERE "id" = $1 AND "tenant" = $2` {
		t.Fatalf("sql = %q", sqlText)
	}
	if len(args) != 2 || mustString(args[0]) != "7" || mustString(args[1]) != "x" {
		t.Fatalf("args = %#v", args)
	}
	if _, _, err := buildPostgresDeleteStatement("app", "public", "users", nil, []string{"id"}); err == nil {
		t.Fatal("empty where must fail")
	}
	if _, _, err := buildPostgresDeleteStatement("app", "public", "users", []model.PostgresCellValue{{Column: "name", Value: strP("x")}}, []string{"id"}); err == nil {
		t.Fatal("non-primary-key where must fail")
	}
}

// TestPostgresDeleteRowJSONContract 锁定按行删除的 wire 契约:字段全部
// snake_case,与前端 api/types.ts 严格一致。
func TestPostgresDeleteRowJSONContract(t *testing.T) {
	b, err := json.Marshal(PostgresDeleteRowRequest{
		ConnectionID: "c", Database: "d", Schema: "public", Relation: "users",
		RelationKind: model.PostgresRelationKindTable,
		Where:        []model.PostgresCellValue{{Column: "id", Value: strP("1")}},
	})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	for _, key := range []string{`"connection_id"`, `"database"`, `"schema"`, `"relation"`, `"relation_kind"`, `"where"`, `"column"`, `"value"`} {
		if !strings.Contains(string(b), key) {
			t.Fatalf("PostgresDeleteRowRequest JSON must expose %s, got %s", key, b)
		}
	}
	b, err = json.Marshal(PostgresDeleteRowPreview{Statement: "DELETE", MatchedRows: 1})
	if err != nil {
		t.Fatalf("marshal preview: %v", err)
	}
	for _, key := range []string{`"statement"`, `"matched_rows"`} {
		if !strings.Contains(string(b), key) {
			t.Fatalf("PostgresDeleteRowPreview JSON must expose %s, got %s", key, b)
		}
	}
}

// --- 客户端:视图/物化视图在任何拨号前拒绝,文案区分删除语境 ---

func TestPostgresDeleteRowRejectsNonTable(t *testing.T) {
	client := &PostgresClient{}
	req := PostgresDeleteRowRequest{
		Schema: "public", Relation: "users",
		RelationKind: model.PostgresRelationKindView,
		Where:        []model.PostgresCellValue{{Column: "id", Value: strP("1")}},
	}
	if _, err := client.PreviewDeleteRow(context.Background(), req); err == nil || !strings.Contains(err.Error(), "仅实体表支持删除行") {
		t.Fatalf("view preview must be rejected before dialing, got %v", err)
	}
	req.RelationKind = model.PostgresRelationKindMaterializedView
	if err := client.DeleteRow(context.Background(), req); err == nil || !strings.Contains(err.Error(), "仅实体表支持删除行") {
		t.Fatalf("materialized view delete must be rejected before dialing, got %v", err)
	}
	req.RelationKind = ""
	if err := client.DeleteRow(context.Background(), req); err == nil || !strings.Contains(err.Error(), "不支持的 relation_kind") {
		t.Fatalf("empty relation_kind must be rejected, got %v", err)
	}
}

// --- Service 层委托(获取方式与 PostgresPreviewCellUpdate 相同) ---

// deleteRecordingPostgres 在既有 fakePostgres 上补按行删除能力(方法可在同
// 包任意文件定义),记录委托参数并回放预设结果。
type deleteRecordingPostgres struct {
	*fakePostgres
	deleteReq *PostgresDeleteRowRequest
	deleteOut PostgresDeleteRowPreview
	deleteErr error
}

func (f *deleteRecordingPostgres) PreviewDeleteRow(_ context.Context, req PostgresDeleteRowRequest) (PostgresDeleteRowPreview, error) {
	f.deleteReq = &req
	return f.deleteOut, f.deleteErr
}

func (f *deleteRecordingPostgres) DeleteRow(_ context.Context, req PostgresDeleteRowRequest) error {
	f.deleteReq = &req
	return f.deleteErr
}

func newTestServiceWithPostgresDS(t *testing.T, ds PostgresDataSource) (*Service, string) {
	t.Helper()
	svc, _ := newTestService(t)
	ctx := context.Background()
	c, err := svc.CreateConnection(ctx, &model.Connection{
		Name: "pg-local",
		Type: model.ConnectionTypePostgres,
		Config: model.MustConfigJSON(model.PostgresConfig{
			Host: "127.0.0.1", Database: "app", Username: "u",
		}),
	})
	if err != nil {
		t.Fatalf("create postgres connection: %v", err)
	}
	if err := svc.PutPooledForTest(c.ID, ds); err != nil {
		t.Fatalf("pool fake: %v", err)
	}
	return svc, c.ID
}

func TestPostgresDeleteRowServiceDelegates(t *testing.T) {
	fake := &deleteRecordingPostgres{fakePostgres: &fakePostgres{}}
	svc, id := newTestServiceWithPostgresDS(t, fake)
	ctx := context.Background()
	req := PostgresDeleteRowRequest{
		ConnectionID: id, Database: "app", Schema: "public", Relation: "users",
		RelationKind: model.PostgresRelationKindTable,
		Where:        []model.PostgresCellValue{{Column: "id", Value: strP("1")}},
	}

	fake.deleteOut = PostgresDeleteRowPreview{Statement: `DELETE FROM "public"."users" WHERE "id" = $1`, MatchedRows: 1}
	preview, err := svc.PostgresPreviewDeleteRow(ctx, req)
	if err != nil {
		t.Fatalf("PostgresPreviewDeleteRow: %v", err)
	}
	if preview.Statement != fake.deleteOut.Statement || preview.MatchedRows != 1 {
		t.Fatalf("unexpected preview: %+v", preview)
	}
	if fake.deleteReq.Schema != "public" || fake.deleteReq.Relation != "users" || len(fake.deleteReq.Where) != 1 {
		t.Fatalf("preview args must pass through: %+v", *fake.deleteReq)
	}

	if err := svc.PostgresDeleteRow(ctx, req); err != nil {
		t.Fatalf("PostgresDeleteRow: %v", err)
	}
	if fake.deleteReq.RelationKind != model.PostgresRelationKindTable {
		t.Fatalf("delete args must pass through: %+v", *fake.deleteReq)
	}

	fake.deleteErr = errors.New("boom")
	if err := svc.PostgresDeleteRow(ctx, req); err == nil {
		t.Fatal("delete failure must surface")
	}
}

// legacyPG 模拟旧池化客户端:方法集只有 PostgresDataSource,没有按行删除
// 能力 —— 必须得到明确错误而非 panic。
type legacyPG struct{ PostgresDataSource }

func TestPostgresDeleteRowRejectsLegacyClient(t *testing.T) {
	svc, id := newTestServiceWithPostgresDS(t, &legacyPG{&fakePostgres{}})
	ctx := context.Background()
	req := PostgresDeleteRowRequest{
		ConnectionID: id, Database: "app", Schema: "public", Relation: "users",
		RelationKind: model.PostgresRelationKindTable,
		Where:        []model.PostgresCellValue{{Column: "id", Value: strP("1")}},
	}
	if _, err := svc.PostgresPreviewDeleteRow(ctx, req); err == nil || !strings.Contains(err.Error(), "不支持按行删除") {
		t.Fatalf("legacy client must be rejected on preview, got %v", err)
	}
	if err := svc.PostgresDeleteRow(ctx, req); err == nil || !strings.Contains(err.Error(), "不支持按行删除") {
		t.Fatalf("legacy client must be rejected on delete, got %v", err)
	}
}
