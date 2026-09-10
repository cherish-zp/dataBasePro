package model

import "testing"

func TestSavedQueryValidate_Valid(t *testing.T) {
	q := SavedQuery{
		Name:         "日报查询",
		ConsoleType:  "kafka-sql",
		ConnectionID: "conn-1",
		Content:      "SELECT * FROM topic",
	}
	if err := q.Validate(); err != nil {
		t.Fatalf("expected valid saved query, got error: %v", err)
	}
}

func TestSavedQueryValidate_BlankFields(t *testing.T) {
	base := SavedQuery{
		Name:         "日报查询",
		ConsoleType:  "kafka-sql",
		ConnectionID: "conn-1",
		Content:      "SELECT 1",
	}
	cases := []struct {
		field  string
		mutate func(*SavedQuery)
		want   string
	}{
		{"name", func(q *SavedQuery) { q.Name = "  " }, "查询名称不能为空"},
		{"console_type", func(q *SavedQuery) { q.ConsoleType = "" }, "控制台类型不能为空"},
		{"connection_id", func(q *SavedQuery) { q.ConnectionID = " " }, "数据源连接不能为空"},
		{"content", func(q *SavedQuery) { q.Content = "" }, "查询内容不能为空"},
	}
	for _, tc := range cases {
		t.Run(tc.field, func(t *testing.T) {
			q := base
			tc.mutate(&q)
			err := q.Validate()
			if err == nil {
				t.Fatalf("expected error for empty %s, got nil", tc.field)
			}
			if err.Error() != tc.want {
				t.Fatalf("expected Chinese error %q, got %q", tc.want, err.Error())
			}
		})
	}
}
