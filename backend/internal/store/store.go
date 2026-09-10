// Package store provides local persistence for connection definitions using
// a CGO-free SQLite driver, with sensitive fields encrypted at rest.
package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"dataBasePro/backend/internal/model"
)

var ErrNotFound = errors.New("record not found")

const schema = `
CREATE TABLE IF NOT EXISTS connections (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    config_json TEXT NOT NULL,
    created_at  INTEGER,
    updated_at  INTEGER
);
CREATE TABLE IF NOT EXISTS audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT NOT NULL DEFAULT '',
    action        TEXT NOT NULL,
    target        TEXT NOT NULL DEFAULT '',
    result        TEXT NOT NULL,
    detail        TEXT NOT NULL DEFAULT '',
    ts            INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS saved_queries (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    console_type  TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    content       TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
`

// auditDefaultLimit caps unqualified audit listings.
const auditDefaultLimit = 200

// Store persists connection definitions to a local SQLite database.
type Store struct {
	db     *sql.DB
	crypto *Crypto
}

// Open opens (creating if needed) the SQLite database at path and initialises
// the schema. masterPassword is used to encrypt/decrypt sensitive fields.
func Open(path string, masterPassword string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("create db dir: %w", err)
	}
	crypto, err := NewCrypto(masterPassword)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1) // modernc sqlite does not support concurrent writes well
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("init schema: %w", err)
	}
	return &Store{db: db, crypto: crypto}, nil
}

// Close releases the underlying database handle.
func (s *Store) Close() error {
	return s.db.Close()
}

