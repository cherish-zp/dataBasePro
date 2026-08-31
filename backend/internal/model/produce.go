package model

// BatchProduceMessage is a single record inside a batch produce request.
type BatchProduceMessage struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// ProduceResult is the per-message outcome of a batch produce. Error is empty
// on success; Partition/Offset are only meaningful on success.
type ProduceResult struct {
	Index     int    `json:"index"`
	Partition int32  `json:"partition"`
	Offset    int64  `json:"offset"`
	Error     string `json:"error"`
}
