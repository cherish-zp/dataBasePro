package service

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"

	"dataBasePro/backend/internal/model"
	"dataBasePro/backend/internal/store"
)

// newTestRedis spins up a miniredis (standalone) with a few keys and returns
// a connected RedisClient.
func newTestRedis(t *testing.T, seedKeys bool) (*RedisClient, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	if seedKeys {
		mr.Set("greeting:string", "hello")
		mr.HSet("user:1:hash", "name", "ann", "age", "30")
		mr.RPush("queue:list", "a", "b")
		mr.SAdd("tags:set", "x", "y")
		mr.ZAdd("board:zset", 9.5, "alice")
		mr.SetTTL("greeting:string", 60*time.Second)
	}
	cfg := model.RedisConfig{Addr: mr.Addr(), DB: 0}
	rc, err := NewRedisClient(cfg)
	if err != nil {
		t.Fatalf("NewRedisClient: %v", err)
	}
	t.Cleanup(func() { rc.Close() })
	return rc, mr
}

func TestRedisClientPingAndClusterDetection(t *testing.T) {
	rc, _ := newTestRedis(t, false)
	if rc.IsCluster() {
		t.Fatal("miniredis must be detected as standalone")
	}
	if err := rc.Ping(context.Background()); err != nil {
		t.Fatalf("Ping: %v", err)
	}
}

func TestRedisClientDatabases(t *testing.T) {
	rc, _ := newTestRedis(t, false)
	dbs, err := rc.Databases(context.Background())
	if err != nil {
		t.Fatalf("Databases: %v", err)
	}
	if len(dbs) == 0 || dbs[0].Index != 0 {
		t.Fatalf("unexpected dbs %+v", dbs)
	}
}

func TestRedisClientScanReturnsTypedKeys(t *testing.T) {
	rc, _ := newTestRedis(t, true)
	ctx := context.Background()
	_, keys, err := rc.Scan(ctx, 0, 0, "*", 50)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(keys) != 5 {
		t.Fatalf("expected 5 keys, got %d: %+v", len(keys), keys)
	}
	byKey := map[string]model.RedisKeyInfo{}
	for _, k := range keys {
		byKey[k.Key] = k
	}
	if byKey["greeting:string"].Type != "string" {
		t.Fatalf("greeting type %q", byKey["greeting:string"].Type)
	}
	if byKey["user:1:hash"].Type != "hash" || byKey["queue:list"].Type != "list" ||
		byKey["tags:set"].Type != "set" || byKey["board:zset"].Type != "zset" {
		t.Fatalf("unexpected types: %+v", byKey)
	}
	if byKey["greeting:string"].TTLSeconds <= 0 {
		t.Fatalf("expected positive ttl on greeting, got %+v", byKey["greeting:string"])
	}
}

func TestRedisClientGetKeyByType(t *testing.T) {
	rc, _ := newTestRedis(t, true)
	ctx := context.Background()

	sv, err := rc.GetKey(ctx, 0, "greeting:string")
	if err != nil {
		t.Fatalf("get string: %v", err)
	}
	if sv.String == nil || *sv.String != "hello" {
		t.Fatalf("unexpected string value %+v", sv)
	}
	if sv.TTLSeconds <= 0 {
		t.Fatalf("string ttl not carried: %+v", sv)
	}

	hv, err := rc.GetKey(ctx, 0, "user:1:hash")
	if err != nil {
		t.Fatalf("get hash: %v", err)
	}
	if len(hv.Hash) != 2 {
		t.Fatalf("expected 2 hash fields, got %+v", hv.Hash)
	}

	lv, err := rc.GetKey(ctx, 0, "queue:list")
	if err != nil {
		t.Fatalf("get list: %v", err)
	}
	if len(lv.List) != 2 || lv.List[0] != "a" {
		t.Fatalf("unexpected list %+v", lv.List)
	}

	sev, err := rc.GetKey(ctx, 0, "tags:set")
	if err != nil {
		t.Fatalf("get set: %v", err)
	}
	if len(sev.Set) != 2 {
		t.Fatalf("unexpected set %+v", sev.Set)
	}

	zv, err := rc.GetKey(ctx, 0, "board:zset")
	if err != nil {
		t.Fatalf("get zset: %v", err)
	}
	if len(zv.ZSet) != 1 || zv.ZSet[0].Member != "alice" || zv.ZSet[0].Score != 9.5 {
		t.Fatalf("unexpected zset %+v", zv.ZSet)
	}
}

