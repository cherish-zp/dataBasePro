// Thin wrapper around the generated Wails bindings so stores/components can be
// tested by swapping the Api implementation via setApi().
import * as App from '../../wailsjs/go/backend/App'
import type {
  Connection,
  KafkaConfig,
  Topic,
  TopicDetail,
  ClusterHealth,
  ConsumerGroup,
  GroupDetail,
  Message,
  ConsumeRequest,
  ResetOffsetRequest,
  PreviewOffsetRequest,
  PreviewOffsetMap,
  ProduceRequest,
  BatchProduceRequest,
  ProduceResult,
  CreateTopicRequest,
  UpdateConnectionRequest,
  DeleteTopicRequest,
  DeleteTopicsRequest,
  AlterTopicConfigRequest,
  AlterTopicPartitionsRequest,
  TopicMessageCounts,
  TopicDeleteResult,
  DeleteConsumerGroupRequest,
  ActiveMembersRequest,
  ActiveProducer,
  ActiveConsumer,
  AuditEntry,
  SaveTextFileRequest,
  UpdateCheckRequest,
  UpdateCheckResult,
  UpdateDownloadRequest,
  UpdateProgressInfo,
  ApplyUpdateRequest,
  RedisConfigShape,
  RedisDBInfo,
  RedisKeyInfo,
  RedisValue,
  RedisServerInfo,
  RedisScanRequest,
  RedisScanResult,
  RedisKeyRequest,
  RedisDeleteKeysRequest,
  RedisSetStringRequest,
  RedisFlushRequest,
  RedisHashSetFieldRequest,
  SavedQuery,
  ListSavedQueriesRequest,
  SaveSavedQueryRequest,
  UpdateSavedQueryRequest,
  DeleteSavedQueryRequest,
  RedisHashDeleteFieldRequest,
  RedisListSetIndexRequest,
  RedisListPushRequest,
  RedisListDeleteIndexRequest,
  RedisSetAddRequest,
  RedisSetRemoveRequest,
  RedisZSetAddRequest,
  RedisZSetRemoveRequest,
  CHConfigShape,
  CHListTablesRequest,
  CHTableInfo,
  CHPageRowsRequest,
  CHPageRowsResult,
  CHTruncateTableRequest,
  CHExecuteRequest,
  CHStatementResult,
  DriverInfo,
  MysqlConfigShape,
  MysqlListTablesRequest,
  MysqlTableInfo,
  MysqlPageRowsRequest,
  MysqlPageRowsResult,
  MysqlExecuteRequest,
  MysqlStatementResult,
  MysqlTruncateTableRequest,
  MysqlCellUpdateRequest,
  MysqlCellUpdatePreview,
  PostgresConfigShape,
  PostgresListSchemasRequest,
  PostgresListTablesRequest,
  PostgresRelationInfo,
  PostgresPageRowsRequest,
  PostgresPageRowsResult,
  PostgresExecuteRequest,
  PostgresStatementResult,
  PostgresTruncateTableRequest,
  PostgresCellUpdateRequest,
  PostgresCellUpdatePreview,
  EsConfigShape,
  EsIndexInfo,
  EsColumn,
  EsMappingRequest,
  EsPageRowsRequest,
  EsPageRowsResult,
  EsExecuteRequest,
  EsStatementResult,
  EsCellUpdateRequest,
  EsCreateDocRequest,
  EsGetDocRequest,
  EsDoc,
  EsPutDocRequest,
  EsDeleteDocRequest,
  EsDeleteByQueryRequest,
  EsCreateIndexRequest,
  EsDeleteIndexRequest,
  EsUpdateIndexSettingsRequest,
  EsDeleteTemplateRequest,
  EsTemplateInfo,
  EsGetTemplateRequest,
  EsTemplateContent,
  EsPutTemplateRequest,
  EsClusterStatsRequest,
  EsClusterStats,
} from './types'

