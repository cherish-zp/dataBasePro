package model

import (
	"errors"
	"fmt"
	"net"
	"strings"
)

// RedisConfig holds the connection settings for a Redis data source.
// 集群 vs 单机不靠用户选择:客户端连接后通过 INFO cluster_enabled 自动
// 探测;Addr 支持逗号分隔多个种子地址(集群时全部作为 seeds)。
type RedisConfig struct {
	Addr     string `json:"addr"`
	Password string `json:"password,omitempty"`
	DB       int    `json:"db"`
	TLS      bool   `json:"tls,omitempty"`
}

// Validate checks the Redis configuration for obvious errors.
func (c RedisConfig) Validate() error {
	addr := strings.TrimSpace(c.Addr)
	if addr == "" {
		return errors.New("redis addr must not be empty")
	}
	for _, a := range strings.Split(addr, ",") {
		if _, _, err := net.SplitHostPort(strings.TrimSpace(a)); err != nil {
			return fmt.Errorf("invalid redis addr %q (expected host:port): %w", a, err)
		}
	}
	if c.DB < 0 {
		return errors.New("redis DB must be >= 0")
	}
	return nil
}

// RedisDBInfo describes one logical database of a Redis instance (standalone
// only; clusters always report just db0).
type RedisDBInfo struct {
	Index int   `json:"index"`
	Keys  int64 `json:"keys"`
}

// RedisKeyInfo is one entry of the key listing.
type RedisKeyInfo struct {
	Key        string `json:"key"`
	Type       string `json:"type"`
	TTLSeconds int64  `json:"ttl_seconds"` // -1 无过期,-2 不存在
	SizeBytes  int64  `json:"size_bytes"`  // MEMORY USAGE(含自身开销),0 = 不可用
}

// HashField is one field of a hash value.
type HashField struct {
	Field string `json:"field"`
	Value string `json:"value"`
}

// ZSetMember is one member of a sorted set.
type ZSetMember struct {
	Member string  `json:"member"`
	Score  float64 `json:"score"`
}

// RedisValue is the typed value of a key; exactly one payload field is set.
type RedisValue struct {
	Key        string      `json:"key"`
	Type       string      `json:"type"`
	TTLSeconds int64       `json:"ttl_seconds"`
	String     *string     `json:"string,omitempty"`
	Truncated  bool        `json:"truncated,omitempty"` // String 值超过截断阈值
	SizeBytes  int64       `json:"size_bytes,omitempty"`
	Hash       []HashField `json:"hash,omitempty"`
	List       []string    `json:"list,omitempty"`
	Set        []string    `json:"set,omitempty"`
	ZSet       []ZSetMember `json:"zset,omitempty"`
}

// RedisNodeInfo describes one node of a Redis cluster.
type RedisNodeInfo struct {
	Addr string `json:"addr"`
	Role string `json:"role"` // master | replica
}

// RedisServerInfo is the overview shown atop the key browser.
type RedisServerInfo struct {
	Mode             string          `json:"mode"` // standalone | cluster
	UsedMemoryHuman  string          `json:"used_memory_human"`
	MaxMemoryHuman   string          `json:"maxmemory_human,omitempty"`
	ConnectedClients int64           `json:"connected_clients"`
	TotalKeys        int64           `json:"total_keys"`
	HitRate          *float64        `json:"hit_rate,omitempty"`
	Nodes            []RedisNodeInfo `json:"nodes,omitempty"`
}