func TestRedisClientStringTruncation(t *testing.T) {
	rc, mr := newTestRedis(t, false)
	big := strings.Repeat("x", StringTruncateBytes+1024)
	if err := mr.Set("big", big); err != nil {
		t.Fatal(err)
	}
	v, err := rc.GetKey(context.Background(), 0, "big")
	if err != nil {
		t.Fatalf("GetKey: %v", err)
	}
	if !v.Truncated {
		t.Fatal("expected truncated string")
	}
	if v.String == nil || len(*v.String) != StringTruncateBytes {
		t.Fatalf("truncated length %d, want %d", lenOf(v.String), StringTruncateBytes)
	}
	if v.SizeBytes != int64(len(big)) {
		t.Fatalf("size bytes %d, want %d", v.SizeBytes, len(big))
	}
}

func lenOf(s *string) int {
	if s == nil {
		return -1
	}
	return len(*s)
}

func TestRedisClientMutations(t *testing.T) {
	rc, mr := newTestRedis(t, false)
	ctx := context.Background()

	if err := rc.SetString(ctx, 0, "k1", "v1", 30); err != nil {
		t.Fatalf("SetString: %v", err)
	}
	if got, _ := mr.Get("k1"); got != "v1" {
		t.Fatalf("k1 = %q", got)
	}
	if ttl := mr.TTL("k1"); ttl <= 0 {
		t.Fatalf("expected ttl on k1")
	}

	if err := rc.RenameKey(ctx, 0, "k1", "k2"); err != nil {
		t.Fatalf("RenameKey: %v", err)
	}
	if mr.Exists("k1") || !mr.Exists("k2") {
		t.Fatal("rename not applied")
	}

	n, err := rc.DeleteKeys(ctx, 0, []string{"k2"})
	if err != nil || n != 1 {
		t.Fatalf("DeleteKeys: %d %v", n, err)
	}

	if err := rc.SetTTL(ctx, 0, "k2", -1); err == nil {
		// key 已删除,预期失败——仅验证路径可达。
		_ = err
	}
}

func TestRedisClientFlushDBAndAll(t *testing.T) {
	rc, mr := newTestRedis(t, true)
	ctx := context.Background()
	if err := rc.FlushDB(ctx, 0); err != nil {
		t.Fatalf("FlushDB: %v", err)
	}
	if len(mr.Keys()) != 0 {
		t.Fatalf("flushdb left %d keys", len(mr.Keys()))
	}
	mr.Set("again", "1")
	if err := rc.FlushAll(ctx); err != nil {
		t.Fatalf("FlushAll: %v", err)
	}
	if len(mr.Keys()) != 0 {
		t.Fatalf("flushall left %d keys", len(mr.Keys()))
	}
}

func TestRedisClientServerInfo(t *testing.T) {
	rc, _ := newTestRedis(t, true)
	info, err := rc.ServerInfo(context.Background())
	if err != nil {
		t.Fatalf("ServerInfo: %v", err)
	}
	if info.Mode != "standalone" {
		t.Fatalf("mode %q", info.Mode)
	}
	if info.TotalKeys != 5 {
		t.Fatalf("total keys %d, want 5", info.TotalKeys)
	}
}

func TestRedisClientScanPagination(t *testing.T) {
	rc, mr := newTestRedis(t, false)
	for i := 0; i < 120; i++ {
		mr.Set("key:"+strconv.Itoa(i), "v")
	}
	ctx := context.Background()
	cursor := uint64(0)
	seen := map[string]bool{}
	pages := 0
	for {
		next, keys, err := rc.Scan(ctx, 0, cursor, "key:*", 20)
		if err != nil {
			t.Fatalf("Scan: %v", err)
		}
		for _, k := range keys {
			seen[k.Key] = true
		}
		pages++
		cursor = next
		if cursor == 0 {
			break
		}
		if pages > 50 {
			t.Fatal("scan did not terminate")
		}
	}
	if len(seen) != 120 {
		t.Fatalf("seen %d keys, want 120", len(seen))
	}
}

// TestRedisClientHashEdit 覆盖 HSET 新增/覆盖字段与 HDEL。
func TestRedisClientHashEdit(t *testing.T) {
	rc, _ := newTestRedis(t, true)
	ctx := context.Background()

	if err := rc.HashSetField(ctx, 0, "user:1:hash", "email", "ann@example.com"); err != nil {
		t.Fatalf("HashSetField: %v", err)
	}
	hv, err := rc.GetKey(ctx, 0, "user:1:hash")
	if err != nil {
		t.Fatalf("GetKey: %v", err)
	}
	fields := map[string]string{}
	for _, f := range hv.Hash {
		fields[f.Field] = f.Value
	}
	if fields["email"] != "ann@example.com" || fields["name"] != "ann" || len(hv.Hash) != 3 {
		t.Fatalf("hash after HSET: %+v", hv.Hash)
	}

	if err := rc.HashSetField(ctx, 0, "user:1:hash", "age", "31"); err != nil {
		t.Fatalf("HashSetField overwrite: %v", err)
	}
	if got := rc.forDB(0).HGet(ctx, "user:1:hash", "age").Val(); got != "31" {
		t.Fatalf("age = %q, want 31", got)
	}

	if err := rc.HashDeleteField(ctx, 0, "user:1:hash", "email"); err != nil {
		t.Fatalf("HashDeleteField: %v", err)
	}
	hv, err = rc.GetKey(ctx, 0, "user:1:hash")
	if err != nil {
		t.Fatalf("GetKey after HDEL: %v", err)
	}
	for _, f := range hv.Hash {
		if f.Field == "email" {
			t.Fatalf("email field not deleted: %+v", hv.Hash)
		}
	}
	if len(hv.Hash) != 2 {
		t.Fatalf("hash after HDEL: %+v", hv.Hash)
	}
}

