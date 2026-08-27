package model

// BrokerInfo describes one broker of the cluster as surfaced in the cluster
// health panel.
type BrokerInfo struct {
	ID      int32  `json:"id"`
	Host    string `json:"host"`
	Port    int32  `json:"port"`
	Rack    string `json:"rack"`
	Version string `json:"version"`
	Online  bool   `json:"online"`
}

// ClusterHealth is a health snapshot of one connection's cluster: broker
// topology, controller, Kafka version and the under-replicated partition
// count.
type ClusterHealth struct {
	ClusterID                 string       `json:"cluster_id"`
	ControllerID              int32        `json:"controller_id"`
	KafkaVersion              string       `json:"kafka_version"`
	Brokers                   []BrokerInfo `json:"brokers"`
	UnderReplicatedPartitions int32        `json:"under_replicated_partitions"`
}
