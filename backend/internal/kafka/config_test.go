package kafka

import (
	"context"
	"strings"
	"testing"

	"dataBasePro/backend/internal/model"
)

// TestAlterTopicConfigRoundTrip alters a whitelisted config and re-describes
// the topic to assert the new value is visible — the acceptance criterion for
// config editing.
func TestAlterTopicConfigRoundTrip(t *testing.T) {
	c := newCluster(t, 1, "cfg-topic")
	cl := newKafkaClient(t, c)
	ctx := context.Background()

	err := cl.AlterTopicConfig(ctx, "cfg-topic", []model.TopicConfigEntry{
		{Key: "retention.ms", Value: "123456789"},
	})
	if err != nil {
		t.Fatalf("AlterTopicConfig: %v", err)
	}

	d, err := cl.DescribeTopic(ctx, "cfg-topic")
	if err != nil {
		t.Fatalf("DescribeTopic: %v", err)
	}
	cfg := map[string]string{}
	for _, e := range d.Configs {
		cfg[e.Key] = e.Value
	}
	if cfg["retention.ms"] != "123456789" {
		t.Fatalf("expected altered retention.ms 123456789, got configs %+v", cfg)
	}
}

// TestAlterTopicConfigRejectsUnknownKey pins the whitelist enforcement: any
// key outside describeTopicConfigKeys fails the whole call (naming the key)
// and no alter is issued.
func TestAlterTopicConfigRejectsUnknownKey(t *testing.T) {
	c := newCluster(t, 1, "cfg-topic")
	cl := newKafkaClient(t, c)
	ctx := context.Background()

	err := cl.AlterTopicConfig(ctx, "cfg-topic", []model.TopicConfigEntry{
		{Key: "retention.ms", Value: "123456789"},
		{Key: "compression.type", Value: "producer"}, // not whitelisted
	})
	if err == nil {
		t.Fatal("expected an error for a non-whitelisted config key")
	}
	if !strings.Contains(err.Error(), "compression.type") {
		t.Fatalf("expected the error to name the offending key, got %v", err)
	}

	// The whitelist violation must be rejected before any alter is issued.
	d, err := cl.DescribeTopic(ctx, "cfg-topic")
	if err != nil {
		t.Fatalf("DescribeTopic: %v", err)
	}
	cfg := map[string]string{}
	for _, e := range d.Configs {
		cfg[e.Key] = e.Value
	}
	if cfg["retention.ms"] == "123456789" {
		t.Fatal("whitelist rejection must not alter any config")
	}
}

// TestAlterTopicConfigRejectsEmptyEntries pins that an empty entry list fails
// without issuing any alter.
func TestAlterTopicConfigRejectsEmptyEntries(t *testing.T) {
	c := newCluster(t, 1, "cfg-topic")
	cl := newKafkaClient(t, c)
	ctx := context.Background()

	if err := cl.AlterTopicConfig(ctx, "cfg-topic", []model.TopicConfigEntry{}); err == nil {
		t.Fatal("expected an error for empty entries")
	}
}

// TestAlterTopicConfigRejectsEmptyValue pins the SET semantics: an empty value
// is refused instead of deleting the config key.
func TestAlterTopicConfigRejectsEmptyValue(t *testing.T) {
	c := newCluster(t, 1, "cfg-topic")
	cl := newKafkaClient(t, c)
	ctx := context.Background()

	err := cl.AlterTopicConfig(ctx, "cfg-topic", []model.TopicConfigEntry{
		{Key: "retention.ms", Value: ""},
	})
	if err == nil {
		t.Fatal("expected an error for an empty config value")
	}
}
