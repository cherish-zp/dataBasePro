// Redis bindings exposed to the Wails frontend. Methods are thin: they
// delegate to the service layer; dangerous operations (flush / bulk delete /
// rename) are audited.
package backend

import (
	"fmt"

	"dataBasePro/backend/internal/model"
	"dataBasePro/backend/internal/service"
)

// RedisScanRequest carries the key-space page parameters.
type RedisScanRequest struct {
	ConnectionID string `json:"connection_id"`
	DB           int    `json:"db"`
	Cursor       uint64 `json:"cursor"`
	Match        string `json:"match"`
	Count        int64  `json:"count"`
}

// RedisScanResult is one SCAN page: the next cursor plus key metadata.
type RedisScanResult struct {
	Cursor uint64              `json:"cursor"`
	Keys   []model.RedisKeyInfo `json:"keys"`
}

// RedisKeyRequest addresses one key (and its optional new name / TTL).
type RedisKeyRequest struct {
	ConnectionID string `json:"connection_id"`
	DB           int    `json:"db"`
	Key          string `json:"key"`
	NewKey       string `json:"new_key,omitempty"`
	TTLSeconds   int64  `json:"ttl_seconds,omitempty"`
}

// RedisDeleteKeysRequest carries the keys to remove.
type RedisDeleteKeysRequest struct {
	ConnectionID string   `json:"connection_id"`
	DB           int      `json:"db"`
	Keys         []string `json:"keys"`
}

// RedisSetStringRequest writes a string key with an optional expiry.
type RedisSetStringRequest struct {
	ConnectionID string `json:"connection_id"`
	DB           int    `json:"db"`
	Key          string `json:"key"`
	Value        string `json:"value"`
	TTLSeconds   int64  `json:"ttl_seconds,omitempty"`
}

// RedisHashFieldRequest writes or removes one field of a hash key.
type RedisHashFieldRequest struct {
	ConnectionID string `json:"connection_id"`
	DB           int    `json:"db"`
	Key          string `json:"key"`
	Field        string `json:"field"`
	Value        string `json:"value,omitempty"`
}

// RedisListIndexRequest addresses one list element (edit or delete).
type RedisListIndexRequest struct {
	ConnectionID string `json:"connection_id"`
	DB           int    `json:"db"`
	Key          string `json:"key"`
	Index        int64  `json:"index"`
	Value        string `json:"value,omitempty"`
}

// RedisListPushRequest pushes one element to the head or tail of a list.
type RedisListPushRequest struct {
	ConnectionID string `json:"connection_id"`
	DB           int    `json:"db"`
	Key          string `json:"key"`
	Value        string `json:"value"`
	AtHead       bool   `json:"at_head"`
}

// RedisSetMemberRequest adds or removes one member of a set.
type RedisSetMemberRequest struct {
	ConnectionID string `json:"connection_id"`
	DB           int    `json:"db"`
	Key          string `json:"key"`
	Member       string `json:"member"`
}

// RedisZSetMemberRequest adds (with score) or removes one member of a
// sorted set.
type RedisZSetMemberRequest struct {
	ConnectionID string  `json:"connection_id"`
	DB           int     `json:"db"`
	Key          string  `json:"key"`
	Member       string  `json:"member"`
	Score        float64 `json:"score,omitempty"`
}

// RedisFlushRequest addresses the DB (or whole instance) to empty.
type RedisFlushRequest struct {
	ConnectionID string `json:"connection_id"`
	DB           int    `json:"db"`
}

// TestRedisConnection verifies reachability without persisting anything.
func (a *App) TestRedisConnection(cfg model.RedisConfig) error {
	ctx, cancel := a.newContext()
	defer cancel()
	rc, err := service.NewRedisClient(cfg)
	if err != nil {
		return err
	}
	defer rc.Close()
	return rc.Connect(ctx)
}

// ListRedisDBs lists the logical DBs (standalone) or db0 (cluster).
func (a *App) ListRedisDBs(connectionID string) ([]model.RedisDBInfo, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.RedisDatabases(ctx, connectionID)
}

// RedisScan pages the key space.
func (a *App) RedisScan(req RedisScanRequest) (RedisScanResult, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	cursor, keys, err := a.svc.RedisScan(ctx, req.ConnectionID, req.DB, req.Cursor, req.Match, req.Count)
	if err != nil {
		return RedisScanResult{}, err
	}
	return RedisScanResult{Cursor: cursor, Keys: keys}, nil
}

// RedisGetKey loads a key's typed value.
func (a *App) RedisGetKey(req RedisKeyRequest) (model.RedisValue, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.RedisGetKey(ctx, req.ConnectionID, req.DB, req.Key)
}

// RedisRenameKey renames a key (audited).
func (a *App) RedisRenameKey(req RedisKeyRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.RedisRenameKey(ctx, req.ConnectionID, req.DB, req.Key, req.NewKey)
	a.audit(req.ConnectionID, "redis_rename_key", req.Key, auditResult(err), auditDetail(err))
	return err
}

