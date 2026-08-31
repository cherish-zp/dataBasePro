package kafka

import (
	"context"
	"testing"
	"time"

	"dataBasePro/backend/internal/model"
)

// These cases bind a local loopback port via kfake, so they are compile-only in
// the sandbox and run at the batch gate (see verify-b3.sh).

func TestPreviewResetOffsetEarliestReturnsLogStart(t *testing.T) {
	c := newCluster(t, 1, "t1")
	seedMessages(t, c, "t1", 0, 10, 0)
	cl := newKafkaClient(t, c)

	got, err := cl.PreviewResetOffset(context.Background(), "t1", model.ResetOffsetEarliest, 0)
	if err != nil {
		t.Fatalf("PreviewResetOffset earliest: %v", err)
	}
	if got[0] != 0 {
		t.Fatalf("expected log start offset 0, got %d", got[0])
	}
}

func TestPreviewResetOffsetByTimestampReturnsMatchingOffset(t *testing.T) {
	c := newCluster(t, 1, "t1")
	base := time.Now().Add(-time.Hour).UnixMilli()
	seedMessages(t, c, "t1", 0, 10, base)
	cl := newKafkaClient(t, c)

	// Messages are at base, base+1s, ..., base+9s; the first offset at or
	// after base+5s is offset 5 (mirrors ResetConsumerGroupOffsetByTimestamp).
	got, err := cl.PreviewResetOffset(context.Background(), "t1", model.ResetOffsetTime, base+5000)
	if err != nil {
		t.Fatalf("PreviewResetOffset by timestamp: %v", err)
	}
	if got[0] != 5 {
		t.Fatalf("expected offset 5 at or after base+5s, got %d", got[0])
	}
}

func TestPreviewResetOffsetRejectsUnsupportedMode(t *testing.T) {
	c := newCluster(t, 1, "t1")
	cl := newKafkaClient(t, c)

	// Latest is intentionally unsupported: the frontend previews log end
	// offsets from its lag data instead of asking the broker.
	if _, err := cl.PreviewResetOffset(context.Background(), "t1", model.ResetOffsetLatest, 0); err == nil {
		t.Fatal("latest mode must be rejected by the read-only preview")
	}
}
