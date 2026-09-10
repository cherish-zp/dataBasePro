package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"dataBasePro/backend/internal/model"
)

// CreateSavedQuery inserts a new saved SQL console query. The id and both
// timestamps are generated here. The name must be unique within the
// (console_type, connection_id) scope; duplicates yield a Chinese error that
// is surfaced to the console UI verbatim.
func (s *Store) CreateSavedQuery(q *model.SavedQuery) error {
	if q == nil {
		return errors.New("saved query must not be nil")
	}
	dup, err := s.savedQueryNameTaken(q.ConsoleType, q.ConnectionID, q.Name, "")
	if err != nil {
		return err
	}
	if dup {
		return fmt.Errorf("同名查询已存在: %s", q.Name)
	}
	now := time.Now().UnixMilli()
	q.ID = uuid.NewString()
	q.CreatedAt = now
	q.UpdatedAt = now
	_, err = s.db.Exec(
		`INSERT INTO saved_queries (id, name, console_type, connection_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		q.ID, q.Name, q.ConsoleType, q.ConnectionID, q.Content, q.CreatedAt, q.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert saved query: %w", err)
	}
	return nil
}

// UpdateSavedQuery overwrites the name and content of an existing saved query
// and refreshes updated_at. The (console_type, connection_id) scope and
// created_at belong to the stored row and stay untouched. The rename is
// checked against sibling queries excluding itself; unknown ids return
// ErrNotFound.
func (s *Store) UpdateSavedQuery(q *model.SavedQuery) error {
	if q == nil {
		return errors.New("saved query must not be nil")
	}
	if q.ID == "" {
		return errors.New("saved query id must not be empty")
	}
	dup, err := s.savedQueryNameTaken(q.ConsoleType, q.ConnectionID, q.Name, q.ID)
	if err != nil {
		return err
	}
	if dup {
		return fmt.Errorf("同名查询已存在: %s", q.Name)
	}
	q.UpdatedAt = time.Now().UnixMilli()
	res, err := s.db.Exec(
		`UPDATE saved_queries SET name = ?, content = ?, updated_at = ? WHERE id = ?`,
		q.Name, q.Content, q.UpdatedAt, q.ID,
	)
	if err != nil {
		return fmt.Errorf("update saved query: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteSavedQuery removes a saved query; unknown ids return ErrNotFound.
func (s *Store) DeleteSavedQuery(id string) error {
	res, err := s.db.Exec(`DELETE FROM saved_queries WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete saved query: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// GetSavedQuery loads a single saved query by id.
func (s *Store) GetSavedQuery(id string) (*model.SavedQuery, error) {
	row := s.db.QueryRow(
		`SELECT id, name, console_type, connection_id, content, created_at, updated_at FROM saved_queries WHERE id = ?`, id,
	)
	return scanSavedQuery(row)
}

// ListSavedQueries returns saved queries newest-updated first. Both filters
// are optional: an empty consoleType or connectionID means "no filter".
func (s *Store) ListSavedQueries(consoleType, connectionID string) ([]*model.SavedQuery, error) {
	query := `SELECT id, name, console_type, connection_id, content, created_at, updated_at FROM saved_queries`
	var conds []string
	var args []any
	if consoleType != "" {
		conds = append(conds, `console_type = ?`)
		args = append(args, consoleType)
	}
	if connectionID != "" {
		conds = append(conds, `connection_id = ?`)
		args = append(args, connectionID)
	}
	if len(conds) > 0 {
		query += ` WHERE ` + strings.Join(conds, ` AND `)
	}
	query += ` ORDER BY updated_at DESC`

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("list saved queries: %w", err)
	}
	defer rows.Close()

	out := []*model.SavedQuery{}
	for rows.Next() {
		q, err := scanSavedQuery(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, q)
	}
	return out, rows.Err()
}

// savedQueryNameTaken reports whether a sibling query (same console_type and
// connection_id) already uses name, ignoring the excludeID row so updates can
// keep their own name.
func (s *Store) savedQueryNameTaken(consoleType, connectionID, name, excludeID string) (bool, error) {
	var count int
	if err := s.db.QueryRow(
		`SELECT COUNT(1) FROM saved_queries WHERE console_type = ? AND connection_id = ? AND name = ? AND id <> ?`,
		consoleType, connectionID, name, excludeID,
	).Scan(&count); err != nil {
		return false, fmt.Errorf("check saved query name: %w", err)
	}
	return count > 0, nil
}

func scanSavedQuery(row scanner) (*model.SavedQuery, error) {
	var q model.SavedQuery
	if err := row.Scan(&q.ID, &q.Name, &q.ConsoleType, &q.ConnectionID, &q.Content, &q.CreatedAt, &q.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("scan saved query: %w", err)
	}
	return &q, nil
}