// RedisDeleteKeys deletes keys (audited).
func (a *App) RedisDeleteKeys(req RedisDeleteKeysRequest) (int64, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	n, err := a.svc.RedisDeleteKeys(ctx, req.ConnectionID, req.DB, req.Keys)
	target := joinAuditList(req.Keys, ", ")
	if len(req.Keys) > 10 {
		target = joinAuditList(req.Keys[:10], ", ") + "…"
	}
	a.audit(req.ConnectionID, "redis_delete_keys", target, auditResult(err), auditDetail(err))
	return n, err
}

// RedisSetTTL applies or removes a key expiry.
func (a *App) RedisSetTTL(req RedisKeyRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.RedisSetTTL(ctx, req.ConnectionID, req.DB, req.Key, req.TTLSeconds)
}

// RedisSetString writes a string key (audited).
func (a *App) RedisSetString(req RedisSetStringRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.RedisSetString(ctx, req.ConnectionID, req.DB, req.Key, req.Value, req.TTLSeconds)
	a.audit(req.ConnectionID, "redis_set_string", req.Key, auditResult(err), auditDetail(err))
	return err
}

// RedisHashSetField writes one hash field (audited).
func (a *App) RedisHashSetField(req RedisHashFieldRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.RedisHashSetField(ctx, req.ConnectionID, req.DB, req.Key, req.Field, req.Value)
	a.audit(req.ConnectionID, "redis_hash_set_field", req.Key, auditResult(err), auditDetail(err))
	return err
}

// RedisHashDeleteField removes one hash field (audited).
func (a *App) RedisHashDeleteField(req RedisHashFieldRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.RedisHashDeleteField(ctx, req.ConnectionID, req.DB, req.Key, req.Field)
	a.audit(req.ConnectionID, "redis_hash_delete_field", req.Key, auditResult(err), auditDetail(err))
	return err
}

// RedisListSetIndex overwrites one list element (audited).
func (a *App) RedisListSetIndex(req RedisListIndexRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.RedisListSetIndex(ctx, req.ConnectionID, req.DB, req.Key, req.Index, req.Value)
	a.audit(req.ConnectionID, "redis_list_set_index", req.Key, auditResult(err), auditDetail(err))
	return err
}

// RedisListPush prepends or appends one list element (audited).
func (a *App) RedisListPush(req RedisListPushRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.RedisListPush(ctx, req.ConnectionID, req.DB, req.Key, req.Value, req.AtHead)
	a.audit(req.ConnectionID, "redis_list_push", req.Key, auditResult(err), auditDetail(err))
	return err
}

// RedisListDeleteIndex removes one list element (audited).
func (a *App) RedisListDeleteIndex(req RedisListIndexRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.RedisListDeleteIndex(ctx, req.ConnectionID, req.DB, req.Key, req.Index)
	a.audit(req.ConnectionID, "redis_list_delete_index", req.Key, auditResult(err), auditDetail(err))
	return err
}

// RedisSetAdd inserts one set member (audited).
func (a *App) RedisSetAdd(req RedisSetMemberRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.RedisSetAdd(ctx, req.ConnectionID, req.DB, req.Key, req.Member)
	a.audit(req.ConnectionID, "redis_set_add", req.Key, auditResult(err), auditDetail(err))
	return err
}

// RedisSetRemove deletes one set member (audited).
func (a *App) RedisSetRemove(req RedisSetMemberRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.RedisSetRemove(ctx, req.ConnectionID, req.DB, req.Key, req.Member)
	a.audit(req.ConnectionID, "redis_set_remove", req.Key, auditResult(err), auditDetail(err))
	return err
}

// RedisZSetAdd inserts a sorted-set member or updates its score (audited).
func (a *App) RedisZSetAdd(req RedisZSetMemberRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.RedisZSetAdd(ctx, req.ConnectionID, req.DB, req.Key, req.Member, req.Score)
	a.audit(req.ConnectionID, "redis_zset_add", req.Key, auditResult(err), auditDetail(err))
	return err
}

// RedisZSetRemove deletes one sorted-set member (audited).
func (a *App) RedisZSetRemove(req RedisZSetMemberRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.RedisZSetRemove(ctx, req.ConnectionID, req.DB, req.Key, req.Member)
	a.audit(req.ConnectionID, "redis_zset_remove", req.Key, auditResult(err), auditDetail(err))
	return err
}

// RedisFlushDB empties the given DB (dangerous, audited).
func (a *App) RedisFlushDB(req RedisFlushRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.RedisFlushDB(ctx, req.ConnectionID, req.DB)
	a.audit(req.ConnectionID, "redis_flushdb", fmt.Sprintf("db%d", req.DB), auditResult(err), auditDetail(err))
	return err
}

// RedisFlushAll empties the whole instance/cluster (dangerous, audited).
func (a *App) RedisFlushAll(req RedisFlushRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.RedisFlushAll(ctx, req.ConnectionID)
	a.audit(req.ConnectionID, "redis_flushall", "*", auditResult(err), auditDetail(err))
	return err
}

// RedisServerInfo builds the overview for the connection's Redis.
func (a *App) RedisServerInfo(connectionID string) (model.RedisServerInfo, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.RedisServerInfo(ctx, connectionID)
}
