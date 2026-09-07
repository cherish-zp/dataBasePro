package service

import (
	"context"
	"crypto/tls"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"dataBasePro/backend/internal/model"
)

// StringTruncateBytes 是 String 值单次拉取的截断阈值:超过则只取前缀,
// RedisValue.Truncated=true,由用户显式加载完整值。
const StringTruncateBytes = 256 * 1024

// RedisClient 是 RedisDataSource 的生产实现,基于 go-redis UniversalClient:
// 构造时通过 INFO cluster_enabled 自动探测原生集群;单机支持多 DB
// (派生库客户端并缓存),集群恒用 db0。
type RedisClient struct {
	client    redis.UniversalClient
	cluster   bool
	baseOpts  *redis.Options
	dbMu      sync.Mutex
	dbClients map[int]redis.UniversalClient
}

// NewRedisClient builds the client, auto-detecting native clusters via
// INFO cluster_enabled on the first seed, and verifies reachability with a
// PING before returning.
func NewRedisClient(cfg model.RedisConfig) (*RedisClient, error) {
	var seeds []string
	for _, a := range strings.Split(cfg.Addr, ",") {
		a = strings.TrimSpace(a)
		if a != "" {
			seeds = append(seeds, a)
		}
	}
	if len(seeds) == 0 {
		return nil, fmt.Errorf("redis addr must not be empty")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// 用单机协议探测首个种子:cluster_enabled:1 → 原生集群。
	probe := redis.NewClient(&redis.Options{
		Addr: seeds[0], Password: cfg.Password, TLSConfig: tlsConfigFor(seeds[0], cfg.TLS),
	})
	cluster := false
	if info, err := probe.Info(ctx, "cluster_enabled").Result(); err == nil && strings.Contains(info, "cluster_enabled:1") {
		cluster = true
	}
	probe.Close()

	if cluster {
		cl := redis.NewClusterClient(&redis.ClusterOptions{
			Addrs: seeds, Password: cfg.Password,
			TLSConfig: tlsConfigFor(seeds[0], cfg.TLS),
		})
		if err := cl.Ping(ctx).Err(); err != nil {
			cl.Close()
			return nil, fmt.Errorf("redis cluster ping: %w", err)
		}
		return &RedisClient{client: cl, cluster: true}, nil
	}

	base := &redis.Options{
		Addr: seeds[0], Password: cfg.Password, DB: cfg.DB,
		TLSConfig: tlsConfigFor(seeds[0], cfg.TLS),
	}
	cl := redis.NewClient(base)
	if err := cl.Ping(ctx).Err(); err != nil {
		cl.Close()
		return nil, fmt.Errorf("redis ping: %w", err)
	}
	return &RedisClient{client: cl, cluster: false, baseOpts: base}, nil
}

// tlsConfigFor returns the TLS config when enabled; ServerName is derived
// from the host so name verification works with host:port addresses.
func tlsConfigFor(addr string, enabled bool) *tls.Config {
	if !enabled {
		return nil
	}
	host := addr
	if i := strings.LastIndex(addr, ":"); i > 0 {
		host = addr[:i]
	}
	return &tls.Config{ServerName: host}
}

// forDB returns the client bound to the given logical DB. Clusters always
// use db0; standalone derives (and caches) one client per non-zero DB.
func (c *RedisClient) forDB(db int) redis.UniversalClient {
	if c.cluster || db == 0 || c.baseOpts == nil {
		return c.client
	}
	c.dbMu.Lock()
	defer c.dbMu.Unlock()
	if c.dbClients == nil {
		c.dbClients = map[int]redis.UniversalClient{}
	}
	if cl, ok := c.dbClients[db]; ok {
		return cl
	}
	opts := *c.baseOpts
	opts.DB = db
	cl := redis.NewClient(&opts)
	c.dbClients[db] = cl
	return cl
}

// GetName returns the connection name.
func (c *RedisClient) GetName() string { return "redis" }

// GetType returns the data source type.
func (c *RedisClient) GetType() string { return "redis" }

// Connect pings the server (the constructor already verified reachability).
func (c *RedisClient) Connect(ctx context.Context) error {
	return c.Ping(ctx)
}

// Close releases the underlying connections.
func (c *RedisClient) Close() error {
	c.dbMu.Lock()
	for _, cl := range c.dbClients {
		cl.Close()
	}
	c.dbClients = nil
	c.dbMu.Unlock()
	return c.client.Close()
}

// Ping verifies reachability.
func (c *RedisClient) Ping(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return c.client.Ping(ctx).Err()
}

// IsCluster reports whether the server was detected as a native cluster.
func (c *RedisClient) IsCluster() bool { return c.cluster }

// Databases lists the logical DBs: standalone parses CONFIG GET databases
// and the keyspace section for per-DB key counts; clusters always report
// db0 only.
func (c *RedisClient) Databases(ctx context.Context) ([]model.RedisDBInfo, error) {
	if c.cluster {
		keys, err := c.totalKeys(ctx)
		if err != nil {
			return nil, err
		}
		return []model.RedisDBInfo{{Index: 0, Keys: keys}}, nil
	}
	cl, ok := c.client.(*redis.Client)
	if !ok {
		return nil, fmt.Errorf("unexpected redis client type")
	}
	dbCount := 16
	if v, err := cl.ConfigGet(ctx, "databases").Result(); err == nil {
		if n, err := strconv.Atoi(v["databases"]); err == nil && n > 0 {
			dbCount = n
		}
	}
	perDB := map[int]int64{}
	if info, err := cl.Info(ctx, "keyspace").Result(); err == nil {
		for _, line := range strings.Split(info, "\r\n") {
			if !strings.HasPrefix(line, "db") || !strings.Contains(line, "keys=") {
				continue
			}
			idxStr := strings.TrimPrefix(line, "db")
			idxStr = idxStr[:strings.Index(idxStr, ":")]
			idx, err := strconv.Atoi(idxStr)
			if err != nil {
				continue
			}
			perDB[idx] = parseKeysCount(line)
		}
	}
	out := make([]model.RedisDBInfo, 0, dbCount)
	for i := 0; i < dbCount; i++ {
		out = append(out, model.RedisDBInfo{Index: i, Keys: perDB[i]})
	}
	return out, nil
}

// parseKeysCount extracts the keys=N value from a keyspace line.
func parseKeysCount(line string) int64 {
	i := strings.Index(line, "keys=")
	if i < 0 {
		return 0
	}
	rest := line[i+len("keys="):]
	if j := strings.Index(rest, ","); j >= 0 {
		rest = rest[:j]
	}
	n, _ := strconv.ParseInt(rest, 10, 64)
	return n
}

// totalKeys returns the number of keys via DBSIZE (clusters broadcast it).
func (c *RedisClient) totalKeys(ctx context.Context) (int64, error) {
	return c.client.DBSize(ctx).Result()
}

// Scan pages the key space: cursor round-trips through the caller, match is
// the server-side glob filter, count is the SCAN batch hint.
func (c *RedisClient) Scan(ctx context.Context, db int, cursor uint64, match string, count int64) (uint64, []model.RedisKeyInfo, error) {
	if match == "" {
		match = "*"
	}
	if count <= 0 {
		count = 50
	}
	cl := c.forDB(db)
	keyNames, next, err := cl.Scan(ctx, cursor, match, count).Result()
	if err != nil {
		return 0, nil, err
	}
	pipe := cl.Pipeline()
	typeCmds := make([]*redis.StatusCmd, len(keyNames))
	ttlCmds := make([]*redis.DurationCmd, len(keyNames))
	memCmds := make([]*redis.IntCmd, len(keyNames))
	for i, k := range keyNames {
		typeCmds[i] = pipe.Type(ctx, k)
		ttlCmds[i] = pipe.TTL(ctx, k)
		memCmds[i] = pipe.MemoryUsage(ctx, k)
	}
	if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
		return 0, nil, err
	}
	infos := make([]model.RedisKeyInfo, len(keyNames))
	for i, k := range keyNames {
		infos[i] = model.RedisKeyInfo{
			Key:        k,
			Type:       typeCmds[i].Val(),
			TTLSeconds: int64(ttlCmds[i].Val().Seconds()),
			SizeBytes:  memCmds[i].Val(),
		}
	}
	return next, infos, nil
}