export interface Api {
  createConnection(conn: Connection): Promise<Connection>
  updateConnection(req: UpdateConnectionRequest): Promise<Connection>
  listConnections(): Promise<Connection[]>
  getConnection(id: string): Promise<Connection>
  deleteConnection(id: string): Promise<void>
  testConnection(cfg: KafkaConfig): Promise<void>
  connect(id: string): Promise<void>
  disconnect(id: string): Promise<void>
  listTopics(id: string): Promise<Topic[]>
  describeTopic(id: string, topic: string): Promise<TopicDetail>
  alterTopicConfig(req: AlterTopicConfigRequest): Promise<void>
  alterTopicPartitions(req: AlterTopicPartitionsRequest): Promise<void>
  getTopicMessageCounts(id: string, topics: string[]): Promise<Record<string, TopicMessageCounts>>
  describeCluster(id: string): Promise<ClusterHealth>
  listConsumerGroups(id: string): Promise<ConsumerGroup[]>
  describeGroup(id: string, group: string): Promise<GroupDetail>
  createTopic(req: CreateTopicRequest): Promise<void>
  deleteTopic(req: DeleteTopicRequest): Promise<void>
  deleteTopics(req: DeleteTopicsRequest): Promise<TopicDeleteResult[]>
  deleteConsumerGroup(req: DeleteConsumerGroupRequest): Promise<void>
  consumeMessages(req: ConsumeRequest): Promise<Message[]>
  consumeMessagesByTimestamp(req: ConsumeRequest): Promise<Message[]>
  getPartitionLag(id: string, topic: string, group: string): Promise<Record<number, number>>
  listActiveProducers(req: ActiveMembersRequest): Promise<ActiveProducer[]>
  listActiveConsumers(req: ActiveMembersRequest): Promise<ActiveConsumer[]>
  resetConsumerGroupOffset(req: ResetOffsetRequest): Promise<void>
  previewResetOffset(req: PreviewOffsetRequest): Promise<PreviewOffsetMap>
  produceMessage(req: ProduceRequest): Promise<void>
  produceMessages(req: BatchProduceRequest): Promise<ProduceResult[]>
  listAudit(limit?: number): Promise<AuditEntry[]>
  saveTextFile(req: SaveTextFileRequest): Promise<string>
  checkUpdate(req: UpdateCheckRequest): Promise<UpdateCheckResult>
  downloadUpdate(req: UpdateDownloadRequest): Promise<void>
  applyUpdate(req: ApplyUpdateRequest): Promise<void>
  updateProgress(): Promise<UpdateProgressInfo>
  openURL(url: string): Promise<void>
  testRedisConnection(cfg: RedisConfigShape): Promise<void>
  listRedisDBs(id: string): Promise<RedisDBInfo[]>
  redisScan(req: RedisScanRequest): Promise<RedisScanResult>
  redisGetKey(req: RedisKeyRequest): Promise<RedisValue>
  redisRenameKey(req: RedisKeyRequest): Promise<void>
  redisDeleteKeys(req: RedisDeleteKeysRequest): Promise<number>
  redisSetTTL(req: RedisKeyRequest): Promise<void>
  redisSetString(req: RedisSetStringRequest): Promise<void>
  redisFlushDB(req: RedisFlushRequest): Promise<void>
  redisFlushAll(req: RedisFlushRequest): Promise<void>
  redisServerInfo(id: string): Promise<RedisServerInfo>
  redisHashSetField(req: RedisHashSetFieldRequest): Promise<void>
  redisHashDeleteField(req: RedisHashDeleteFieldRequest): Promise<void>
  redisListSetIndex(req: RedisListSetIndexRequest): Promise<void>
  redisListPush(req: RedisListPushRequest): Promise<void>
  redisListDeleteIndex(req: RedisListDeleteIndexRequest): Promise<void>
  redisSetAdd(req: RedisSetAddRequest): Promise<void>
  redisSetRemove(req: RedisSetRemoveRequest): Promise<void>
  redisZSetAdd(req: RedisZSetAddRequest): Promise<void>
  redisZSetRemove(req: RedisZSetRemoveRequest): Promise<void>
  listSavedQueries(req: ListSavedQueriesRequest): Promise<SavedQuery[]>
  saveSavedQuery(req: SaveSavedQueryRequest): Promise<SavedQuery>
  updateSavedQuery(req: UpdateSavedQueryRequest): Promise<SavedQuery>
  deleteSavedQuery(req: DeleteSavedQueryRequest): Promise<void>
  testCHConnection(cfg: CHConfigShape): Promise<void>
  listCHDatabases(id: string): Promise<string[]>
  listCHTables(req: CHListTablesRequest): Promise<CHTableInfo[]>
  chPageRows(req: CHPageRowsRequest): Promise<CHPageRowsResult>
  chTruncateTable(req: CHTruncateTableRequest): Promise<void>
  chExecute(req: CHExecuteRequest): Promise<CHStatementResult[]>
  listDrivers(): Promise<DriverInfo[]>
  // MySQL/TiDB 系列:后端绑定尚未由 wails generate 生成,先声明为可选成员,
  // 避免全仓既有 fakeApi 被迫补齐;调用方用可选链(?.)访问。
  testMysqlConnection?(cfg: MysqlConfigShape): Promise<void>
  listMysqlDatabases?(id: string): Promise<string[]>
  listMysqlTables?(req: MysqlListTablesRequest): Promise<MysqlTableInfo[]>
  mysqlPageRows?(req: MysqlPageRowsRequest): Promise<MysqlPageRowsResult>
  mysqlExecute?(req: MysqlExecuteRequest): Promise<MysqlStatementResult[]>
  mysqlPreviewCellUpdate?(req: MysqlCellUpdateRequest): Promise<MysqlCellUpdatePreview>
  mysqlUpdateCell?(req: MysqlCellUpdateRequest): Promise<void>
  mysqlTruncateTable?(req: MysqlTruncateTableRequest): Promise<void>
  testPostgresConnection?(cfg: PostgresConfigShape): Promise<void>
  listPostgresDatabases?(id: string): Promise<string[]>
  listPostgresSchemas?(req: PostgresListSchemasRequest): Promise<string[]>
  listPostgresTables?(req: PostgresListTablesRequest): Promise<PostgresRelationInfo[]>
  postgresPageRows?(req: PostgresPageRowsRequest): Promise<PostgresPageRowsResult>
  postgresExecute?(req: PostgresExecuteRequest): Promise<PostgresStatementResult[]>
  postgresTruncateTable?(req: PostgresTruncateTableRequest): Promise<void>
  postgresPreviewCellUpdate?(req: PostgresCellUpdateRequest): Promise<PostgresCellUpdatePreview>
  postgresUpdateCell?(req: PostgresCellUpdateRequest): Promise<void>
  // Elasticsearch 系列:后端绑定尚未由 wails generate 生成,同样声明为可选
  // 成员(全仓既有 fakeApi 零改动);调用方用可选链(?.)访问。
  testEsConnection?(cfg: EsConfigShape): Promise<void>
  listEsIndices?(id: string): Promise<EsIndexInfo[]>
  esMapping?(req: EsMappingRequest): Promise<EsColumn[]>
  esPageRows?(req: EsPageRowsRequest): Promise<EsPageRowsResult>
  esExecute?(req: EsExecuteRequest): Promise<EsStatementResult[]>
  esGetDoc?(req: EsGetDocRequest): Promise<EsDoc>
  esPutDoc?(req: EsPutDocRequest): Promise<void>
  esUpdateCell?(req: EsCellUpdateRequest): Promise<void>
  esDeleteDoc?(req: EsDeleteDocRequest): Promise<void>
  esDeleteByQuery?(req: EsDeleteByQueryRequest): Promise<number>
  // 新增文档(ESCreateDoc):绑定尚未由 wails generate 生成(主控稍后重生
  // 成),声明为可选成员;调用方用可选链(?.)访问。
  esCreateDoc?(req: EsCreateDocRequest): Promise<EsDoc>
  // ES 集合编辑系列(索引/模板的新建、删除与设置修改):后端绑定尚未由
  // wails generate 生成,同样声明为可选成员;调用方用可选链(?.)访问。
  esCreateIndex?(req: EsCreateIndexRequest): Promise<void>
  esDeleteIndex?(req: EsDeleteIndexRequest): Promise<void>
  esUpdateIndexSettings?(req: EsUpdateIndexSettingsRequest): Promise<void>
  esDeleteTemplate?(req: EsDeleteTemplateRequest): Promise<void>
  // ES 索引模板读取/保存与集群监控:ListEsTemplates/GetEsTemplate/PutEsTemplate/
  // DeleteEsTemplate 绑定已由 wailsjs 生成;EsClusterStats 绑定尚未生成(主控
  // 稍后重生成)。全部声明为可选成员(既有 fake 零改动),调用方用可选链(?.)访问。
  listEsTemplates?(id: string): Promise<EsTemplateInfo[]>
  getEsTemplate?(req: EsGetTemplateRequest): Promise<EsTemplateContent>
  putEsTemplate?(req: EsPutTemplateRequest): Promise<void>
  esClusterStats?(req: EsClusterStatsRequest): Promise<EsClusterStats>
}

