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
// comment, and a non-empty database as a `-- database: <db>` line in the same
// leading comment block; legacy files keep working without either.
type QueryFileWriteRequest struct {
	Dir          string `json:"dir"`
	Name         string `json:"name"`
	Content      string `json:"content"`
	ConnectionID string `json:"connection_id,omitempty"`
	// Schema is the schema context selected at save time; empty omits it.
	Schema string `json:"schema,omitempty"`
	// Database is the database context selected at save time; empty omits the
	// header line so reopening falls back to no database.
	Database string `json:"database,omitempty"`
}

// QueryFileDeleteRequest carries the directory and file name to remove.
type QueryFileDeleteRequest struct {
	Dir  string `json:"dir"`
	Name string `json:"name"`
}

// QueryFileContent returns the full original file text plus the connection id
// and database parsed from the header comments (empty for legacy files).
type QueryFileContent struct {
	Content      string `json:"content"`
	ConnectionID string `json:"connection_id"`
	// Database is the `-- database: <db>` header value; empty when the file
	// was saved without a database context.
	Database string `json:"database"`
	// Schema is the `-- schema: <schema>` header value; empty for legacy files.
	Schema string `json:"schema"`
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

// ReadQueryFile loads one query file's full content plus its header connection
// id and database (read-only, not audited).
func (a *App) ReadQueryFile(req QueryFileReadRequest) (QueryFileContent, error) {
	content, connectionID, database, schema, err := store.NewQueryFileStore(expandQueryDir(req.Dir)).Read(queryFileName(req.Name))
	if err != nil {
		return QueryFileContent{}, err
	}
	return QueryFileContent{Content: content, ConnectionID: connectionID, Database: database, Schema: schema}, nil
}

// WriteQueryFile saves one query as a .sql file in the configured directory
// (a plain local file operation, not audited).
func (a *App) WriteQueryFile(req QueryFileWriteRequest) error {
	return store.NewQueryFileStore(expandQueryDir(req.Dir)).
		Write(queryFileName(req.Name), req.Content, req.ConnectionID, req.Database, req.Schema)
}

// DeleteQueryFile removes one query file (not audited: it only deletes a
// local file, never touches the data source).
func (a *App) DeleteQueryFile(req QueryFileDeleteRequest) error {
	return store.NewQueryFileStore(expandQueryDir(req.Dir)).Delete(queryFileName(req.Name))
}
