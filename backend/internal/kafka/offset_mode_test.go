package kafka

import (
	"context"
	"testing"

	"dataBasePro/backend/internal/model"
)

// Explicit offsets are committed verbatim: after resetting partition 0 to
// offset 2 of a 5-record log, the group's lag on the topic must be 3.
func TestResetConsumerGroupOffsetToExplicitOffsets(t *testing.T) {
	c := newCluster(t, 1, "t1")
	cl := newKafkaClient(t, c)

	ctx := context.Background()
	if err := cl.Connect(ctx); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	seedMessages(t, c, "t1", 0, 5, 0)

	if err := cl.ResetConsumerGroupOffset(ctx, "g1", "t1", model.ResetOffsetExplicit, 0, map[int32]int64{0: 2}); err != nil {
		t.Fatalf("ResetConsumerGroupOffset offset mode: %v", err)
	}
	lag, err := cl.GetPartitionLag(ctx, "t1", "g1")
	if err != nil {
		t.Fatalf("GetPartitionLag: %v", err)
	}
	if lag[0] != 3 {
		t.Fatalf("expected lag 3 after resetting to offset 2, got %d", lag[0])
	}
}

func TestResetConsumerGroupOffsetExplicitRequiresOffsets(t *testing.T) {
	c := newCluster(t, 1, "t1")
	cl := newKafkaClient(t, c)

	ctx := context.Background()
	if err := cl.Connect(ctx); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if err := cl.ResetConsumerGroupOffset(ctx, "g1", "t1", model.ResetOffsetExplicit, 0, nil); err == nil {
		t.Fatal("expected offset mode without offsets to fail, got nil")
	}
}
