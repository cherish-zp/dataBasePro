package model

import (
	"encoding/json"
	"testing"
)

func TestOffsetSentinels(t *testing.T) {
	if OffsetEarliest != -2 {
		t.Fatalf("OffsetEarliest must be -2, got %d", OffsetEarliest)
	}
	if OffsetLatest != -1 {
		t.Fatalf("OffsetLatest must be -1, got %d", OffsetLatest)
	}
}

func TestMessageJSONRoundTrip(t *testing.T) {
	m := Message{
		Partition: 3,
		Offset:    42,
		Timestamp: 1700000000000,
		Key:       []byte("key-1"),
		Value:     []byte(`{"a":1}`),
		Headers:   []Header{{Key: "trace", Value: []byte("abc")}},
	}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got Message
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Partition != 3 || got.Offset != 42 || got.Timestamp != 1700000000000 {
		t.Fatalf("scalar fields lost in round trip: %+v", got)
	}
	if string(got.Key) != "key-1" || string(got.Value) != `{"a":1}` {
		t.Fatalf("bytes fields lost in round trip: %+v", got)
	}
	if len(got.Headers) != 1 || got.Headers[0].Key != "trace" || string(got.Headers[0].Value) != "abc" {
		t.Fatalf("headers lost in round trip: %+v", got.Headers)
	}
}

func TestConsumerGroupHasTopics(t *testing.T) {
	g := ConsumerGroup{
		Name:  "grp-1",
		State: "Stable",
		Topics: map[string][]PartitionLag{
			"t": {{Partition: 0, Current: 10, LogEnd: 20, Lag: 10}},
		},
	}
	b, _ := json.Marshal(g)
	if len(b) == 0 {
		t.Fatal("consumer group must marshal")
	}
}