// The Wails binding generator models Go `[]byte` fields as `number[]`, but
// over JSON the transport delivers them as base64 strings. The backend model
// therefore exposes Message.Key/Value and Header.Value as `string` so the
// wire format matches our domain types and text (e.g. UTF-8 Chinese) is
// delivered verbatim instead of base64-encoded.
export class WailsApi implements Api {
  createConnection(conn: Connection): Promise<Connection> {
    return App.CreateConnection(conn as unknown as never) as unknown as Promise<Connection>
  }
  updateConnection(req: UpdateConnectionRequest): Promise<Connection> {
    // App.UpdateConnection 由 wails generate 生成绑定;生成前先对模块断言,
    // 不手改自动生成的 wailsjs 声明。
    return (App as unknown as { UpdateConnection: (req: unknown) => Promise<unknown> }).UpdateConnection(req) as unknown as Promise<Connection>
  }
  listConnections(): Promise<Connection[]> {
    return App.ListConnections() as unknown as Promise<Connection[]>
  }
  getConnection(id: string): Promise<Connection> {
    return App.GetConnection(id) as unknown as Promise<Connection>
  }
  deleteConnection(id: string): Promise<void> {
    return App.DeleteConnection(id)
  }
  testConnection(cfg: KafkaConfig): Promise<void> {
    return App.TestConnection(cfg as unknown as never) as unknown as Promise<void>
  }
  connect(id: string): Promise<void> {
    return App.Connect(id)
  }
  disconnect(id: string): Promise<void> {
    return App.Disconnect(id)
  }
  listTopics(id: string): Promise<Topic[]> {
    return App.ListTopics(id) as unknown as Promise<Topic[]>
  }
  describeTopic(id: string, topic: string): Promise<TopicDetail> {
    return App.DescribeTopic(id, topic) as unknown as Promise<TopicDetail>
  }
  alterTopicConfig(req: AlterTopicConfigRequest): Promise<void> {
    return App.AlterTopicConfig(req as unknown as never) as unknown as Promise<void>
  }
  alterTopicPartitions(req: AlterTopicPartitionsRequest): Promise<void> {
    return App.AlterTopicPartitions(req as unknown as never) as unknown as Promise<void>
  }
  getTopicMessageCounts(id: string, topics: string[]): Promise<Record<string, TopicMessageCounts>> {
    return App.GetTopicMessageCounts(id, topics) as unknown as Promise<Record<string, TopicMessageCounts>>
  }
  describeCluster(id: string): Promise<ClusterHealth> {
    return App.DescribeCluster(id) as unknown as Promise<ClusterHealth>
  }
  listConsumerGroups(id: string): Promise<ConsumerGroup[]> {
    return App.ListConsumerGroups(id) as unknown as Promise<ConsumerGroup[]>
  }
  describeGroup(id: string, group: string): Promise<GroupDetail> {
    return App.DescribeGroup(id, group) as unknown as Promise<GroupDetail>
  }
  createTopic(req: CreateTopicRequest): Promise<void> {
    return App.CreateTopic(req) as unknown as Promise<void>
  }
  deleteTopic(req: DeleteTopicRequest): Promise<void> {
    return App.DeleteTopic(req) as unknown as Promise<void>
  }
  deleteTopics(req: DeleteTopicsRequest): Promise<TopicDeleteResult[]> {
    return App.DeleteTopics(req as unknown as never) as unknown as Promise<TopicDeleteResult[]>
  }
  deleteConsumerGroup(req: DeleteConsumerGroupRequest): Promise<void> {
    return App.DeleteConsumerGroup(req) as unknown as Promise<void>
  }
  consumeMessages(req: ConsumeRequest): Promise<Message[]> {
    return App.ConsumeMessages(req) as unknown as Promise<Message[]>
  }
  consumeMessagesByTimestamp(req: ConsumeRequest): Promise<Message[]> {
    return App.ConsumeMessagesByTimestamp(req) as unknown as Promise<Message[]>
  }
  getPartitionLag(id: string, topic: string, group: string): Promise<Record<number, number>> {
    return App.GetPartitionLag(id, topic, group)
  }
  listActiveProducers(req: ActiveMembersRequest): Promise<ActiveProducer[]> {
    return App.ListActiveProducers(req) as unknown as Promise<ActiveProducer[]>
  }
  listActiveConsumers(req: ActiveMembersRequest): Promise<ActiveConsumer[]> {
    return App.ListActiveConsumers(req) as unknown as Promise<ActiveConsumer[]>
  }
  resetConsumerGroupOffset(req: ResetOffsetRequest): Promise<void> {
    return App.ResetConsumerGroupOffset(req)
  }
  previewResetOffset(req: PreviewOffsetRequest): Promise<PreviewOffsetMap> {
    return App.PreviewResetOffset(req) as unknown as Promise<PreviewOffsetMap>
  }
  produceMessage(req: ProduceRequest): Promise<void> {
    return App.ProduceMessage(req)
  }
  produceMessages(req: BatchProduceRequest): Promise<ProduceResult[]> {
    return App.ProduceMessages(req as unknown as never) as unknown as Promise<ProduceResult[]>
  }
  listAudit(limit?: number): Promise<AuditEntry[]> {
    return App.ListAudit(limit ?? 200) as unknown as Promise<AuditEntry[]>
  }
  saveTextFile(req: SaveTextFileRequest): Promise<string> {
    return App.SaveTextFile(req as unknown as never) as unknown as Promise<string>
  }
  checkUpdate(req: UpdateCheckRequest): Promise<UpdateCheckResult> {
    return App.CheckUpdate(req as unknown as never) as unknown as Promise<UpdateCheckResult>
  }
  downloadUpdate(req: UpdateDownloadRequest): Promise<void> {
    return App.DownloadUpdate(req as unknown as never) as unknown as Promise<void>
  }
  applyUpdate(req: ApplyUpdateRequest): Promise<void> {
    return App.ApplyUpdate(req as unknown as never) as unknown as Promise<void>
  }
  updateProgress(): Promise<UpdateProgressInfo> {
    return App.UpdateProgress() as unknown as Promise<UpdateProgressInfo>
  }
  openURL(url: string): Promise<void> {
    return App.OpenURL(url) as unknown as Promise<void>
  }
  testRedisConnection(cfg: RedisConfigShape): Promise<void> {
    return App.TestRedisConnection(cfg as unknown as never) as unknown as Promise<void>
  }
  listRedisDBs(id: string): Promise<RedisDBInfo[]> {
    return App.ListRedisDBs(id) as unknown as Promise<RedisDBInfo[]>
  }
  redisScan(req: RedisScanRequest): Promise<RedisScanResult> {
    return App.RedisScan(req as unknown as never) as unknown as Promise<RedisScanResult>
  }
  redisGetKey(req: RedisKeyRequest): Promise<RedisValue> {
    return App.RedisGetKey(req as unknown as never) as unknown as Promise<RedisValue>
  }
  redisRenameKey(req: RedisKeyRequest): Promise<void> {
    return App.RedisRenameKey(req as unknown as never) as unknown as Promise<void>
  }
  redisDeleteKeys(req: RedisDeleteKeysRequest): Promise<number> {
    return App.RedisDeleteKeys(req as unknown as never) as unknown as Promise<number>
  }
  redisSetTTL(req: RedisKeyRequest): Promise<void> {
    return App.RedisSetTTL(req as unknown as never) as unknown as Promise<void>
  }
  redisSetString(req: RedisSetStringRequest): Promise<void> {
    return App.RedisSetString(req as unknown as never) as unknown as Promise<void>
  }
  redisFlushDB(req: RedisFlushRequest): Promise<void> {
    return App.RedisFlushDB(req as unknown as never) as unknown as Promise<void>
  }
  redisFlushAll(req: RedisFlushRequest): Promise<void> {
    return App.RedisFlushAll(req as unknown as never) as unknown as Promise<void>
  }
  redisServerInfo(id: string): Promise<RedisServerInfo> {
    return App.RedisServerInfo(id) as unknown as Promise<RedisServerInfo>
  }
  // 以下集合编辑 API 的后端绑定尚未由 wails generate 生成,先对模块形状断言,
  // 待主会话生成绑定后即可直接调用。
  redisHashSetField(req: RedisHashSetFieldRequest): Promise<void> {
    return (App as unknown as { RedisHashSetField: (req: never) => Promise<void> }).RedisHashSetField(req as unknown as never)
  }
  redisHashDeleteField(req: RedisHashDeleteFieldRequest): Promise<void> {
    return (App as unknown as { RedisHashDeleteField: (req: never) => Promise<void> }).RedisHashDeleteField(req as unknown as never)
  }
  redisListSetIndex(req: RedisListSetIndexRequest): Promise<void> {
    return (App as unknown as { RedisListSetIndex: (req: never) => Promise<void> }).RedisListSetIndex(req as unknown as never)
  }
  redisListPush(req: RedisListPushRequest): Promise<void> {
    return (App as unknown as { RedisListPush: (req: never) => Promise<void> }).RedisListPush(req as unknown as never)
  }
  redisListDeleteIndex(req: RedisListDeleteIndexRequest): Promise<void> {
    return (App as unknown as { RedisListDeleteIndex: (req: never) => Promise<void> }).RedisListDeleteIndex(req as unknown as never)
  }
  redisSetAdd(req: RedisSetAddRequest): Promise<void> {
    return (App as unknown as { RedisSetAdd: (req: never) => Promise<void> }).RedisSetAdd(req as unknown as never)
  }
  redisSetRemove(req: RedisSetRemoveRequest): Promise<void> {
    return (App as unknown as { RedisSetRemove: (req: never) => Promise<void> }).RedisSetRemove(req as unknown as never)
  }
  redisZSetAdd(req: RedisZSetAddRequest): Promise<void> {
    return (App as unknown as { RedisZSetAdd: (req: never) => Promise<void> }).RedisZSetAdd(req as unknown as never)
  }
  redisZSetRemove(req: RedisZSetRemoveRequest): Promise<void> {
    return (App as unknown as { RedisZSetRemove: (req: never) => Promise<void> }).RedisZSetRemove(req as unknown as never)
  }
  listSavedQueries(req: ListSavedQueriesRequest): Promise<SavedQuery[]> {
    return App.ListSavedQueries(req as unknown as never) as unknown as Promise<SavedQuery[]>
  }
  saveSavedQuery(req: SaveSavedQueryRequest): Promise<SavedQuery> {
    return App.SaveSavedQuery(req as unknown as never) as unknown as Promise<SavedQuery>
  }
  updateSavedQuery(req: UpdateSavedQueryRequest): Promise<SavedQuery> {
    return App.UpdateSavedQuery(req as unknown as never) as unknown as Promise<SavedQuery>
  }
  deleteSavedQuery(req: DeleteSavedQueryRequest): Promise<void> {
    return App.DeleteSavedQuery(req as unknown as never) as unknown as Promise<void>
  }
  // 以下 ClickHouse 与驱动管理 API 的后端绑定尚未由 wails generate 生成,
  // 先对模块形状断言,待主会话生成绑定后即可直接调用。
  testCHConnection(cfg: CHConfigShape): Promise<void> {
    return (App as unknown as { TestCHConnection: (cfg: never) => Promise<void> }).TestCHConnection(cfg as unknown as never)
  }
  listCHDatabases(id: string): Promise<string[]> {
    return (App as unknown as { ListCHDatabases: (id: string) => Promise<string[]> }).ListCHDatabases(id) as unknown as Promise<string[]>
  }
  listCHTables(req: CHListTablesRequest): Promise<CHTableInfo[]> {
    return (App as unknown as { ListCHTables: (req: never) => Promise<CHTableInfo[]> }).ListCHTables(req as unknown as never)
  }
  chPageRows(req: CHPageRowsRequest): Promise<CHPageRowsResult> {
    return (App as unknown as { CHPageRows: (req: never) => Promise<CHPageRowsResult> }).CHPageRows(req as unknown as never)
  }
  chTruncateTable(req: CHTruncateTableRequest): Promise<void> {
    return (App as unknown as { CHTruncateTable: (req: never) => Promise<void> }).CHTruncateTable(req as unknown as never)
  }
  chExecute(req: CHExecuteRequest): Promise<CHStatementResult[]> {
    return (App as unknown as { CHExecute: (req: never) => Promise<CHStatementResult[]> }).CHExecute(req as unknown as never)
  }
  listDrivers(): Promise<DriverInfo[]> {
    return (App as unknown as { ListDrivers: () => Promise<DriverInfo[]> }).ListDrivers() as unknown as Promise<DriverInfo[]>
  }
  // 以下 MySQL/TiDB API 的后端绑定尚未由 wails generate 生成,先对模块形状
  // 断言,待主会话生成绑定后即可直接调用(接口侧为可选成员,fake 无需实现)。
  testMysqlConnection(cfg: MysqlConfigShape): Promise<void> {
    return (App as unknown as { TestMysqlConnection: (cfg: never) => Promise<void> }).TestMysqlConnection(cfg as unknown as never)
  }
  listMysqlDatabases(id: string): Promise<string[]> {
    return (App as unknown as { ListMysqlDatabases: (id: string) => Promise<string[]> }).ListMysqlDatabases(id) as unknown as Promise<string[]>
  }
  listMysqlTables(req: MysqlListTablesRequest): Promise<MysqlTableInfo[]> {
    return (App as unknown as { ListMysqlTables: (req: never) => Promise<MysqlTableInfo[]> }).ListMysqlTables(req as unknown as never)
  }
  mysqlPageRows(req: MysqlPageRowsRequest): Promise<MysqlPageRowsResult> {
    return (App as unknown as { MysqlPageRows: (req: never) => Promise<MysqlPageRowsResult> }).MysqlPageRows(req as unknown as never)
  }
  mysqlExecute(req: MysqlExecuteRequest): Promise<MysqlStatementResult[]> {
    return (App as unknown as { MysqlExecute: (req: never) => Promise<MysqlStatementResult[]> }).MysqlExecute(req as unknown as never)
  }
  mysqlPreviewCellUpdate(req: MysqlCellUpdateRequest): Promise<MysqlCellUpdatePreview> {
    return (App as unknown as { MysqlPreviewCellUpdate: (req: never) => Promise<MysqlCellUpdatePreview> }).MysqlPreviewCellUpdate(req as unknown as never)
  }
  mysqlUpdateCell(req: MysqlCellUpdateRequest): Promise<void> {
    return (App as unknown as { MysqlUpdateCell: (req: never) => Promise<void> }).MysqlUpdateCell(req as unknown as never)
  }
  mysqlTruncateTable(req: MysqlTruncateTableRequest): Promise<void> {
    return (App as unknown as { MysqlTruncateTable: (req: never) => Promise<void> }).MysqlTruncateTable(req as unknown as never)
  }
  // 以下 PostgreSQL API 的后端绑定尚未由 wails generate 生成,先对模块形状
  // 断言,待主会话生成绑定后即可直接调用(接口侧为可选成员,fake 无需实现)。
  testPostgresConnection(cfg: PostgresConfigShape): Promise<void> {
    return (App as unknown as { TestPostgresConnection: (cfg: never) => Promise<void> }).TestPostgresConnection(cfg as unknown as never)
  }
  listPostgresDatabases(id: string): Promise<string[]> {
    return (App as unknown as { ListPostgresDatabases: (id: string) => Promise<string[]> }).ListPostgresDatabases(id) as unknown as Promise<string[]>
  }
  listPostgresSchemas(req: PostgresListSchemasRequest): Promise<string[]> {
    return (App as unknown as { ListPostgresSchemas: (req: never) => Promise<string[]> }).ListPostgresSchemas(req as unknown as never) as unknown as Promise<string[]>
  }
  listPostgresTables(req: PostgresListTablesRequest): Promise<PostgresRelationInfo[]> {
    return (App as unknown as { ListPostgresTables: (req: never) => Promise<PostgresRelationInfo[]> }).ListPostgresTables(req as unknown as never)
  }
  postgresPageRows(req: PostgresPageRowsRequest): Promise<PostgresPageRowsResult> {
    return (App as unknown as { PostgresPageRows: (req: never) => Promise<PostgresPageRowsResult> }).PostgresPageRows(req as unknown as never)
  }
  postgresExecute(req: PostgresExecuteRequest): Promise<PostgresStatementResult[]> {
    return (App as unknown as { PostgresExecute: (req: never) => Promise<PostgresStatementResult[]> }).PostgresExecute(req as unknown as never)
  }
  postgresTruncateTable(req: PostgresTruncateTableRequest): Promise<void> {
    return (App as unknown as { PostgresTruncateTable: (req: never) => Promise<void> }).PostgresTruncateTable(req as unknown as never)
  }
  postgresPreviewCellUpdate(req: PostgresCellUpdateRequest): Promise<PostgresCellUpdatePreview> {
    return (App as unknown as { PostgresPreviewCellUpdate: (req: never) => Promise<PostgresCellUpdatePreview> }).PostgresPreviewCellUpdate(req as unknown as never)
  }
  postgresUpdateCell(req: PostgresCellUpdateRequest): Promise<void> {
    return (App as unknown as { PostgresUpdateCell: (req: never) => Promise<void> }).PostgresUpdateCell(req as unknown as never)
  }

