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
		Key:       "key-1",
		Value:     `{"a":1}`,
		Headers:   []Header{{Key: "trace", Value: "abc"}},
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
	if got.Key != "key-1" || got.Value != `{"a":1}` {
		t.Fatalf("bytes fields lost in round trip: %+v", got)
	}
	if len(got.Headers) != 1 || got.Headers[0].Key != "trace" || got.Headers[0].Value != "abc" {
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

func TestMessageJSONValueIsReadableUTF8(t *testing.T) {
	m := Message{
		Key:   "k-1",
		Value: "中文消息 你好 hello 世界",
	}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Value != "中文消息 你好 hello 世界" {
		t.Fatalf("value must be delivered as readable UTF-8 text (not base64), got %q", got.Value)
	}
	if got.Key != "k-1" {
		t.Fatalf("key must be delivered as plain text, got %q", got.Key)
	}
}
