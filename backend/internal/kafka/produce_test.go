package kafka

import (
	"context"
	"testing"

	"dataBasePro/backend/internal/model"
)

// TestProduceMessagesBatch publishes several records in one call and verifies
// the per-message results plus what actually landed in the log.
func TestProduceMessagesBatch(t *testing.T) {
	c := newCluster(t, 2, "batch")
	cl := newKafkaClient(t, c)
	ctx := context.Background()

	msgs := []model.BatchProduceMessage{
		{Key: "k-0", Value: "v-0"},
		{Key: "k-1", Value: "v-1"},
		{Key: "k-2", Value: "v-2"},
	}
	results, err := cl.ProduceMessages(ctx, "batch", 1, msgs)
	if err != nil {
		t.Fatalf("ProduceMessages: %v", err)
	}
	if len(results) != len(msgs) {
		t.Fatalf("expected %d results, got %d: %+v", len(msgs), len(results), results)
	}
	for i, r := range results {
		if r.Index != i {
			t.Fatalf("result %d: expected index %d, got %+v", i, i, r)
		}
		if r.Error != "" {
			t.Fatalf("result %d: unexpected error %q", i, r.Error)
		}
		if r.Partition != 1 {
			t.Fatalf("result %d: expected partition 1, got %d", i, r.Partition)
		}
		if r.Offset != int64(i) {
			t.Fatalf("result %d: expected offset %d, got %d", i, i, r.Offset)
		}
	}

	// Every record must be visible on the target partition, in order.
	got, err := cl.ConsumeMessages(ctx, "batch", 1, model.OffsetEarliest, 10)
	if err != nil {
		t.Fatalf("ConsumeMessages: %v", err)
	}
	if len(got) != len(msgs) {
		t.Fatalf("expected %d consumed records, got %d: %+v", len(msgs), len(got), got)
	}
	for i, m := range got {
		if m.Key != msgs[i].Key || m.Value != msgs[i].Value {
			t.Fatalf("record %d: expected %q/%q, got %q/%q", i, msgs[i].Key, msgs[i].Value, m.Key, m.Value)
		}
		if m.Partition != 1 {
			t.Fatalf("record %d: expected partition 1, got %d", i, m.Partition)
		}
	}
	// The other partition must stay untouched.
	other, err := cl.ConsumeMessages(ctx, "batch", 0, model.OffsetEarliest, 10)
	if err != nil {
		t.Fatalf("ConsumeMessages partition 0: %v", err)
	}
	if len(other) != 0 {
		t.Fatalf("partition 0 must be empty, got %+v", other)
	}
}

// TestProduceMessagesAutoPartition publishes with partition < 0 and expects
// every record to land somewhere without error.
func TestProduceMessagesAutoPartition(t *testing.T) {
	c := newCluster(t, 2, "auto")
	cl := newKafkaClient(t, c)
	ctx := context.Background()

	msgs := []model.BatchProduceMessage{
		{Key: "a", Value: "va"},
		{Key: "b", Value: "vb"},
	}
	results, err := cl.ProduceMessages(ctx, "auto", -1, msgs)
	if err != nil {
		t.Fatalf("ProduceMessages: %v", err)
	}
	for _, r := range results {
		if r.Error != "" {
			t.Fatalf("unexpected per-message error: %+v", r)
		}
	}
	got, err := cl.ConsumeMessages(ctx, "auto", -1, model.OffsetEarliest, 10)
	if err != nil {
		t.Fatalf("ConsumeMessages: %v", err)
	}
	if len(got) != len(msgs) {
		t.Fatalf("expected %d records across partitions, got %d", len(msgs), len(got))
	}
}
