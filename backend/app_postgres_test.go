package backend

import (
	"context"
	"errors"
	"strings"
	"testing"

	"dataBasePro/backend/internal/model"
	"dataBasePro/backend/internal/service"
)

type fakePostgresApp struct {
	dbs        []string
	schemas    []string
	tables     []model.PostgresTableInfo
	page       model.PostgresPageRowsResult
	pageTarget string
	truncated  string
	execTarget string
	execResult []model.PostgresStatementResult
	execErr    error
	updateErr  error
	previewReq *model.PostgresCellUpdateRequest
	updateReq  *model.PostgresCellUpdateRequest
}

func (f *fakePostgresApp) Connect(context.Context) error { return nil }
func (f *fakePostgresApp) Close() error                  { return nil }
func (f *fakePostgresApp) GetName() string               { return "fake-pg" }
func (f *fakePostgresApp) GetType() string               { return string(model.ConnectionTypePostgres) }
func (f *fakePostgresApp) Databases(context.Context) ([]string, error) {
	return f.dbs, nil
}
func (f *fakePostgresApp) Schemas(_ context.Context, database string) ([]string, error) {
	f.pageTarget = "schemas:" + database
	return f.schemas, nil
}
func (f *fakePostgresApp) Tables(_ context.Context, database, schema string) ([]model.PostgresTableInfo, error) {
	f.pageTarget = "tables:" + database + "." + schema
	return f.tables, nil
}
func (f *fakePostgresApp) PageRows(_ context.Context, database, schema, relation, kind, where, orderBy string, _ bool, _, _ int) (model.PostgresPageRowsResult, error) {
	f.pageTarget = strings.Join([]string{database, schema, relation, kind, where, orderBy}, "|")
	return f.page, nil
}
func (f *fakePostgresApp) Execute(_ context.Context, database, schema, sqlText string) ([]model.PostgresStatementResult, error) {
	f.execTarget = database + "|" + schema + "|" + sqlText
	return f.execResult, f.execErr
}
func (f *fakePostgresApp) TruncateTable(_ context.Context, database, schema, relation, kind string) error {
	f.truncated = strings.Join([]string{database, schema, relation, kind}, "|")
	return nil
}
func (f *fakePostgresApp) PreviewCellUpdate(_ context.Context, req model.PostgresCellUpdateRequest) (model.PostgresCellUpdatePreview, error) {
	f.previewReq = &req
	return model.PostgresCellUpdatePreview{Statement: "UPDATE ...", MatchedRows: 2}, nil
}
func (f *fakePostgresApp) UpdateCell(_ context.Context, req model.PostgresCellUpdateRequest) error {
	f.updateReq = &req
	return f.updateErr
}

func strPointer(value string) *string { return &value }

var _ service.PostgresDataSource = (*fakePostgresApp)(nil)

