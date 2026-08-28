export namespace backend {
	
	export class ActiveMembersRequest {
	    connection_id: string;
	    group: string;
	    topic: string;
	
	    static createFrom(source: any = {}) {
	        return new ActiveMembersRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.connection_id = source["connection_id"];
	        this.group = source["group"];
	        this.topic = source["topic"];
	    }
	}
	export class BatchProduceRequest {
	    connection_id: string;
	    topic: string;
	    partition: number;
	    messages: model.BatchProduceMessage[];
	
	    static createFrom(source: any = {}) {
	        return new BatchProduceRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.connection_id = source["connection_id"];
	        this.topic = source["topic"];
	        this.partition = source["partition"];
	        this.messages = this.convertValues(source["messages"], model.BatchProduceMessage);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ConsumeRequest {
	    connection_id: string;
	    topic: string;
	    partition: number;
	    offset: number;
	    timestamp_ms?: number;
	    limit: number;
	
	    static createFrom(source: any = {}) {
	        return new ConsumeRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.connection_id = source["connection_id"];
	        this.topic = source["topic"];
	        this.partition = source["partition"];
	        this.offset = source["offset"];
	        this.timestamp_ms = source["timestamp_ms"];
	        this.limit = source["limit"];
	    }
	}
	export class CreateTopicRequest {
	    connection_id: string;
	    topic: string;
	    partitions: number;
	    replication_factor: number;
	
	    static createFrom(source: any = {}) {
	        return new CreateTopicRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.connection_id = source["connection_id"];
	        this.topic = source["topic"];
	        this.partitions = source["partitions"];
	        this.replication_factor = source["replication_factor"];
	    }
	}
	export class DeleteConsumerGroupRequest {
	    connection_id: string;
	    group: string;
	
	    static createFrom(source: any = {}) {
	        return new DeleteConsumerGroupRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.connection_id = source["connection_id"];
	        this.group = source["group"];
	    }
	}
	export class DeleteTopicRequest {
	    connection_id: string;
	    topic: string;
	
	    static createFrom(source: any = {}) {
	        return new DeleteTopicRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.connection_id = source["connection_id"];
	        this.topic = source["topic"];
	    }
	}
	export class ProduceRequest {
	    connection_id: string;
	    topic: string;
	    partition: number;
	    key: string;
	    value: string;
	
	    static createFrom(source: any = {}) {
	        return new ProduceRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.connection_id = source["connection_id"];
	        this.topic = source["topic"];
	        this.partition = source["partition"];
	        this.key = source["key"];
	        this.value = source["value"];
	    }
	}
	export class ResetOffsetRequest {
	    connection_id: string;
	    group: string;
	    topic: string;
	    mode: string;
	    timestamp_ms?: number;
	
	    static createFrom(source: any = {}) {
	        return new ResetOffsetRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.connection_id = source["connection_id"];
	        this.group = source["group"];
	        this.topic = source["topic"];
	        this.mode = source["mode"];
	        this.timestamp_ms = source["timestamp_ms"];
	    }
	}

}

export namespace model {
	
	export class ActiveConsumer {
	    member_id: string;
	    client_id: string;
	    client_host: string;
	    partitions: number[];
	
	    static createFrom(source: any = {}) {
	        return new ActiveConsumer(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.member_id = source["member_id"];
	        this.client_id = source["client_id"];
	        this.client_host = source["client_host"];
	        this.partitions = source["partitions"];
	    }
	}
	export class ActiveProducer {
	    topic: string;
	    partition: number;
	    producer_id: number;
	    producer_epoch: number;
	    last_sequence: number;
	    last_timestamp: number;
	    leader: number;
	
	    static createFrom(source: any = {}) {
	        return new ActiveProducer(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.topic = source["topic"];
	        this.partition = source["partition"];
	        this.producer_id = source["producer_id"];
	        this.producer_epoch = source["producer_epoch"];
	        this.last_sequence = source["last_sequence"];
	        this.last_timestamp = source["last_timestamp"];
	        this.leader = source["leader"];
	    }
	}
	export class BatchProduceMessage {
	    key: string;
	    value: string;
	
	    static createFrom(source: any = {}) {
	        return new BatchProduceMessage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.value = source["value"];
	    }
	}
	export class BrokerInfo {
	    id: number;
	    host: string;
	    port: number;
	    rack: string;
	    version: string;
	    online: boolean;
	
	    static createFrom(source: any = {}) {
	        return new BrokerInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.rack = source["rack"];
	        this.version = source["version"];
	        this.online = source["online"];
	    }
	}
	export class ClusterHealth {
	    cluster_id: string;
	    controller_id: number;
	    kafka_version: string;
	    brokers: BrokerInfo[];
	    under_replicated_partitions: number;
	
	    static createFrom(source: any = {}) {
	        return new ClusterHealth(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.cluster_id = source["cluster_id"];
	        this.controller_id = source["controller_id"];
	        this.kafka_version = source["kafka_version"];
	        this.brokers = this.convertValues(source["brokers"], BrokerInfo);
	        this.under_replicated_partitions = source["under_replicated_partitions"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class TLSConfig {
	    enabled: boolean;
	    ca_cert?: string;
	    insecure_skip_verify?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new TLSConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enabled = source["enabled"];
	        this.ca_cert = source["ca_cert"];
	        this.insecure_skip_verify = source["insecure_skip_verify"];
	    }
	}
	export class SASLConfig {
	    enabled: boolean;
	    mechanism: string;
	    username: string;
	    password: string;
	
	    static createFrom(source: any = {}) {
	        return new SASLConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enabled = source["enabled"];
	        this.mechanism = source["mechanism"];
	        this.username = source["username"];
	        this.password = source["password"];
	    }
	}
	export class KafkaConfig {
	    bootstrap_servers: string[];
	    sasl?: SASLConfig;
	    tls?: TLSConfig;
	
	    static createFrom(source: any = {}) {
	        return new KafkaConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.bootstrap_servers = source["bootstrap_servers"];
	        this.sasl = this.convertValues(source["sasl"], SASLConfig);
	        this.tls = this.convertValues(source["tls"], TLSConfig);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Connection {
	    id: string;
	    name: string;
	    type: string;
	    config: KafkaConfig;
	    created_at: number;
	    updated_at: number;
	
	    static createFrom(source: any = {}) {
	        return new Connection(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.type = source["type"];
	        this.config = this.convertValues(source["config"], KafkaConfig);
	        this.created_at = source["created_at"];
	        this.updated_at = source["updated_at"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ConsumerGroup {
	    name: string;
	    state: string;
	    topics: Record<string, Array<PartitionLag>>;
	
	    static createFrom(source: any = {}) {
	        return new ConsumerGroup(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.state = source["state"];
	        this.topics = this.convertValues(source["topics"], Array<PartitionLag>, true);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Header {
	    key: string;
	    value: string;
	
	    static createFrom(source: any = {}) {
	        return new Header(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.value = source["value"];
	    }
	}
	
	export class Message {
	    partition: number;
	    offset: number;
	    timestamp: number;
	    key: string;
	    value: string;
	    headers: Header[];
	
	    static createFrom(source: any = {}) {
	        return new Message(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.partition = source["partition"];
	        this.offset = source["offset"];
	        this.timestamp = source["timestamp"];
	        this.key = source["key"];
	        this.value = source["value"];
	        this.headers = this.convertValues(source["headers"], Header);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Partition {
	    id: number;
	    leader: number;
	    replicas: number[];
	    isr: number[];
	
	    static createFrom(source: any = {}) {
	        return new Partition(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.leader = source["leader"];
	        this.replicas = source["replicas"];
	        this.isr = source["isr"];
	    }
	}
	export class PartitionLag {
	    partition: number;
	    current_offset: number;
	    log_end_offset: number;
	    lag: number;
	    member_id?: string;
	    client_id?: string;
	    client_host?: string;
	
	    static createFrom(source: any = {}) {
	        return new PartitionLag(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.partition = source["partition"];
	        this.current_offset = source["current_offset"];
	        this.log_end_offset = source["log_end_offset"];
	        this.lag = source["lag"];
	        this.member_id = source["member_id"];
	        this.client_id = source["client_id"];
	        this.client_host = source["client_host"];
	    }
	}
	export class ProduceResult {
	    index: number;
	    partition: number;
	    offset: number;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new ProduceResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.index = source["index"];
	        this.partition = source["partition"];
	        this.offset = source["offset"];
	        this.error = source["error"];
	    }
	}
	
	
	export class Topic {
	    name: string;
	    partitions: Partition[];
	
	    static createFrom(source: any = {}) {
	        return new Topic(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.partitions = this.convertValues(source["partitions"], Partition);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class TopicConfigEntry {
	    key: string;
	    value: string;
	
	    static createFrom(source: any = {}) {
	        return new TopicConfigEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.value = source["value"];
	    }
	}
	export class TopicDetail {
	    name: string;
	    partitions: Partition[];
	    configs: TopicConfigEntry[];
	
	    static createFrom(source: any = {}) {
	        return new TopicDetail(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.partitions = this.convertValues(source["partitions"], Partition);
	        this.configs = this.convertValues(source["configs"], TopicConfigEntry);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

