package backend

import (
	"os"
	"path/filepath"
	"strings"

	"dataBasePro/backend/internal/store"
)

// QueryFileListRequest carries the query-file repository directory.
type QueryFileListRequest struct {
	Dir string `json:"dir"`
}

// QueryFileReadRequest carries the directory and file name to load. The name
// may omit the .sql extension (the list view exposes extension-less names).
type QueryFileReadRequest struct {
	Dir  string `json:"dir"`
	Name string `json:"name"`
}

// QueryFileWriteRequest stores one SQL console query as a .sql file. A
// non-empty connection_id is written back as a `-- connection: <id>` header
// comment; legacy files keep working without one.
type QueryFileWriteRequest struct {
	Dir          string `json:"dir"`
	Name         string `json:"name"`
	Content      string `json:"content"`
	ConnectionID string `json:"connection_id,omitempty"`
}

// QueryFileDeleteRequest carries the directory and file name to remove.
type QueryFileDeleteRequest struct {
	Dir  string `json:"dir"`
	Name string `json:"name"`
}

// QueryFileContent returns the full original file text plus the connection id
// parsed from the header comment (empty for legacy files).
type QueryFileContent struct {
	Content      string `json:"content"`
	ConnectionID string `json:"connection_id"`
}

// expandQueryDir expands a leading `~`/`~/` to the user's home directory and
// cleans the result; embedded tildes are left untouched.
func expandQueryDir(dir string) string {
	if dir == "~" || strings.HasPrefix(dir, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			if dir == "~" {
				dir = home
			} else {
				dir = filepath.Join(home, dir[2:])
			}
		}
	}
	return filepath.Clean(dir)
}

// queryFileName normalises an extension-less display name to its on-disk file
// name; a name that already ends with .sql (any casing) is kept as-is.
func queryFileName(name string) string {
	if !strings.HasSuffix(strings.ToLower(name), ".sql") {
		return name + ".sql"
	}
	return name
}

// ListQueryFiles lists the .sql files in the directory, newest first
// (read-only, not audited).
func (a *App) ListQueryFiles(req QueryFileListRequest) ([]store.QueryFileInfo, error) {
	return store.NewQueryFileStore(expandQueryDir(req.Dir)).List()
}

// ReadQueryFile loads one query file's full content and its header connection
// id (read-only, not audited).
func (a *App) ReadQueryFile(req QueryFileReadRequest) (QueryFileContent, error) {
	content, connectionID, err := store.NewQueryFileStore(expandQueryDir(req.Dir)).Read(queryFileName(req.Name))
	if err != nil {
		return QueryFileContent{}, err
	}
	return QueryFileContent{Content: content, ConnectionID: connectionID}, nil
}

// WriteQueryFile saves one query as a .sql file in the configured directory
// (a plain local file operation, not audited).
func (a *App) WriteQueryFile(req QueryFileWriteRequest) error {
	return store.NewQueryFileStore(expandQueryDir(req.Dir)).
		Write(queryFileName(req.Name), req.Content, req.ConnectionID)
}

// DeleteQueryFile removes one query file (not audited: it only deletes a
// local file, never touches the data source).
func (a *App) DeleteQueryFile(req QueryFileDeleteRequest) error {
	return store.NewQueryFileStore(expandQueryDir(req.Dir)).Delete(queryFileName(req.Name))
}
