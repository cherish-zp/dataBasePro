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