// GetKey loads a key's value in its own type. String values beyond
// StringTruncateBytes are truncated (Truncated=true) until explicitly fully
// loaded.
func (c *RedisClient) GetKey(ctx context.Context, db int, key string) (model.RedisValue, error) {
	cl := c.forDB(db)
	typ, err := cl.Type(ctx, key).Result()
	if err != nil {
		return model.RedisValue{}, err
	}
	ttl, err := cl.TTL(ctx, key).Result()
	if err != nil {
		return model.RedisValue{}, err
	}
	out := model.RedisValue{Key: key, Type: typ, TTLSeconds: int64(ttl.Seconds())}
	switch typ {
	case "string":
		if n, serr := cl.StrLen(ctx, key).Result(); serr == nil {
			out.SizeBytes = n
		}
		if out.SizeBytes > StringTruncateBytes {
			prefix, gerr := cl.GetRange(ctx, key, 0, StringTruncateBytes-1).Result()
			if gerr != nil {
				return model.RedisValue{}, gerr
			}
			s := prefix
			out.String = &s
			out.Truncated = true
		} else {
			s, gerr := cl.Get(ctx, key).Result()
			if gerr != nil {
				return model.RedisValue{}, gerr
			}
			out.String = &s
		}
	case "hash":
		m, herr := cl.HGetAll(ctx, key).Result()
		if herr != nil {
			return model.RedisValue{}, herr
		}
		for f, v := range m {
			out.Hash = append(out.Hash, model.HashField{Field: f, Value: v})
		}
	case "list":
		l, lerr := cl.LRange(ctx, key, 0, -1).Result()
		if lerr != nil {
			return model.RedisValue{}, lerr
		}
		out.List = l
	case "set":
		s, serr := cl.SMembers(ctx, key).Result()
		if serr != nil {
			return model.RedisValue{}, serr
		}
		out.Set = s
	case "zset":
		zs, zerr := cl.ZRangeWithScores(ctx, key, 0, -1).Result()
		if zerr != nil {
			return model.RedisValue{}, zerr
		}
		for _, z := range zs {
			out.ZSet = append(out.ZSet, model.ZSetMember{Member: z.Member.(string), Score: z.Score})
		}
	default:
		return model.RedisValue{}, fmt.Errorf("不支持的键类型 %q", typ)
	}
	return out, nil
}

