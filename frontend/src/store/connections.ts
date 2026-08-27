import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getApi } from '@/api/client'
import type { Connection, ConnectionType, KafkaConfig } from '@/api/types'

export interface NewConnectionInput {
  name: string
  type: ConnectionType
  config: KafkaConfig
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

  async function remove(id: string): Promise<void> {
    error.value = null
    await getApi().deleteConnection(id)
    connections.value = connections.value.filter((c) => c.id !== id)
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

  return { connections, loading, error, statusById, setStatus, load, create, remove, testConnection, connect, disconnect }
})
