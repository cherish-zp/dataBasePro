package kafka

import (
	"context"
	"testing"
)

// Seed 5 records to partition 0 of a 2-partition topic: both the retained
// count (sum of end-start over partitions) and the total produced count (sum
// of end offsets) must equal 5, because partition 1 sits empty at offset 0.
func TestGetTopicMessageCountsSumsAcrossPartitions(t *testing.T) {
	c := newCluster(t, 2, "user-log")
	cl := newKafkaClient(t, c)

	ctx := context.Background()
	if err := cl.Connect(ctx); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	seedMessages(t, c, "user-log", 0, 5, 0)

	counts, err := cl.GetTopicMessageCounts(ctx, "user-log")
	if err != nil {
		t.Fatalf("GetTopicMessageCounts: %v", err)
	}
	got, ok := counts["user-log"]
	if !ok {
		t.Fatalf("missing counts for user-log: %+v", counts)
	}
	if got.Retained != 5 {
		t.Fatalf("expected retained 5, got %d", got.Retained)
	}
	if got.Total != 5 {
		t.Fatalf("expected total 5, got %d", got.Total)
	}
}

// An empty topic reports zeroes instead of being skipped, so the UI can
// distinguish "0 messages" from "unknown".
func TestGetTopicMessageCountsEmptyTopicIsZero(t *testing.T) {
	c := newCluster(t, 1, "empty")
	cl := newKafkaClient(t, c)

	ctx := context.Background()
	if err := cl.Connect(ctx); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	counts, err := cl.GetTopicMessageCounts(ctx, "empty")
	if err != nil {
		t.Fatalf("GetTopicMessageCounts: %v", err)
	}
	if counts["empty"].Retained != 0 || counts["empty"].Total != 0 {
		t.Fatalf("expected zero counts, got %+v", counts["empty"])
	}
}

// Only the requested topics are returned.
func TestGetTopicMessageCountsOnlyRequestedTopics(t *testing.T) {
	c := newCluster(t, 1, "a", "b")
	cl := newKafkaClient(t, c)

	ctx := context.Background()
	if err := cl.Connect(ctx); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	counts, err := cl.GetTopicMessageCounts(ctx, "a")
	if err != nil {
		t.Fatalf("GetTopicMessageCounts: %v", err)
	}
	if _, exists := counts["b"]; exists {
		t.Fatalf("unexpected counts for unrequested topic b: %+v", counts)
	}
	if _, exists := counts["a"]; !exists {
		t.Fatalf("missing counts for requested topic a: %+v", counts)
	}
}