// RenameKey renames a key.
func (c *RedisClient) RenameKey(ctx context.Context, db int, from, to string) error {
	return c.forDB(db).Rename(ctx, from, to).Err()
}

// DeleteKeys deletes the given keys and returns how many were removed.
func (c *RedisClient) DeleteKeys(ctx context.Context, db int, keys []string) (int64, error) {
	return c.forDB(db).Del(ctx, keys...).Result()
}

// SetTTL applies an expiry in seconds; ttlSeconds <= 0 removes it (PERSIST).
func (c *RedisClient) SetTTL(ctx context.Context, db int, key string, ttlSeconds int64) error {
	if ttlSeconds > 0 {
		return c.forDB(db).Expire(ctx, key, time.Duration(ttlSeconds)*time.Second).Err()
	}
	return c.forDB(db).Persist(ctx, key).Err()
}

// SetString writes a string key with an optional expiry in seconds.
func (c *RedisClient) SetString(ctx context.Context, db int, key, value string, ttlSeconds int64) error {
	if ttlSeconds > 0 {
		return c.forDB(db).Set(ctx, key, value, time.Duration(ttlSeconds)*time.Second).Err()
	}
	return c.forDB(db).Set(ctx, key, value, 0).Err()
}

// HashSetField writes one field of a hash key (HSET).
func (c *RedisClient) HashSetField(ctx context.Context, db int, key, field, value string) error {
	return c.forDB(db).HSet(ctx, key, field, value).Err()
}

// HashDeleteField removes one field from a hash key (HDEL).
func (c *RedisClient) HashDeleteField(ctx context.Context, db int, key, field string) error {
	return c.forDB(db).HDel(ctx, key, field).Err()
}

// ListSetIndex overwrites the element at the given index (LSET); a missing
// key or out-of-range index surfaces the server error.
func (c *RedisClient) ListSetIndex(ctx context.Context, db int, key string, index int64, value string) error {
	if err := c.forDB(db).LSet(ctx, key, index, value).Err(); err != nil {
		return fmt.Errorf("设置列表下标 %d 失败(键不存在或下标越界): %w", index, err)
	}
	return nil
}

// ListPush prepends (atHead, LPUSH) or appends (RPUSH) one element.
func (c *RedisClient) ListPush(ctx context.Context, db int, key, value string, atHead bool) error {
	if atHead {
		return c.forDB(db).LPush(ctx, key, value).Err()
	}
	return c.forDB(db).RPush(ctx, key, value).Err()
}

