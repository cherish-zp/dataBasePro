package service

import (
	"context"
	"errors"
	"testing"

	"dataBasePro/backend/internal/model"
	"dataBasePro/backend/internal/store"
)

func sampleServiceSavedQuery() *model.SavedQuery {
	return &model.SavedQuery{
		Name:         "消费延迟查询",
		ConsoleType:  "kafka-sql",
		ConnectionID: "conn-1",
		Content:      "SELECT * FROM orders",
	}
}

func TestServiceCreateSavedQueryValidates(t *testing.T) {
	svc, _ := newTestService(t)
	q := sampleServiceSavedQuery()
	q.Name = " "
	if _, err := svc.CreateSavedQuery(context.Background(), q); err == nil {
		t.Fatal("blank name must be rejected")
	} else if err.Error() != "查询名称不能为空" {
		t.Fatalf("expected Chinese validation error, got %q", err.Error())
	}
	list, err := svc.ListSavedQueries(context.Background(), "", "")
	if err != nil {
		t.Fatalf("ListSavedQueries failed: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("failed create must not persist, got %d rows", len(list))
	}
}

func TestServiceSavedQueryRoundTrip(t *testing.T) {
	ctx := context.Background()
	svc, _ := newTestService(t)

	created, err := svc.CreateSavedQuery(ctx, sampleServiceSavedQuery())
	if err != nil {
		t.Fatalf("CreateSavedQuery: %v", err)
	}
	if created.ID == "" || created.CreatedAt == 0 {
		t.Fatalf("store must assign id/timestamps: %+v", created)
	}

	updated, err := svc.UpdateSavedQuery(ctx, &model.SavedQuery{ID: created.ID, Name: "改名", Content: "SELECT 2"})
	if err != nil {
		t.Fatalf("UpdateSavedQuery: %v", err)
	}
	if updated.Name != "改名" || updated.Content != "SELECT 2" {
		t.Fatalf("update not applied: %+v", updated)
	}
	if updated.ConsoleType != "kafka-sql" || updated.ConnectionID != "conn-1" {
		t.Fatalf("update must preserve scope from the stored row: %+v", updated)
	}
	if updated.CreatedAt != created.CreatedAt || updated.UpdatedAt < created.UpdatedAt {
		t.Fatalf("unexpected timestamps after update: %+v", updated)
	}

	list, err := svc.ListSavedQueries(ctx, "kafka-sql", "conn-1")
	if err != nil {
		t.Fatalf("ListSavedQueries: %v", err)
	}
	if len(list) != 1 || list[0].ID != created.ID || list[0].Name != "改名" {
		t.Fatalf("unexpected list result: %+v", list)
	}

	if err := svc.DeleteSavedQuery(ctx, created.ID); err != nil {
		t.Fatalf("DeleteSavedQuery: %v", err)
	}
	empty, err := svc.ListSavedQueries(ctx, "", "")
	if err != nil {
		t.Fatalf("ListSavedQueries after delete: %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("expected empty list after delete, got %d rows", len(empty))
	}
}

func TestServiceUpdateSavedQueryMissing(t *testing.T) {
	svc, _ := newTestService(t)
	_, err := svc.UpdateSavedQuery(context.Background(), &model.SavedQuery{ID: "nope", Name: "缺失", Content: "SELECT 1"})
	if !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("updating a missing saved query must surface ErrNotFound, got %v", err)
	}
}

func TestServiceDeleteSavedQueryMissing(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.DeleteSavedQuery(context.Background(), "nope"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleting a missing saved query must surface ErrNotFound, got %v", err)
	}
}
