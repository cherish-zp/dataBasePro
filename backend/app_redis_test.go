package backend

import (
	"testing"

	"github.com/alicebob/miniredis/v2"

	"dataBasePro/backend/internal/model"
)

// newRedisApp 起一个 miniredis 并在 store 里登记一个指向它的 redis 连接。
func newRedisApp(t *testing.T) (*App, *miniredis.Miniredis, string) {
	t.Helper()
	app := newTestApp(t)
	mr := miniredis.RunT(t)
	conn, err := app.CreateConnection(&model.Connection{
		Name:   "redis-local",
		Type:   model.ConnectionTypeRedis,
		Config: model.MustConfigJSON(model.RedisConfig{Addr: mr.Addr()}),
	})
	if err != nil {
		t.Fatalf("create redis connection: %v", err)
	}
	return app, mr, conn.ID
}

func TestAppRedisKeysFlow(t *testing.T) {
	app, mr, connID := newRedisApp(t)

	if err := app.RedisSetString(RedisSetStringRequest{ConnectionID: connID, DB: 0, Key: "greeting", Value: "hello", TTLSeconds: 60}); err != nil {
		t.Fatalf("RedisSetString: %v", err)
	}
	if got, _ := mr.Get("greeting"); got != "hello" {
		t.Fatalf("greeting = %q", got)
	}
	mr.HSet("user:1", "name", "ann")

	scan, err := app.RedisScan(RedisScanRequest{ConnectionID: connID, DB: 0, Match: "*", Count: 50})
	if err != nil {
		t.Fatalf("RedisScan: %v", err)
	}
	if len(scan.Keys) != 2 {
		t.Fatalf("expected 2 keys, got %+v", scan.Keys)
	}

	val, err := app.RedisGetKey(RedisKeyRequest{ConnectionID: connID, DB: 0, Key: "greeting"})
	if err != nil {
		t.Fatalf("RedisGetKey: %v", err)
	}
	if val.String == nil || *val.String != "hello" || val.TTLSeconds <= 0 {
		t.Fatalf("unexpected value %+v", val)
	}

	if err := app.RedisRenameKey(RedisKeyRequest{ConnectionID: connID, DB: 0, Key: "greeting", NewKey: "hi"}); err != nil {
		t.Fatalf("RedisRenameKey: %v", err)
	}
	if mr.Exists("greeting") || !mr.Exists("hi") {
		t.Fatal("rename not applied")
	}

	n, err := app.RedisDeleteKeys(RedisDeleteKeysRequest{ConnectionID: connID, DB: 0, Keys: []string{"hi", "user:1"}})
	if err != nil || n != 2 {
		t.Fatalf("RedisDeleteKeys: %d %v", n, err)
	}
}

func TestAppRedisTTLAndFlush(t *testing.T) {
	app, mr, connID := newRedisApp(t)
	mr.Set("k", "v")

	if err := app.RedisSetTTL(RedisKeyRequest{ConnectionID: connID, DB: 0, Key: "k", TTLSeconds: 120}); err != nil {
		t.Fatalf("RedisSetTTL: %v", err)
	}
	if ttl := mr.TTL("k"); ttl <= 0 {
		t.Fatalf("expected ttl on k")
	}

	if err := app.RedisFlushDB(RedisFlushRequest{ConnectionID: connID, DB: 0}); err != nil {
		t.Fatalf("RedisFlushDB: %v", err)
	}
	if mr.Exists("k") {
		t.Fatal("flushdb left keys")
	}
	mr.Set("k2", "v2")
	if err := app.RedisFlushAll(RedisFlushRequest{ConnectionID: connID}); err != nil {
		t.Fatalf("RedisFlushAll: %v", err)
	}
	if mr.Exists("k2") {
		t.Fatal("flushall left keys")
	}
}

func TestAppRedisServerInfoAndDBs(t *testing.T) {
	app, mr, connID := newRedisApp(t)
	mr.Set("a", "1")
	mr.Set("b", "2")

	dbs, err := app.ListRedisDBs(connID)
	if err != nil {
		t.Fatalf("ListRedisDBs: %v", err)
	}
	if len(dbs) == 0 || dbs[0].Index != 0 {
		t.Fatalf("unexpected dbs %+v", dbs)
	}

	info, err := app.RedisServerInfo(connID)
	if err != nil {
		t.Fatalf("RedisServerInfo: %v", err)
	}
	if info.Mode != "standalone" {
		t.Fatalf("mode %q", info.Mode)
	}
}

func TestAppRedisOperationsAudited(t *testing.T) {
	app, _, connID := newRedisApp(t)
	if err := app.RedisSetString(RedisSetStringRequest{ConnectionID: connID, DB: 0, Key: "k", Value: "v"}); err != nil {
		t.Fatalf("set: %v", err)
	}
	if _, err := app.RedisDeleteKeys(RedisDeleteKeysRequest{ConnectionID: connID, DB: 0, Keys: []string{"k"}}); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := app.RedisFlushAll(RedisFlushRequest{ConnectionID: connID}); err != nil {
		t.Fatalf("flushall: %v", err)
	}

	list, err := app.ListAudit(50)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	actions := map[string]bool{}
	for _, e := range list {
		actions[e.Action] = true
	}
	for _, want := range []string{"redis_set_string", "redis_delete_keys", "redis_flushall"} {
		if !actions[want] {
			t.Fatalf("missing audit action %q in %+v", want, list)
		}
	}
}

