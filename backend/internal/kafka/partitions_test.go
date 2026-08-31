package kafka

import (
	"context"
	"strings"
	"testing"
)

func TestAlterTopicPartitionsSetsFinalCount(t *testing.T) {
	c := newCluster(t, 1, "user-log")
	cl := newKafkaClient(t, c)

	ctx := context.Background()
	if err := cl.Connect(ctx); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if err := cl.AlterTopicPartitions(ctx, "user-log", 3); err != nil {
		t.Fatalf("AlterTopicPartitions: %v", err)
	}
	topics, err := cl.ListTopics(ctx)
	if err != nil {
		t.Fatalf("ListTopics: %v", err)
	}
	for _, tp := range topics {
		if tp.Name != "user-log" {
			continue
		}
		if len(tp.Partitions) != 3 {
			t.Fatalf("topic %s: expected 3 partitions after expand, got %d", tp.Name, len(tp.Partitions))
		}
		return
	}
	t.Fatalf("topic user-log not found after expand")
}

func TestAlterTopicPartitionsRejectsShrink(t *testing.T) {
	c := newCluster(t, 3, "user-log")
	cl := newKafkaClient(t, c)

	ctx := context.Background()
	if err := cl.Connect(ctx); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	err := cl.AlterTopicPartitions(ctx, "user-log", 1)
	if err == nil {
		t.Fatalf("expected shrink to fail, got nil")
	}
	if !strings.Contains(err.Error(), "扩容") {
		t.Fatalf("expected a shrink-specific error, got %v", err)
	}
}

func TestAlterTopicPartitionsRejectsUnchangedCount(t *testing.T) {
	c := newCluster(t, 2, "user-log")
	cl := newKafkaClient(t, c)

	ctx := context.Background()
	if err := cl.Connect(ctx); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if err := cl.AlterTopicPartitions(ctx, "user-log", 2); err == nil {
		t.Fatalf("expected unchanged count to fail, got nil")
	}
}

func TestAlterTopicPartitionsUnknownTopicFails(t *testing.T) {
	c := newCluster(t, 1, "user-log")
	cl := newKafkaClient(t, c)

	ctx := context.Background()
	if err := cl.Connect(ctx); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if err := cl.AlterTopicPartitions(ctx, "missing", 3); err == nil {
		t.Fatalf("expected unknown topic to fail, got nil")
	}
}
