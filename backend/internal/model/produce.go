package model

// BatchProduceMessage is a single record inside a batch produce request.
type BatchProduceMessage struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// ProduceRequest carries the parameters for publishing a batch of records to
// one topic (optionally pinned to a partition; a negative partition lets the
// client choose).
type ProduceRequest struct {
	ConnectionID string                `json:"connection_id"`
	Topic        string                `json:"topic"`
	Partition    int32                 `json:"partition"`
	Messages     []BatchProduceMessage `json:"messages"`
}

// ProduceResult is the per-message outcome of a batch produce. Error is empty
// on success; Partition/Offset are only meaningful on success.
type ProduceResult struct {
	Index     int    `json:"index"`
	Partition int32  `json:"partition"`
	Offset    int64  `json:"offset"`
	Error     string `json:"error"`
}