  // 以下 Elasticsearch API 的后端绑定尚未由 wails generate 生成,先对模块形状
  // 断言,待主会话生成绑定后即可直接调用(接口侧为可选成员,fake 无需实现)。
  testEsConnection(cfg: EsConfigShape): Promise<void> {
    return (App as unknown as { TestESConnection: (cfg: never) => Promise<void> }).TestESConnection(cfg as unknown as never)
  }
  listEsIndices(id: string): Promise<EsIndexInfo[]> {
    return (App as unknown as { ListESIndices: (id: string) => Promise<EsIndexInfo[]> }).ListESIndices(id) as unknown as Promise<EsIndexInfo[]>
  }
  esMapping(req: EsMappingRequest): Promise<EsColumn[]> {
    return (App as unknown as { ESMapping: (req: never) => Promise<EsColumn[]> }).ESMapping(req as unknown as never)
  }
  esPageRows(req: EsPageRowsRequest): Promise<EsPageRowsResult> {
    return (App as unknown as { ESPageRows: (req: never) => Promise<EsPageRowsResult> }).ESPageRows(req as unknown as never)
  }
  esExecute(req: EsExecuteRequest): Promise<EsStatementResult[]> {
    return (App as unknown as { ESExecute: (req: never) => Promise<EsStatementResult[]> }).ESExecute(req as unknown as never)
  }
  esGetDoc(req: EsGetDocRequest): Promise<EsDoc> {
    return (App as unknown as { ESGetDoc: (req: never) => Promise<EsDoc> }).ESGetDoc(req as unknown as never)
  }
  esPutDoc(req: EsPutDocRequest): Promise<void> {
    return (App as unknown as { ESPutDoc: (req: never) => Promise<void> }).ESPutDoc(req as unknown as never)
  }

