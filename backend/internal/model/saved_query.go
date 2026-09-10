package model

import (
	"errors"
	"strings"
)

// SavedQuery is a persisted SQL console query entry: the user saves a query
// from a console (kafka-sql, ch-sql, …) bound to a data source connection so
// it can be reopened, updated or deleted later.
type SavedQuery struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	ConsoleType  string `json:"console_type"`
	ConnectionID string `json:"connection_id"`
	Content      string `json:"content"`
	CreatedAt    int64  `json:"created_at"`
	UpdatedAt    int64  `json:"updated_at"`
}

// Validate checks that the identifying fields of a saved query are present.
// The messages are user-facing (shown in the console UI), so they are Chinese.
func (q SavedQuery) Validate() error {
	if strings.TrimSpace(q.Name) == "" {
		return errors.New("查询名称不能为空")
	}
	if strings.TrimSpace(q.ConsoleType) == "" {
		return errors.New("控制台类型不能为空")
	}
	if strings.TrimSpace(q.ConnectionID) == "" {
		return errors.New("数据源连接不能为空")
	}
	if strings.TrimSpace(q.Content) == "" {
		return errors.New("查询内容不能为空")
	}
	return nil
}
