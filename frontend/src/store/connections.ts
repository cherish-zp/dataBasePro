import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getApi } from '@/api/client'
import type { Connection, ConnectionType, KafkaConfig } from '@/api/types'

export interface NewConnectionInput {
  name: string
  type: ConnectionType
  config: KafkaConfig
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export const useConnectionsStore = defineStore('connections', () => {
  const connections = ref<Connection[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      connections.value = await getApi().listConnections()
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
    await getApi().connect(id)
  }

  async function disconnect(id: string): Promise<void> {
    error.value = null
    await getApi().disconnect(id)
  }

  return { connections, loading, error, load, create, remove, testConnection, connect, disconnect }
})