func newPostgresApp(t *testing.T, fake *fakePostgresApp) (*App, string) {
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

func TestAppPostgresReadAPIs(t *testing.T) {
	page := model.PostgresPageRowsResult{
		Columns:    []model.PostgresColumn{{Name: "id", IsInPrimaryKey: true}},
		Rows:       [][]*string{{strPointer("1"), nil}},
		PrimaryKey: []string{"id"},
		TotalRows:  1,
	}
	fake := &fakePostgresApp{
		dbs: []string{"app"}, schemas: []string{"public"},
		tables: []model.PostgresTableInfo{{Relation: "users", Schema: "public", RelationType: string(model.PostgresRelationKindTable), RawRelationType: "r", RelationKind: model.PostgresRelationKindTable}},
		page:   page,
	}
	app, id := newPostgresApp(t, fake)
	ctxDbs, err := app.ListPostgresDatabases(id)
	if err != nil || len(ctxDbs) != 1 || ctxDbs[0] != "app" {
		t.Fatalf("databases: %v %+v", err, ctxDbs)
	}
	schemas, err := app.ListPostgresSchemas(PostgresSchemasRequest{ConnectionID: id, Database: "analytics"})
	if err != nil || len(schemas) != 1 {
		t.Fatalf("schemas: %v %+v", err, schemas)
	}
	if fake.pageTarget != "schemas:analytics" {
		t.Fatalf("schema target = %q", fake.pageTarget)
	}
	tables, err := app.ListPostgresTables(PostgresTablesRequest{ConnectionID: id, Database: "app", Schema: "public"})
	if err != nil || len(tables) != 1 || tables[0].Relation != "users" || tables[0].Schema != "public" || tables[0].RelationType != "table" || tables[0].RawRelationType != "r" {
		t.Fatalf("tables: %v %+v", err, tables)
	}
	gotPage, err := app.PostgresPageRows(PostgresPageRowsRequest{
		ConnectionID: id, Database: "app", Schema: "public", Relation: "users",
		RelationKind: "table", Where: "id > 0", OrderBy: "id", Asc: true, Limit: 10, Offset: 20,
	})
	if err != nil || gotPage.TotalRows != 1 {
		t.Fatalf("page: %v %+v", err, gotPage)
	}
	if fake.pageTarget != "app|public|users|table|id > 0|id" {
		t.Fatalf("page target = %q", fake.pageTarget)
	}
}

func TestAppPostgresWriteAPIsAudit(t *testing.T) {
	fake := &fakePostgresApp{execResult: []model.PostgresStatementResult{{Statement: "INSERT 1", HasRows: false, AffectedRows: 1}}}
	app, id := newPostgresApp(t, fake)
	if err := app.PostgresTruncateTable(PostgresTruncateTableRequest{
		ConnectionID: id, Database: "app", Schema: "public", Relation: "users", RelationKind: "table",
	}); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	if fake.truncated != "app|public|users|table" {
		t.Fatalf("truncate target = %q", fake.truncated)
	}
	results, err := app.PostgresExecute(PostgresExecuteRequest{ConnectionID: id, Database: "app", Schema: "public", SQL: "INSERT 1"})
	if err != nil || len(results) != 1 || results[0].HasRows || results[0].Statement != "INSERT 1" || results[0].AffectedRows != 1 {
		t.Fatalf("execute: %v %+v", err, results)
	}
	req := model.PostgresCellUpdateRequest{ConnectionID: id, Database: "app", Schema: "public", Relation: "users", RelationKind: model.PostgresRelationKindTable}
	preview, err := app.PostgresPreviewCellUpdate(req)
	if err != nil || preview.MatchedRows != 2 || fake.previewReq == nil {
		t.Fatalf("preview: %v %+v", err, preview)
	}
	if err := app.PostgresUpdateCell(req); err != nil || fake.updateReq == nil {
		t.Fatalf("update: %v", err)
	}
	entries, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("list audit: %v", err)
	}
	actions := map[string]int{}
	for _, entry := range entries {
		actions[entry.Action]++
	}
	for _, action := range []string{"postgres_truncate_table", "postgres_execute", "postgres_update_cell"} {
		if actions[action] == 0 {
			t.Fatalf("missing audit action %s: %+v", action, entries)
		}
	}
}

func TestAppPostgresUpdateErrorAudits(t *testing.T) {
	fake := &fakePostgresApp{updateErr: errors.New("boom")}
	app, id := newPostgresApp(t, fake)
	err := app.PostgresUpdateCell(model.PostgresCellUpdateRequest{ConnectionID: id, Database: "app", Schema: "public", Relation: "users"})
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("expected update error, got %v", err)
	}
	entries, err := app.ListAudit(10)
	if err != nil || len(entries) == 0 || entries[0].Action != "postgres_update_cell" || entries[0].Result != "error" {
		t.Fatalf("audit entries: %v %+v", err, entries)
	}
}

func TestAppListDriversIncludesPostgreSQL(t *testing.T) {
	app := newTestApp(t)
	drivers, err := app.ListDrivers()
	if err != nil {
		t.Fatalf("ListDrivers: %v", err)
	}
	var found bool
	for _, d := range drivers {
		if d.Name == "PostgreSQL" {
			found = true
			if d.Library != "pgx" || d.Version != "v5.11.0" || d.DefaultPort != 5432 || d.Description == "" {
				t.Fatalf("unexpected PostgreSQL driver: %+v", d)
			}
		}
	}
	if !found {
		t.Fatalf("PostgreSQL missing: %+v", drivers)
	}
}