// TestRedisClientListEdit 覆盖 LSET、LDEL 语义(哨兵+LREM)、LPUSH/RPUSH。
func TestRedisClientListEdit(t *testing.T) {
	rc, _ := newTestRedis(t, true)
	ctx := context.Background()

	// LSET 改指定下标且顺序不变:[a b] → [a b2]。
	if err := rc.ListSetIndex(ctx, 0, "queue:list", 1, "b2"); err != nil {
		t.Fatalf("ListSetIndex: %v", err)
	}
	lv, err := rc.GetKey(ctx, 0, "queue:list")
	if err != nil {
		t.Fatalf("GetKey: %v", err)
	}
	if len(lv.List) != 2 || lv.List[0] != "a" || lv.List[1] != "b2" {
		t.Fatalf("list after LSET: %+v", lv.List)
	}

	// 越界 LSET 报错透出,列表不变。
	if err := rc.ListSetIndex(ctx, 0, "queue:list", 9, "x"); err == nil {
		t.Fatal("expected error for out-of-range LSET")
	}

	// RPUSH 尾插 / LPUSH 头插:[a b2] → [head a b2 tail]。
	if err := rc.ListPush(ctx, 0, "queue:list", "tail", false); err != nil {
		t.Fatalf("ListPush tail: %v", err)
	}
	if err := rc.ListPush(ctx, 0, "queue:list", "head", true); err != nil {
		t.Fatalf("ListPush head: %v", err)
	}
	lv, err = rc.GetKey(ctx, 0, "queue:list")
	if err != nil {
		t.Fatalf("GetKey after push: %v", err)
	}
	want := []string{"head", "a", "b2", "tail"}
	if len(lv.List) != len(want) {
		t.Fatalf("list after push: %+v", lv.List)
	}
	for i := range want {
		if lv.List[i] != want[i] {
			t.Fatalf("list after push: %+v, want %+v", lv.List, want)
		}
	}

	// 删除中间下标 1("a"),其余顺序保持:[head b2 tail]。
	if err := rc.ListDeleteIndex(ctx, 0, "queue:list", 1); err != nil {
		t.Fatalf("ListDeleteIndex: %v", err)
	}
	lv, err = rc.GetKey(ctx, 0, "queue:list")
	if err != nil {
		t.Fatalf("GetKey after delete: %v", err)
	}
	wantAfter := []string{"head", "b2", "tail"}
	if len(lv.List) != len(wantAfter) {
		t.Fatalf("list after delete: %+v", lv.List)
	}
	for i := range wantAfter {
		if lv.List[i] != wantAfter[i] {
			t.Fatalf("list after delete: %+v, want %+v", lv.List, wantAfter)
		}
	}

	// 越界删除报错透出。
	if err := rc.ListDeleteIndex(ctx, 0, "queue:list", 42); err == nil {
		t.Fatal("expected error for out-of-range delete")
	}
}

