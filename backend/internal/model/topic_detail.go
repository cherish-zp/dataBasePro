package model

// TopicConfigEntry is a single whitelisted topic configuration entry surfaced
// to the UI.
type TopicConfigEntry struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// TopicDetail describes one topic: its partition topology (leader, replicas
// and ISR per partition) plus a small whitelist of notable topic configs.
type TopicDetail struct {
	Name       string             `json:"name"`
	Partitions []Partition        `json:"partitions"`
	Configs    []TopicConfigEntry `json:"configs"`
}
