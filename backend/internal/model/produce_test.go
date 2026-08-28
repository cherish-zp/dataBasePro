package model

import (
	"encoding/json"
	"testing"
)

func TestProduceResultJSONShape(t *testing.T) {
	r := ProduceResult{Index: 2, Partition: 1, Offset: 41, Error: ""}
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"index", "partition", "offset", "error"} {
		if _, ok := raw[key]; !ok {
			t.Fatalf("ProduceResult JSON must expose snake_case key %q, got %s", key, b)
		}
	}
}

func TestBatchProduceRequestJSONShape(t *testing.T) {
	req := ProduceRequest{
		ConnectionID: "c-1",
		Topic:        "orders",
		Partition:    -1,
		Messages:     []BatchProduceMessage{{Key: "k", Value: "v"}},
	}
	b, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"connection_id", "topic", "partition", "messages"} {
		if _, ok := raw[key]; !ok {
			t.Fatalf("ProduceRequest JSON must expose snake_case key %q, got %s", key, b)
		}
	}
	msgs, ok := raw["messages"].([]any)
	if !ok || len(msgs) != 1 {
		t.Fatalf("messages must marshal as an array, got %s", b)
	}
	first, _ := msgs[0].(map[string]any)
	if _, ok := first["key"]; !ok {
		t.Fatalf("batch message must expose key, got %s", b)
	}
	if _, ok := first["value"]; !ok {
		t.Fatalf("batch message must expose value, got %s", b)
	}
}
