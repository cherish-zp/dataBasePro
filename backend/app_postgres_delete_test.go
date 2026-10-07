package backend

import (
	"context"
	"errors"
	"strings"
	"testing"

	"sheng-shou-yun-he/backend/internal/model"
	"sheng-shou-yun-he/backend/internal/service"
)

// deleteRecordingPostgresApp 在既有 fakePostgresApp 上补按行删除能力,记录
// 委托参数并回放预设结果(方法可在同包任意文件定义,不改既有测试脚手架)。
type deleteRecordingPostgresApp struct {
	*fakePostgresApp
	deleteReq *service.PostgresDeleteRowRequest
	deleteOut service.PostgresDeleteRowPreview
	deleteErr error
}

func (f *deleteRecordingPostgresApp) PreviewDeleteRow(_ context.Context, req service.PostgresDeleteRowRequest) (service.PostgresDeleteRowPreview, error) {
	f.deleteReq = &req
	return f.deleteOut, f.deleteErr
}

func (f *deleteRecordingPostgresApp) DeleteRow(_ context.Context, req service.PostgresDeleteRowRequest) error {
	f.deleteReq = &req
	return f.deleteErr
}

// newPostgresDeleteApp 注册 postgres 连接并把带删除能力的 fake 入池。
func newPostgresDeleteApp(t *testing.T, fake *deleteRecordingPostgresApp) (*App, string) {
	t.Helper()
	app := newTestApp(t)
	conn, err := app.CreateConnection(&model.Connection{
		Name: "pg-local",
		Type: model.ConnectionTypePostgres,
		Config: model.MustConfigJSON(model.PostgresConfig{
			Host: "127.0.0.1", Port: 5432, Username: "u", Password: "secret", Database: "app",
		}),
	})
	if err != nil {
		t.Fatalf("create postgres connection: %v", err)
	}
	if err := app.svc.PutPooledForTest(conn.ID, fake); err != nil {
		t.Fatalf("pool fake: %v", err)
	}
	return app, conn.ID
}

// TestPostgresDeleteRowAppPreviewNotAudited 预览只读:透传请求、不落审计。
func TestPostgresDeleteRowAppPreviewNotAudited(t *testing.T) {
	fake := &deleteRecordingPostgresApp{fakePostgresApp: &fakePostgresApp{}}
	app, connID := newPostgresDeleteApp(t, fake)

	preview, err := app.PostgresPreviewDeleteRow(service.PostgresDeleteRowRequest{
		ConnectionID: connID, Database: "app", Schema: "public", Relation: "users",
		RelationKind: model.PostgresRelationKindTable,
		Where:        []model.PostgresCellValue{{Column: "id", Value: strPointer("1")}},
	})
	if err != nil {
		t.Fatalf("PostgresPreviewDeleteRow: %v", err)
	}
	if preview.MatchedRows != 0 {
		t.Fatalf("unexpected preview: %+v", preview)
	}
	if fake.deleteReq.Schema != "public" || fake.deleteReq.Relation != "users" {
		t.Fatalf("preview args must pass through: %+v", *fake.deleteReq)
	}
	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	for _, e := range list {
		if strings.Contains(e.Action, "delete") {
			t.Fatalf("read-only preview must not be audited, got %+v", list)
		}
	}
}

// TestPostgresDeleteRowAppAudited 执行走审计:成功 ok,失败 error + 详情,
// 与 truncate/update_cell 同风格(action postgres_delete_row,target 为
// db.schema.relation;详情只含错误文本,不含定位值与语句文本)。
func TestPostgresDeleteRowAppAudited(t *testing.T) {
	fake := &deleteRecordingPostgresApp{fakePostgresApp: &fakePostgresApp{}}
	app, connID := newPostgresDeleteApp(t, fake)

	req := service.PostgresDeleteRowRequest{
		ConnectionID: connID, Database: "app", Schema: "public", Relation: "users",
		RelationKind: model.PostgresRelationKindTable,
		Where:        []model.PostgresCellValue{{Column: "id", Value: strPointer("row-42")}},
	}
	if err := app.PostgresDeleteRow(req); err != nil {
		t.Fatalf("PostgresDeleteRow: %v", err)
	}
	if fake.deleteReq.RelationKind != model.PostgresRelationKindTable || len(fake.deleteReq.Where) != 1 {
		t.Fatalf("delete args must pass through: %+v", *fake.deleteReq)
	}
	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "postgres_delete_row" || list[0].Target != "app.public.users" ||
		list[0].Result != "ok" || list[0].ConnectionID != connID {
		t.Fatalf("unexpected audit: %+v", list[0])
	}

	// 失败也要落审计(错误详情透出),且详情不携带定位值。
	failApp, failID := newPostgresDeleteApp(t, &deleteRecordingPostgresApp{
		fakePostgresApp: &fakePostgresApp{},
		deleteErr:       errors.New("boom"),
	})
	req.ConnectionID = failID
	if err := failApp.PostgresDeleteRow(req); err == nil {
		t.Fatal("delete failure must surface")
	}
	list, err = failApp.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "postgres_delete_row" || list[0].Result != "error" || list[0].Detail == "" {
		t.Fatalf("failed delete must be audited: %+v", list[0])
	}
	if strings.Contains(list[0].Detail, "row-42") || strings.Contains(list[0].Detail, "DELETE") {
		t.Fatalf("audit detail must not carry where values or statement text: %+v", list[0])
	}
}