// ListDeleteIndex removes the element at the given index. Redis has no LDEL,
// so a unique sentinel value is written via LSET and then removed with
// LREM count=1; missing key / out-of-range errors surface from LSET.
func (c *RedisClient) ListDeleteIndex(ctx context.Context, db int, key string, index int64) error {
	cl := c.forDB(db)
	sentinel := fmt.Sprintf("__deleted__%d", time.Now().UnixNano())
	if err := cl.LSet(ctx, key, index, sentinel).Err(); err != nil {
		return fmt.Errorf("删除列表下标 %d 失败(键不存在或下标越界): %w", index, err)
	}
	return cl.LRem(ctx, key, 1, sentinel).Err()
}

// SetAdd inserts a member (SADD; duplicates are idempotent).
func (c *RedisClient) SetAdd(ctx context.Context, db int, key, member string) error {
	return c.forDB(db).SAdd(ctx, key, member).Err()
}

// SetRemove deletes a member (SREM).
func (c *RedisClient) SetRemove(ctx context.Context, db int, key, member string) error {
	return c.forDB(db).SRem(ctx, key, member).Err()
}

// ZSetAdd inserts a member or updates its score (ZADD).
func (c *RedisClient) ZSetAdd(ctx context.Context, db int, key, member string, score float64) error {
	return c.forDB(db).ZAdd(ctx, key, redis.Z{Score: score, Member: member}).Err()
}

// ZSetRemove deletes a member (ZREM).
func (c *RedisClient) ZSetRemove(ctx context.Context, db int, key, member string) error {
	return c.forDB(db).ZRem(ctx, key, member).Err()
}

// FlushDB removes all keys of the given DB.
func (c *RedisClient) FlushDB(ctx context.Context, db int) error {
	return c.forDB(db).FlushDB(ctx).Err()
}

// FlushAll removes all keys of the whole instance/cluster.
func (c *RedisClient) FlushAll(ctx context.Context) error {
	return c.client.FlushAll(ctx).Err()
}

// ServerInfo builds the overview: mode, memory, clients, total keys and hit
// rate (from INFO memory/stats/clients/keyspace).
func (c *RedisClient) ServerInfo(ctx context.Context) (model.RedisServerInfo, error) {
	info, err := c.client.Info(ctx).Result()
	if err != nil {
		return model.RedisServerInfo{}, err
	}
	fields := parseInfoSections(info)
	out := model.RedisServerInfo{
		Mode:            "standalone",
		UsedMemoryHuman: fields["used_memory_human"],
		MaxMemoryHuman:  fields["maxmemory_human"],
	}
	if c.cluster {
		out.Mode = "cluster"
	}
	out.UsedMemoryHuman = strings.TrimSpace(out.UsedMemoryHuman)
	out.MaxMemoryHuman = strings.TrimSpace(out.MaxMemoryHuman)
	out.ConnectedClients, _ = strconv.ParseInt(fields["connected_clients"], 10, 64)
	if total, terr := c.totalKeys(ctx); terr == nil {
		out.TotalKeys = total
	}
	hits, _ := strconv.ParseInt(fields["keyspace_hits"], 10, 64)
	misses, _ := strconv.ParseInt(fields["keyspace_misses"], 10, 64)
	if hits+misses > 0 {
		rate := float64(hits) / float64(hits+misses)
		out.HitRate = &rate
	}
	if c.cluster {
		if raw, nerr := c.clusterNodes(ctx); nerr == nil {
			out.Nodes = raw
		}
	}
	return out, nil
}

// clusterNodes parses CLUSTER NODES into per-node address/role pairs.
func (c *RedisClient) clusterNodes(ctx context.Context) ([]model.RedisNodeInfo, error) {
	cl, ok := c.client.(*redis.ClusterClient)
	if !ok {
		return nil, fmt.Errorf("not a cluster client")
	}
	raw, err := cl.ClusterNodes(ctx).Result()
	if err != nil {
		return nil, err
	}
	var out []model.RedisNodeInfo
	for _, line := range strings.Split(raw, "\n") {
		f := strings.Fields(line)
		if len(f) < 3 {
			continue
		}
		role := "replica"
		if strings.Contains(f[2], "master") {
			role = "master"
		}
		addr := f[1]
		if i := strings.LastIndex(addr, "@"); i > 0 {
			addr = addr[:i]
		}
		out = append(out, model.RedisNodeInfo{Addr: addr, Role: role})
	}
	return out, nil
}

// parseInfoSections flattens the CRLF-separated INFO payload into a map.
func parseInfoSections(info string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(info, "\r\n") {
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if i := strings.Index(line, ":"); i > 0 {
			out[line[:i]] = line[i+1:]
		}
	}
	return out
}
