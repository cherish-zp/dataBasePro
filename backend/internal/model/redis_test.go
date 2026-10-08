package model

import (
	"encoding/json"
	"strings"
	"testing"
)

func redisConfigJSON(addr string, db int) string {
	b, _ := json.Marshal(map[string]any{"addr": addr, "password": "pw", "db": db})
	return string(b)
}

func TestRedisConfigValidate(t *testing.T) {
	cases := []struct {
		name    string
		addr    string
		db      int
		wantErr string
	}{
		{"valid", "127.0.0.1:6379", 0, ""},
		{"valid with db", "redis.internal:6380", 3, ""},
		{"missing addr", "", 0, "addr"},
		{"addr without port", "127.0.0.1", 0, "host:port"},
		{"negative db", "127.0.0.1:6379", -1, "DB"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cfg := RedisConfig{Addr: c.addr, Password: "pw", DB: c.db}
			err := cfg.Validate()
			if c.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Fatalf("expected error containing %q, got %v", c.wantErr, err)
			}
		})
	}
}

// 连接校验按 Type 分派:redis 类型连接的 config 必须能按 RedisConfig 校验。
func TestConnectionValidateRedisBranch(t *testing.T) {
	valid := Connection{
		Name:   "redis-local",
		Type:   ConnectionTypeRedis,
		Config: json.RawMessage(redisConfigJSON("127.0.0.1:6379", 0)),
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid redis connection rejected: %v", err)
	}

	invalid := Connection{
		Name:   "redis-bad",
		Type:   ConnectionTypeRedis,
		Config: json.RawMessage(redisConfigJSON("127.0.0.1", 0)),
	}
	if err := invalid.Validate(); err == nil || !strings.Contains(err.Error(), "host:port") {
		t.Fatalf("expected addr error, got %v", err)
	}
}

// KafkaConfig json 也必须能通过 RawMessage 承载(存量兼容)。
func TestConnectionConfigRawMessageCarriesKafka(t *testing.T) {
	cfgJSON, _ := json.Marshal(KafkaConfig{BootstrapServers: []string{"b:9092"}})
	conn := Connection{
		Name:   "k",
		Type:   ConnectionTypeKafka,
		Config: json.RawMessage(cfgJSON),
	}
	if err := conn.Validate(); err != nil {
		t.Fatalf("kafka via RawMessage rejected: %v", err)
	}
}

// redis 类型连接校验拒绝空 config。
func TestConnectionValidateRedisEmptyConfig(t *testing.T) {
	conn := Connection{Name: "r", Type: ConnectionTypeRedis}
	if err := conn.Validate(); err == nil {
		t.Fatal("empty redis config must fail")
	}
}

// redis 类型连接校验拒绝 kafkashape config(类型不匹配)。
func TestConnectionValidateRedisWrongShape(t *testing.T) {
	kafkaShape, _ := json.Marshal(KafkaConfig{BootstrapServers: []string{"b:9092"}})
	conn := Connection{Name: "r", Type: ConnectionTypeRedis, Config: json.RawMessage(kafkaShape)}
	if err := conn.Validate(); err == nil {
		t.Fatal("kafka-shaped config under redis type must fail validation")
	}
}