// 集合类型编辑:Hash/List/Set/ZSet 全链路(App → service → redis)。
func TestAppRedisCollectionEdits(t *testing.T) {
	app, mr, connID := newRedisApp(t)

	if err := app.RedisHashSetField(RedisHashFieldRequest{ConnectionID: connID, DB: 0, Key: "user:1", Field: "email", Value: "a@b.c"}); err != nil {
		t.Fatalf("RedisHashSetField: %v", err)
	}
	if got := mr.HGet("user:1", "email"); got != "a@b.c" {
		t.Fatalf("email = %q", got)
	}
	if err := app.RedisHashDeleteField(RedisHashFieldRequest{ConnectionID: connID, DB: 0, Key: "user:1", Field: "email"}); err != nil {
		t.Fatalf("RedisHashDeleteField: %v", err)
	}
	hashKeys, _ := mr.HKeys("user:1")
	for _, f := range hashKeys {
		if f == "email" {
			t.Fatal("email not deleted")
		}
	}

	mr.RPush("q", "a", "b")
	if err := app.RedisListSetIndex(RedisListIndexRequest{ConnectionID: connID, DB: 0, Key: "q", Index: 1, Value: "b2"}); err != nil {
		t.Fatalf("RedisListSetIndex: %v", err)
	}
	if err := app.RedisListPush(RedisListPushRequest{ConnectionID: connID, DB: 0, Key: "q", Value: "tail", AtHead: false}); err != nil {
		t.Fatalf("RedisListPush tail: %v", err)
	}
	if err := app.RedisListPush(RedisListPushRequest{ConnectionID: connID, DB: 0, Key: "q", Value: "head", AtHead: true}); err != nil {
		t.Fatalf("RedisListPush head: %v", err)
	}
	if err := app.RedisListDeleteIndex(RedisListIndexRequest{ConnectionID: connID, DB: 0, Key: "q", Index: 1}); err != nil {
		t.Fatalf("RedisListDeleteIndex: %v", err)
	}
	lv, err := app.RedisGetKey(RedisKeyRequest{ConnectionID: connID, DB: 0, Key: "q"})
	if err != nil {
		t.Fatalf("RedisGetKey: %v", err)
	}
	got := lv.List
	want := []string{"head", "b2", "tail"}
	if len(got) != len(want) {
		t.Fatalf("list = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("list = %v, want %v", got, want)
		}
	}
	if err := app.RedisListDeleteIndex(RedisListIndexRequest{ConnectionID: connID, DB: 0, Key: "q", Index: 99}); err == nil {
		t.Fatal("expected error for out-of-range list delete")
	}

	if err := app.RedisSetAdd(RedisSetMemberRequest{ConnectionID: connID, DB: 0, Key: "tags", Member: "x"}); err != nil {
		t.Fatalf("RedisSetAdd: %v", err)
	}
	if err := app.RedisSetRemove(RedisSetMemberRequest{ConnectionID: connID, DB: 0, Key: "tags", Member: "x"}); err != nil {
		t.Fatalf("RedisSetRemove: %v", err)
	}
	if mr.Exists("tags") {
		t.Fatal("tags not emptied")
	}

	if err := app.RedisZSetAdd(RedisZSetMemberRequest{ConnectionID: connID, DB: 0, Key: "board", Member: "alice", Score: 3.5}); err != nil {
		t.Fatalf("RedisZSetAdd: %v", err)
	}
	if score, err := mr.ZScore("board", "alice"); err != nil || score != 3.5 {
		t.Fatalf("alice score = %v (err %v)", score, err)
	}
	if err := app.RedisZSetRemove(RedisZSetMemberRequest{ConnectionID: connID, DB: 0, Key: "board", Member: "alice"}); err != nil {
		t.Fatalf("RedisZSetRemove: %v", err)
	}
	if mr.Exists("board") {
		t.Fatal("board not emptied")
	}
}

// 集合编辑写操作一律落审计。
func TestAppRedisCollectionEditsAudited(t *testing.T) {
	app, _, connID := newRedisApp(t)
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatalf("operation failed: %v", err)
		}
	}
	must(app.RedisHashSetField(RedisHashFieldRequest{ConnectionID: connID, DB: 0, Key: "k", Field: "f", Value: "v"}))
	must(app.RedisHashDeleteField(RedisHashFieldRequest{ConnectionID: connID, DB: 0, Key: "k", Field: "f"}))
	must(app.RedisListPush(RedisListPushRequest{ConnectionID: connID, DB: 0, Key: "k", Value: "v", AtHead: true}))
	must(app.RedisListSetIndex(RedisListIndexRequest{ConnectionID: connID, DB: 0, Key: "k", Index: 0, Value: "v2"}))
	must(app.RedisListDeleteIndex(RedisListIndexRequest{ConnectionID: connID, DB: 0, Key: "k", Index: 0}))
	must(app.RedisSetAdd(RedisSetMemberRequest{ConnectionID: connID, DB: 0, Key: "k", Member: "m"}))
	must(app.RedisSetRemove(RedisSetMemberRequest{ConnectionID: connID, DB: 0, Key: "k", Member: "m"}))
	must(app.RedisZSetAdd(RedisZSetMemberRequest{ConnectionID: connID, DB: 0, Key: "k", Member: "m", Score: 1}))
	must(app.RedisZSetRemove(RedisZSetMemberRequest{ConnectionID: connID, DB: 0, Key: "k", Member: "m"}))

	list, err := app.ListAudit(50)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	actions := map[string]bool{}
	for _, e := range list {
		actions[e.Action] = true
	}
	for _, want := range []string{
		"redis_hash_set_field", "redis_hash_delete_field",
		"redis_list_push", "redis_list_set_index", "redis_list_delete_index",
		"redis_set_add", "redis_set_remove",
		"redis_zset_add", "redis_zset_remove",
	} {
		if !actions[want] {
			t.Fatalf("missing audit action %q in %+v", want, list)
		}
	}
}
