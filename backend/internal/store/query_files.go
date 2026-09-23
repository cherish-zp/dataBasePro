package store

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// connHeaderPrefix is the metadata comment key written at the top of saved
// query files: `-- connection: <id>`.
const connHeaderPrefix = "-- connection: "

// dbHeaderPrefix is the metadata comment key for the database context saved
// alongside the connection: `-- database: <db>`. Written only when a database
// was selected at save time; legacy files stay without the line.
const dbHeaderPrefix = "-- database: "

// schemaHeaderPrefix is the optional schema context line.
const schemaHeaderPrefix = "-- schema: "

// QueryFileInfo describes one saved .sql query file in the query repository.
// The JSON shape is the wire shape handed to the frontend (snake_case).
type QueryFileInfo struct {
	// Name is the file name without the .sql extension.
	Name string `json:"name"`
	// ConnectionID is parsed from the `-- connection: ` header comment; empty
	// for legacy files written before the header convention.
	ConnectionID string `json:"connection_id"`
	SizeBytes    int64  `json:"size_bytes"`
	ModTimeMs    int64  `json:"mod_time_ms"`
}

// QueryFileStore manages the on-disk repository of SQL console queries: one
// .sql file per query inside a user-configured directory. The directory is
// final (any `~` prefix is expanded by the caller, see the app binding layer).
type QueryFileStore struct {
	Dir string
}

// NewQueryFileStore builds a store rooted at dir, normalising the path.
func NewQueryFileStore(dir string) *QueryFileStore {
	return &QueryFileStore{Dir: filepath.Clean(dir)}
}

// ValidateQueryFileName rejects names that could escape the repository
// directory or break the one-file-per-query convention: the name must be
// non-empty, must not contain path separators or `..`, and must end with the
// .sql extension (case-insensitive).
func ValidateQueryFileName(name string) error {
	if name == "" {
		return errors.New("查询文件名不能为空")
	}
	if strings.Contains(name, "/") || strings.Contains(name, `\`) || strings.Contains(name, "..") {
		return fmt.Errorf("查询文件名非法: %s", name)
	}
	if !strings.HasSuffix(strings.ToLower(name), ".sql") {
		return fmt.Errorf("查询文件名必须以 .sql 结尾: %s", name)
	}
	return nil
}

// ParseQueryFileHeader scans the leading block of `--` comment lines for the
// `-- connection: <id>` and `-- database: <db>` entries. Only comments before
// the first non-comment line count, so the same comments inside the SQL body
// are ignored. The body is the original content minus the consumed header
// lines, byte for byte.
func ParseQueryFileHeader(content string) (connectionID, database, schema, body string) {
	rest := content
	for {
		line, next, found := strings.Cut(rest, "\n")
		trimmed := strings.TrimSuffix(line, "\r")
		if !strings.HasPrefix(trimmed, "--") {
			break
		}
		if value, ok := strings.CutPrefix(trimmed, connHeaderPrefix); ok {
			connectionID = strings.TrimSpace(value)
		}
		if value, ok := strings.CutPrefix(trimmed, dbHeaderPrefix); ok {
			database = strings.TrimSpace(value)
		}
		if value, ok := strings.CutPrefix(trimmed, schemaHeaderPrefix); ok {
			schema = strings.TrimSpace(value)
		}
		if !found {
			rest = ""
			break
		}
		rest = next
	}
	return connectionID, database, schema, rest
}

// List returns every .sql file in the directory, newest first (ties broken by
// name). Sub-directories, hidden and editor temp files are skipped. A missing
// directory yields an empty slice: first use before the first write.
func (s *QueryFileStore) List() ([]QueryFileInfo, error) {
	entries, err := os.ReadDir(s.Dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []QueryFileInfo{}, nil
		}
		return nil, fmt.Errorf("list query files: %w", err)
	}
	out := []QueryFileInfo{}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if strings.HasPrefix(name, ".") || strings.HasSuffix(name, ".tmp") || strings.HasSuffix(name, "~") {
			continue
		}
		if !strings.EqualFold(filepath.Ext(name), ".sql") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue // file vanished between ReadDir and Info; skip it
		}
		item := QueryFileInfo{
			Name:      strings.TrimSuffix(name, filepath.Ext(name)),
			SizeBytes: info.Size(),
			ModTimeMs: info.ModTime().UnixMilli(),
		}
		// Best effort header parse: a file that disappears mid-scan still
		// lists, just without a connection id.
		if raw, err := os.ReadFile(filepath.Join(s.Dir, name)); err == nil {
			item.ConnectionID, _, _, _ = ParseQueryFileHeader(string(raw))
		}
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ModTimeMs != out[j].ModTimeMs {
			return out[i].ModTimeMs > out[j].ModTimeMs
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// Read returns the full original content of <name> plus the connection id and
// database parsed from the header comments (empty for legacy files).
func (s *QueryFileStore) Read(name string) (content, connectionID, database, schema string, err error) {
	if err := ValidateQueryFileName(name); err != nil {
		return "", "", "", "", err
	}
	raw, err := os.ReadFile(filepath.Join(s.Dir, name))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", "", "", "", fmt.Errorf("查询文件不存在: %s", name)
		}
		return "", "", "", "", fmt.Errorf("read query file: %w", err)
	}
	content = string(raw)
	connectionID, database, schema, _ = ParseQueryFileHeader(content)
	return content, connectionID, database, schema, nil
}

// Write stores content as <name>, prepending header comments inside the
// leading comment block: `-- connection: <id>` and `-- database: <db>`, each
// only when non-empty; with neither the content is stored verbatim (legacy
// files stay header-free). An existing file of the same name is overwritten,
// and a missing directory is created.
func (s *QueryFileStore) Write(name, content, connectionID, database, schema string) error {
	if err := ValidateQueryFileName(name); err != nil {
		return err
	}
	var header strings.Builder
	if connectionID != "" {
		header.WriteString(connHeaderPrefix + connectionID + "\n")
	}
	if database != "" {
		header.WriteString(dbHeaderPrefix + database + "\n")
	}
	if schema != "" {
		header.WriteString(schemaHeaderPrefix + schema + "\n")
	}
	if header.Len() > 0 {
		content = header.String() + content
	}
	if err := os.MkdirAll(s.Dir, 0o755); err != nil {
		return fmt.Errorf("create query dir: %w", err)
	}
	if err := os.WriteFile(filepath.Join(s.Dir, name), []byte(content), 0o600); err != nil {
		return fmt.Errorf("write query file: %w", err)
	}
	return nil
}

// Delete removes <name>; a missing file yields a Chinese not-found error.
func (s *QueryFileStore) Delete(name string) error {
	if err := ValidateQueryFileName(name); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(s.Dir, name)); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("查询文件不存在: %s", name)
		}
		return fmt.Errorf("delete query file: %w", err)
	}
	return nil
}