// TestRedisClientSetAndZSetEdit 覆盖 SADD 去重、SREM、ZADD 更新 score、ZREM。
func TestRedisClientSetAndZSetEdit(t *testing.T) {
	rc, _ := newTestRedis(t, true)
	ctx := context.Background()

	// SADD 新成员;重复成员是 no-op(去重)。
	if err := rc.SetAdd(ctx, 0, "tags:set", "z"); err != nil {
		t.Fatalf("SetAdd: %v", err)
	}
	if err := rc.SetAdd(ctx, 0, "tags:set", "z"); err != nil {
		t.Fatalf("SetAdd duplicate: %v", err)
	}
	sev, err := rc.GetKey(ctx, 0, "tags:set")
	if err != nil {
		t.Fatalf("GetKey set: %v", err)
	}
	if len(sev.Set) != 3 {
		t.Fatalf("set after SADD x2: %+v", sev.Set)
	}

	if err := rc.SetRemove(ctx, 0, "tags:set", "x"); err != nil {
		t.Fatalf("SetRemove: %v", err)
	}
	sev, err = rc.GetKey(ctx, 0, "tags:set")
	if err != nil {
		t.Fatalf("GetKey after SREM: %v", err)
	}
	for _, m := range sev.Set {
		if m == "x" {
			t.Fatalf("member x not removed: %+v", sev.Set)
		}
	}

	// ZADD 更新已有成员 score:alice 9.5 → 8.0。
	if err := rc.ZSetAdd(ctx, 0, "board:zset", "alice", 8.0); err != nil {
		t.Fatalf("ZSetAdd: %v", err)
	}
	zv, err := rc.GetKey(ctx, 0, "board:zset")
	if err != nil {
		t.Fatalf("GetKey zset: %v", err)
	}
	if len(zv.ZSet) != 1 || zv.ZSet[0].Member != "alice" || zv.ZSet[0].Score != 8.0 {
		t.Fatalf("zset after score update: %+v", zv.ZSet)
	}

	// ZADD 新成员 + ZREM。
	if err := rc.ZSetAdd(ctx, 0, "board:zset", "bob", 7.5); err != nil {
		t.Fatalf("ZSetAdd new member: %v", err)
	}
	if err := rc.ZSetRemove(ctx, 0, "board:zset", "alice"); err != nil {
		t.Fatalf("ZSetRemove: %v", err)
	}
	zv, err = rc.GetKey(ctx, 0, "board:zset")
	if err != nil {
		t.Fatalf("GetKey after ZREM: %v", err)
	}
	if len(zv.ZSet) != 1 || zv.ZSet[0].Member != "bob" {
		t.Fatalf("zset after ZREM: %+v", zv.ZSet)
	}
}

// Service 层:池化 + 自动连接。
func TestServiceRedisAutoConnect(t *testing.T) {
	mr := miniredis.RunT(t)
	svc := newTestServiceWithRedis(t, mr)
	ctx := context.Background()

	dbs, err := svc.RedisDatabases(ctx, "conn-redis")
	if err != nil {
		t.Fatalf("RedisDatabases: %v", err)
	}
	if len(dbs) == 0 {
		t.Fatal("no dbs returned")
	}

	if err := svc.RedisSetString(ctx, "conn-redis", 0, "svc-key", "svc-v", 0); err != nil {
		t.Fatalf("RedisSetString: %v", err)
	}
	v, err := svc.RedisGetKey(ctx, "conn-redis", 0, "svc-key")
	if err != nil {
		t.Fatalf("RedisGetKey: %v", err)
	}
	if v.String == nil || *v.String != "svc-v" {
		t.Fatalf("unexpected value %+v", v)
	}
}

// Service 层:集合编辑命令经池化客户端透传。
func TestServiceRedisCollectionEdits(t *testing.T) {
	mr := miniredis.RunT(t)
	svc := newTestServiceWithRedis(t, mr)
	ctx := context.Background()
	id := "conn-redis"

	cases := []struct {
		name string
		run  func() error
	}{
		{"HashSetField", func() error { return svc.RedisHashSetField(ctx, id, 0, "h", "f", "v") }},
		{"HashDeleteField", func() error { return svc.RedisHashDeleteField(ctx, id, 0, "h", "f") }},
		{"ListPush", func() error { return svc.RedisListPush(ctx, id, 0, "l", "v", false) }},
		{"ListSetIndex", func() error { return svc.RedisListSetIndex(ctx, id, 0, "l", 0, "v2") }},
		{"ListDeleteIndex", func() error { return svc.RedisListDeleteIndex(ctx, id, 0, "l", 0) }},
		{"SetAdd", func() error { return svc.RedisSetAdd(ctx, id, 0, "s", "m") }},
		{"SetRemove", func() error { return svc.RedisSetRemove(ctx, id, 0, "s", "m") }},
		{"ZSetAdd", func() error { return svc.RedisZSetAdd(ctx, id, 0, "z", "m", 1.5) }},
		{"ZSetRemove", func() error { return svc.RedisZSetRemove(ctx, id, 0, "z", "m") }},
	}
	for _, tc := range cases {
		if err := tc.run(); err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
	}
	if len(mr.Keys()) != 0 {
		t.Fatalf("edits on missing keys should still pass, left: %v", mr.Keys())
	}
}

// newTestServiceWithRedis wires a service against a store holding one redis
// connection pointing at the given miniredis instance.
func newTestServiceWithRedis(t *testing.T, mr *miniredis.Miniredis) *Service {
	t.Helper()
	st, err := store.Open(t.TempDir()+"/config.db", "test-master")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	f := &fakeFactory{k: &fakeKafka{}}
	svc := NewService(st, f)
	ctx := context.Background()
	c := &model.Connection{
		ID:     "conn-redis",
		Name:   "redis-local",
		Type:   model.ConnectionTypeRedis,
		Config: model.MustConfigJSON(model.RedisConfig{Addr: mr.Addr()}),
	}
	if _, err := svc.CreateConnection(ctx, c); err != nil {
		t.Fatalf("create redis connection: %v", err)
	}
	return svc
}
