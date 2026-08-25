import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getApi } from '@/api/client'
import type { ConsumerGroup, ResetOffsetMode } from '@/api/types'

export interface GroupViewState {
  groups: ConsumerGroup[]
  lag: Record<number, number>
  loading: boolean
  lagLoading: boolean
  resetting: boolean
  error: string | null
  selectedGroup: string | null
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export const useGroupsStore = defineStore('groups', () => {
  const states = ref<Record<string, GroupViewState>>({})

  function stateFor(tabId: string): GroupViewState {
    if (!states.value[tabId]) {
      states.value[tabId] = {
        groups: [],
        lag: {},
        loading: false,
        lagLoading: false,
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

  return { states, stateFor, load, selectGroup, loadLag, resetOffset, clear }
})
