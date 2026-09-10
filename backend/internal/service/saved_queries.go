package service

import (
	"context"

	"dataBasePro/backend/internal/model"
)

// CreateSavedQuery validates and persists a saved SQL console query, returning
// the stored record (id and timestamps are assigned by the store). Saving a
// query is not a dangerous operation, so it is not audited.
func (s *Service) CreateSavedQuery(ctx context.Context, q *model.SavedQuery) (*model.SavedQuery, error) {
	if err := q.Validate(); err != nil {
		return nil, err
	}
	if err := s.store.CreateSavedQuery(q); err != nil {
		return nil, err
	}
	return q, nil
}

// UpdateSavedQuery rewrites the name and content of an existing saved query.
// The console type, connection and created_at are properties of the stored
// row (the update request only carries id/name/content), so they are loaded
// and preserved before validating and delegating to the store.
func (s *Service) UpdateSavedQuery(ctx context.Context, q *model.SavedQuery) (*model.SavedQuery, error) {
	existing, err := s.store.GetSavedQuery(q.ID)
	if err != nil {
		return nil, err
	}
	existing.Name = q.Name
	existing.Content = q.Content
	if err := existing.Validate(); err != nil {
		return nil, err
	}
	if err := s.store.UpdateSavedQuery(existing); err != nil {
		return nil, err
	}
	return existing, nil
}

// DeleteSavedQuery removes a saved query entry.
func (s *Service) DeleteSavedQuery(ctx context.Context, id string) error {
	return s.store.DeleteSavedQuery(id)
}

// ListSavedQueries returns saved queries newest-updated first, optionally
// filtered by console type and connection (empty filters list everything).
func (s *Service) ListSavedQueries(ctx context.Context, consoleType, connectionID string) ([]*model.SavedQuery, error) {
	return s.store.ListSavedQueries(consoleType, connectionID)
}
