package backend

import (
	"dataBasePro/backend/internal/model"
)

// ListSavedQueriesRequest carries the optional saved-query listing filters.
// An empty field means "no filter" for that dimension.
type ListSavedQueriesRequest struct {
	ConsoleType  string `json:"console_type,omitempty"`
	ConnectionID string `json:"connection_id,omitempty"`
}

// SaveSavedQueryRequest carries a new saved SQL console query entry.
type SaveSavedQueryRequest struct {
	Name         string `json:"name"`
	ConsoleType  string `json:"console_type"`
	ConnectionID string `json:"connection_id"`
	Content      string `json:"content"`
}

// UpdateSavedQueryRequest carries the editable fields of an existing saved
// query. The console type and connection are properties of the stored row and
// cannot be changed here.
type UpdateSavedQueryRequest struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Content string `json:"content"`
}

// DeleteSavedQueryRequest carries the id of the saved query to remove.
type DeleteSavedQueryRequest struct {
	ID string `json:"id"`
}

// ListSavedQueries returns saved SQL console queries, optionally filtered by
// console type and connection (read-only, not audited).
func (a *App) ListSavedQueries(req ListSavedQueriesRequest) ([]*model.SavedQuery, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.ListSavedQueries(ctx, req.ConsoleType, req.ConnectionID)
}

// SaveSavedQuery validates and stores a new saved query, returning the stored
// record (id/timestamps assigned by the store).
func (a *App) SaveSavedQuery(req SaveSavedQueryRequest) (*model.SavedQuery, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	q := &model.SavedQuery{
		Name:         req.Name,
		ConsoleType:  req.ConsoleType,
		ConnectionID: req.ConnectionID,
		Content:      req.Content,
	}
	return a.svc.CreateSavedQuery(ctx, q)
}

// UpdateSavedQuery rewrites an existing saved query's name and content and
// returns the updated record.
func (a *App) UpdateSavedQuery(req UpdateSavedQueryRequest) (*model.SavedQuery, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.UpdateSavedQuery(ctx, &model.SavedQuery{ID: req.ID, Name: req.Name, Content: req.Content})
}

// DeleteSavedQuery removes a saved query entry (not audited: it only deletes
// a local bookmark, never touches the data source).
func (a *App) DeleteSavedQuery(req DeleteSavedQueryRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.DeleteSavedQuery(ctx, req.ID)
}
