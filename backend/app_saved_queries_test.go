package backend

import (
	"testing"
)

func TestAppSavedQueriesRoundTrip(t *testing.T) {
	app := newTestApp(t)

	saved, err := app.SaveSavedQuery(SaveSavedQueryRequest{
		Name:         "消费延迟",
		ConsoleType:  "kafka-sql",
		ConnectionID: "conn-1",
		Content:      "SELECT * FROM orders",
	})
	if err != nil {
		t.Fatalf("SaveSavedQuery: %v", err)
	}
	if saved.ID == "" || saved.CreatedAt == 0 {
		t.Fatalf("save must return the stored record with id/timestamps: %+v", saved)
	}

	list, err := app.ListSavedQueries(ListSavedQueriesRequest{ConsoleType: "kafka-sql", ConnectionID: "conn-1"})
	if err != nil {
		t.Fatalf("ListSavedQueries: %v", err)
	}
	if len(list) != 1 || list[0].ID != saved.ID || list[0].Name != "消费延迟" {
		t.Fatalf("unexpected list: %+v", list)
	}

	updated, err := app.UpdateSavedQuery(UpdateSavedQueryRequest{ID: saved.ID, Name: "消费延迟-v2", Content: "SELECT 2"})
	if err != nil {
		t.Fatalf("UpdateSavedQuery: %v", err)
	}
	if updated.Name != "消费延迟-v2" || updated.Content != "SELECT 2" {
		t.Fatalf("update not applied: %+v", updated)
	}
	if updated.ConsoleType != "kafka-sql" || updated.ConnectionID != "conn-1" {
		t.Fatalf("update must keep console/connection: %+v", updated)
	}

	// 更新请求只带 id/name/content,数据源与控制台来自存储行,过滤仍可命中。
	list, err = app.ListSavedQueries(ListSavedQueriesRequest{ConsoleType: "kafka-sql", ConnectionID: "conn-1"})
	if err != nil {
		t.Fatalf("ListSavedQueries after update: %v", err)
	}
	if len(list) != 1 || list[0].Name != "消费延迟-v2" {
		t.Fatalf("unexpected list after update: %+v", list)
	}

	if err := app.DeleteSavedQuery(DeleteSavedQueryRequest{ID: saved.ID}); err != nil {
		t.Fatalf("DeleteSavedQuery: %v", err)
	}
	empty, err := app.ListSavedQueries(ListSavedQueriesRequest{})
	if err != nil {
		t.Fatalf("ListSavedQueries after delete: %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("expected no saved queries after delete, got %d", len(empty))
	}
}

func TestAppSaveSavedQueryRejectsBlankField(t *testing.T) {
	app := newTestApp(t)
	_, err := app.SaveSavedQuery(SaveSavedQueryRequest{Name: "x", ConsoleType: "kafka-sql", ConnectionID: "", Content: "SELECT 1"})
	if err == nil {
		t.Fatal("blank connection_id must be rejected")
	}
	if err.Error() != "数据源连接不能为空" {
		t.Fatalf("expected Chinese validation error, got %q", err.Error())
	}
}
