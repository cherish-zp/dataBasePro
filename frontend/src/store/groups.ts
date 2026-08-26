import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getApi } from '@/api/client'
import type { ActiveProducer, ConsumerGroup, ResetOffsetMode } from '@/api/types'

export interface GroupViewState {
  groups: ConsumerGroup[]
  lag: Record<number, number>
  producers: ActiveProducer[]
  producersNote: string
  loading: boolean
  lagLoading: boolean
  membersLoading: boolean
  resetting: boolean
  error: string | null
  selectedGroup: string | null
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// settle resolves a promise and returns [value, error] so the two member
// panels can degrade independently instead of failing the whole refresh.
async function settle<T>(p: Promise<T>): Promise<[T | undefined, unknown]> {
  try {
    return [await p, undefined]
  } catch (e) {
    return [undefined, e]
  }
}

// noteFor turns a per-panel error into a short note. Brokers that predate
// KIP-664 (Kafka 3.0) cannot serve DescribeProducers, so surface a friendly
// hint instead of a hard error.
function noteFor(e: unknown): string {
  if (!e) return ''
  const msg = message(e)
  if (/broker is too old|unsupported_version|not supported/i.test(msg)) {
    return '当前 Kafka 版本不支持该查询（需 Kafka 3.0+）'
  }
  return msg
}

export const useGroupsStore = defineStore('groups', () => {
  const states = ref<Record<string, GroupViewState>>({})

  function stateFor(tabId: string): GroupViewState {
    if (!states.value[tabId]) {
      states.value[tabId] = {
        groups: [],
        lag: {},
        producers: [],
        producersNote: '', 
        loading: false,
        lagLoading: false,
        membersLoading: false,
        resetting: false,
        error: null,
        selectedGroup: null,
      }
    }
    return states.value[tabId]
  }

  async function load(tabId: string, connectionId: string): Promise<void> {
    const st = stateFor(tabId)
    st.loading = true
    st.error = null
    try {
      st.groups = await getApi().listConsumerGroups(connectionId)
      st.selectedGroup = st.groups[0]?.name ?? null
    } catch (e) {
      st.error = message(e)
    } finally {
      st.loading = false
    }
  }

  async function selectGroup(tabId: string, group: string): Promise<void> {
    stateFor(tabId).selectedGroup = group
  }

  async function loadLag(tabId: string, connectionId: string, topic: string, group: string): Promise<void> {
    const st = stateFor(tabId)
    st.lagLoading = true
    st.error = null
    try {
      st.lag = await getApi().getPartitionLag(connectionId, topic, group)
    } catch (e) {
      st.error = message(e)
    } finally {
      st.lagLoading = false
    }
  }

  async function loadActiveProducers(tabId: string, connectionId: string, group: string, topic: string): Promise<void> {
    const st = stateFor(tabId)
    st.producersNote = ''
    if (!group || !topic) {
      st.producers = []
      return
    }
    st.membersLoading = true
    const [producers, err] = await settle(getApi().listActiveProducers({ connection_id: connectionId, group, topic }))
    st.producers = producers ?? []
    st.producersNote = noteFor(err)
    st.membersLoading = false
  }

  async function resetOffset(
    tabId: string,
    connectionId: string,
    group: string,
    topic: string,
    mode: ResetOffsetMode,
    timestampMs?: number,
  ): Promise<void> {
    const st = stateFor(tabId)
    st.resetting = true
    st.error = null
    try {
      await getApi().resetConsumerGroupOffset({
        connection_id: connectionId,
        group,
        topic,
        mode,
        timestamp_ms: timestampMs,
      })
      await load(tabId, connectionId)
    } catch (e) {
      st.error = message(e)
    } finally {
      st.resetting = false
    }
  }

  function clear(tabId: string): void {
    delete states.value[tabId]
  }

  return { states, stateFor, load, selectGroup, loadLag, loadActiveProducers, resetOffset, clear }
})