// CreateConnection inserts a new connection definition.
func (s *Store) CreateConnection(c *model.Connection) error {
	if c.ID == "" {
		return errors.New("connection id must not be empty")
	}
	now := time.Now().UnixMilli()
	c.CreatedAt = now
	c.UpdatedAt = now
	raw, err := s.marshalConfig(c.Type, c.Config)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(
		`INSERT INTO connections (id, name, type, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
		c.ID, c.Name, string(c.Type), raw, c.CreatedAt, c.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert connection: %w", err)
	}
	return nil
}

// UpdateConnection overwrites an existing connection definition.
func (s *Store) UpdateConnection(c *model.Connection) error {
	if c.ID == "" {
		return errors.New("connection id must not be empty")
	}
	c.UpdatedAt = time.Now().UnixMilli()
	raw, err := s.marshalConfig(c.Type, c.Config)
	if err != nil {
		return err
	}
	res, err := s.db.Exec(
		`UPDATE connections SET name = ?, type = ?, config_json = ?, updated_at = ? WHERE id = ?`,
		c.Name, string(c.Type), raw, c.UpdatedAt, c.ID,
	)
	if err != nil {
		return fmt.Errorf("update connection: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteConnection removes a connection definition.
func (s *Store) DeleteConnection(id string) error {
	res, err := s.db.Exec(`DELETE FROM connections WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete connection: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// GetConnection loads a single connection by id.
func (s *Store) GetConnection(id string) (*model.Connection, error) {
	row := s.db.QueryRow(
		`SELECT id, name, type, config_json, created_at, updated_at FROM connections WHERE id = ?`, id,
	)
	return s.scanConnection(row)
}

// ListConnections returns every stored connection.
func (s *Store) ListConnections() ([]*model.Connection, error) {
	rows, err := s.db.Query(
		`SELECT id, name, type, config_json, created_at, updated_at FROM connections ORDER BY created_at`,
	)
	if err != nil {
		return nil, fmt.Errorf("list connections: %w", err)
	}
	defer rows.Close()

	out := []*model.Connection{}
	for rows.Next() {
		c, err := s.scanConnection(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

type scanner interface {
	Scan(dest ...any) error
}

func (s *Store) scanConnection(row scanner) (*model.Connection, error) {
	var (
		c       model.Connection
		raw     string
		rawType string
	)
	if err := row.Scan(&c.ID, &c.Name, &rawType, &raw, &c.CreatedAt, &c.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("scan connection: %w", err)
	}
	c.Type = model.ConnectionType(rawType)
	cfg, err := s.unmarshalConfig(string(c.Type), raw)
	if err != nil {
		return nil, err
	}
	c.Config = cfg
	return &c, nil
}

// marshalConfig serialises the config for the connection type, encrypting
// the password field (kafka: SASL.Password, redis: Password, clickhouse:
// Password) so the raw stored JSON never contains plaintext secrets.
func (s *Store) marshalConfig(typ model.ConnectionType, raw json.RawMessage) (string, error) {
	switch typ {
	case model.ConnectionTypeRedis:
		var cfg model.RedisConfig
		if err := json.Unmarshal(raw, &cfg); err != nil {
			return "", fmt.Errorf("unmarshal redis config: %w", err)
		}
		if cfg.Password != "" {
			enc, err := s.crypto.Encrypt(cfg.Password)
			if err != nil {
				return "", fmt.Errorf("encrypt password: %w", err)
			}
			cfg.Password = enc
		}
		b, err := json.Marshal(cfg)
		if err != nil {
			return "", fmt.Errorf("marshal config: %w", err)
		}
		return string(b), nil
	case model.ConnectionTypeClickHouse:
		var cfg model.ClickHouseConfig
		if err := json.Unmarshal(raw, &cfg); err != nil {
			return "", fmt.Errorf("unmarshal clickhouse config: %w", err)
		}
		if cfg.Password != "" {
			enc, err := s.crypto.Encrypt(cfg.Password)
			if err != nil {
				return "", fmt.Errorf("encrypt password: %w", err)
			}
			cfg.Password = enc
		}
		b, err := json.Marshal(cfg)
		if err != nil {
			return "", fmt.Errorf("marshal config: %w", err)
		}
		return string(b), nil
	default:
		var cfg model.KafkaConfig
		if err := json.Unmarshal(raw, &cfg); err != nil {
			return "", fmt.Errorf("unmarshal kafka config: %w", err)
		}
		if cfg.SASL != nil && cfg.SASL.Password != "" {
			enc, err := s.crypto.Encrypt(cfg.SASL.Password)
			if err != nil {
				return "", fmt.Errorf("encrypt password: %w", err)
			}
			cfg.SASL.Password = enc
		}
		b, err := json.Marshal(cfg)
		if err != nil {
			return "", fmt.Errorf("marshal config: %w", err)
		}
		return string(b), nil
	}
}

// unmarshalConfig loads a config for the connection type, transparently
// decrypting stored passwords (kafka: SASL.Password, redis: Password,
// clickhouse: Password).
func (s *Store) unmarshalConfig(typ string, raw string) (json.RawMessage, error) {
	switch model.ConnectionType(typ) {
	case model.ConnectionTypeRedis:
		var cfg model.RedisConfig
		if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
			return nil, fmt.Errorf("unmarshal redis config: %w", err)
		}
		if cfg.Password != "" && strings.HasPrefix(cfg.Password, encPrefix+cryptoVersion+":") {
			dec, err := s.crypto.Decrypt(cfg.Password)
			if err != nil {
				return nil, fmt.Errorf("decrypt password: %w", err)
			}
			cfg.Password = dec
		}
		b, err := json.Marshal(cfg)
		if err != nil {
			return nil, err
		}
		return json.RawMessage(b), nil
	case model.ConnectionTypeClickHouse:
		var cfg model.ClickHouseConfig
		if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
			return nil, fmt.Errorf("unmarshal clickhouse config: %w", err)
		}
		if cfg.Password != "" && strings.HasPrefix(cfg.Password, encPrefix+cryptoVersion+":") {
			dec, err := s.crypto.Decrypt(cfg.Password)
			if err != nil {
				return nil, fmt.Errorf("decrypt password: %w", err)
			}
			cfg.Password = dec
		}
		b, err := json.Marshal(cfg)
		if err != nil {
			return nil, err
		}
		return json.RawMessage(b), nil
	default:
		var cfg model.KafkaConfig
		if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
			return nil, fmt.Errorf("unmarshal kafka config: %w", err)
		}
		if cfg.SASL != nil && strings.HasPrefix(cfg.SASL.Password, encPrefix+cryptoVersion+":") {
			dec, err := s.crypto.Decrypt(cfg.SASL.Password)
			if err != nil {
				return nil, fmt.Errorf("decrypt password: %w", err)
			}
			cfg.SASL.Password = dec
		}
		b, err := json.Marshal(cfg)
		if err != nil {
			return nil, err
		}
		return json.RawMessage(b), nil
	}
}

func cloneConfig(cfg model.KafkaConfig) model.KafkaConfig {
	out := cfg
	if cfg.SASL != nil {
		s := *cfg.SASL
		out.SASL = &s
	}
	if cfg.TLS != nil {
		t := *cfg.TLS
		out.TLS = &t
	}
	return out
}

// RecordAudit appends an audit entry for a dangerous operation. A zero
// timestamp is replaced with the current unix-ms time.
func (s *Store) RecordAudit(e *model.AuditEntry) error {
	if e == nil {
		return errors.New("audit entry must not be nil")
	}
	if e.Timestamp == 0 {
		e.Timestamp = time.Now().UnixMilli()
	}
	_, err := s.db.Exec(
		`INSERT INTO audit_log (connection_id, action, target, result, detail, ts) VALUES (?, ?, ?, ?, ?, ?)`,
		e.ConnectionID, e.Action, e.Target, e.Result, e.Detail, e.Timestamp,
	)
	if err != nil {
		return fmt.Errorf("insert audit: %w", err)
	}
	return nil
}

// ListAudit returns the most recent audit entries, newest first. A
// non-positive limit falls back to auditDefaultLimit.
func (s *Store) ListAudit(limit int) ([]*model.AuditEntry, error) {
	if limit <= 0 {
		limit = auditDefaultLimit
	}
	rows, err := s.db.Query(
		`SELECT id, connection_id, action, target, result, detail, ts FROM audit_log ORDER BY id DESC LIMIT ?`,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list audit: %w", err)
	}
	defer rows.Close()

	out := []*model.AuditEntry{}
	for rows.Next() {
		var e model.AuditEntry
		if err := rows.Scan(&e.ID, &e.ConnectionID, &e.Action, &e.Target, &e.Result, &e.Detail, &e.Timestamp); err != nil {
			return nil, fmt.Errorf("scan audit: %w", err)
		}
		out = append(out, &e)
	}
	return out, rows.Err()
}
