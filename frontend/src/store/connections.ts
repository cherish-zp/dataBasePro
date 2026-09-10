import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getApi } from '@/api/client'
import type { Connection, ConnectionType, KafkaConfig, RedisConfigShape, CHConfigShape } from '@/api/types'

export interface NewConnectionInput {
  name: string
  type: ConnectionType
  config: KafkaConfig | RedisConfigShape | CHConfigShape
}

// ConnectionStatus reflects whether a connection is currently usable. The
// backend pool lives in memory for the app process, so tracking status in the
// store stays perfectly in sync: fresh start is 'unknown' for every saved
// connection, connect()/disconnect() flip it, and successful loads mark a
// connection 'connected' because the backend auto-connects on demand.
export type ConnectionStatus = 'unknown' | 'connecting' | 'connected' | 'error' | 'disconnected'

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export const useConnectionsStore = defineStore('connections', () => {
  const connections = ref<Connection[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const statusById = ref<Record<string, ConnectionStatus>>({})

  function setStatus(id: string, status: ConnectionStatus): void {
    statusById.value[id] = status
  }

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      connections.value = await getApi().listConnections()
      for (const c of connections.value) statusById.value[c.id] = 'unknown'
    } catch (e) {
      error.value = message(e)
    } finally {
      loading.value = false
    }
  }

  async function create(input: NewConnectionInput): Promise<Connection> {
    error.value = null
    const created = await getApi().createConnection({
      id: '',
      name: input.name,
      type: input.type,
      config: input.config,
      created_at: 0,
      updated_at: 0,
    })
    connections.value.push(created)
    return created
  }

  // update 持久化对已有连接的修改并用后端返回的完整记录(保持 id/created_at、
  // 刷新 updated_at)原位替换本地列表项。后端会驱逐该连接的连接池,本地状态
  // 相应重置为 unknown,避免残留过期的 'connected'。
  async function update(id: string, input: NewConnectionInput): Promise<Connection> {
    error.value = null
    // type 必须透传:后端 resolvedType 对空 type 默认 kafka,编辑
    // redis/clickhouse 时不带会走错分支导致保存损坏。
    const updated = await getApi().updateConnection({ id, name: input.name, type: input.type, config: input.config })
    const idx = connections.value.findIndex((c) => c.id === updated.id)
    if (idx !== -1) connections.value[idx] = updated
    statusById.value[updated.id] = 'unknown'
    return updated
  }

  async function remove(id: string): Promise<void> {
    error.value = null
    await getApi().deleteConnection(id)
    connections.value = connections.value.filter((c) => c.id !== id)
    // Drop the per-connection status so the status bar's online count does not
    // stay inflated by a stale 'connected' entry for the removed connection.
    delete statusById.value[id]
  }

  async function testConnection(cfg: KafkaConfig): Promise<void> {
    error.value = null
    await getApi().testConnection(cfg)
  }

  async function connect(id: string): Promise<void> {
    error.value = null
    statusById.value[id] = 'connecting'
    try {
      await getApi().connect(id)
      statusById.value[id] = 'connected'
    } catch (e) {
      statusById.value[id] = 'error'
      error.value = message(e)
    }
  }

  async function disconnect(id: string): Promise<void> {
    error.value = null
    try {
      await getApi().disconnect(id)
      statusById.value[id] = 'disconnected'
    } catch (e) {
      statusById.value[id] = 'error'
      error.value = message(e)
    }
  }

  return { connections, loading, error, statusById, setStatus, load, create, update, remove, testConnection, connect, disconnect }
})