  esCreateDoc(req: EsCreateDocRequest): Promise<EsDoc> {
    // ESCreateDoc 绑定尚未由 wailsjs 生成,先按模块形状断言直连(主控稍后
    // 重生成,生成后签名一致无需改动)。
    return (App as unknown as { ESCreateDoc: (req: never) => Promise<EsDoc> }).ESCreateDoc(req as unknown as never)
  }
  esUpdateCell(req: EsCellUpdateRequest): Promise<void> {
    return (App as unknown as { ESUpdateCell: (req: never) => Promise<void> }).ESUpdateCell(req as unknown as never)
  }
  esDeleteDoc(req: EsDeleteDocRequest): Promise<void> {
    return (App as unknown as { ESDeleteDoc: (req: never) => Promise<void> }).ESDeleteDoc(req as unknown as never)
  }
  esDeleteByQuery(req: EsDeleteByQueryRequest): Promise<number> {
    return (App as unknown as { ESDeleteByQuery: (req: never) => Promise<number> }).ESDeleteByQuery(req as unknown as never)
  }
  // 以下 ES 集合编辑 API 的后端绑定尚未由 wails generate 生成,先对模块形状
  // 断言,待主会话生成绑定后即可直接调用(接口侧为可选成员,fake 无需实现)。
  esCreateIndex(req: EsCreateIndexRequest): Promise<void> {
    return (App as unknown as { EsCreateIndex: (req: never) => Promise<void> }).EsCreateIndex(req as unknown as never)
  }
  esDeleteIndex(req: EsDeleteIndexRequest): Promise<void> {
    return (App as unknown as { EsDeleteIndex: (req: never) => Promise<void> }).EsDeleteIndex(req as unknown as never)
  }
  esUpdateIndexSettings(req: EsUpdateIndexSettingsRequest): Promise<void> {
    return (App as unknown as { EsUpdateIndexSettings: (req: never) => Promise<void> }).EsUpdateIndexSettings(req as unknown as never)
  }
  // esDeleteTemplate 的绑定已由 wailsjs 生成,直接调用。
  esDeleteTemplate(req: EsDeleteTemplateRequest): Promise<void> {
    return App.DeleteEsTemplate(req as unknown as never)
  }
  // 以下 ES 模板/监控 API:模板四个绑定已由 wailsjs 生成,直接调用;
  // esClusterStats 绑定尚未生成,先对模块形状断言,待主会话生成绑定后即可
  // 直接调用(接口侧为可选成员,fake 无需实现)。
  listEsTemplates(id: string): Promise<EsTemplateInfo[]> {
    return App.ListEsTemplates(id) as unknown as Promise<EsTemplateInfo[]>
  }
  getEsTemplate(req: EsGetTemplateRequest): Promise<EsTemplateContent> {
    return App.GetEsTemplate(req as unknown as never) as unknown as Promise<EsTemplateContent>
  }
  putEsTemplate(req: EsPutTemplateRequest): Promise<void> {
    return App.PutEsTemplate(req as unknown as never)
  }
  esClusterStats(req: EsClusterStatsRequest): Promise<EsClusterStats> {
    return (App as unknown as { EsClusterStats: (req: never) => Promise<EsClusterStats> }).EsClusterStats(req as unknown as never)
  }
}

let current: Api = new WailsApi()

export function getApi(): Api {
  return current
}

export function setApi(api: Api): void {
  current = api
}
