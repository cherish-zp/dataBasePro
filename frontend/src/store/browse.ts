import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getApi } from '@/api/client'
import { OffsetEarliest } from '@/api/types'
import type { ConsumeRequest, Message } from '@/api/types'

export interface MessageQuery {
  partition: number // -1 = all partitions
  offset: number // OffsetEarliest / OffsetLatest / absolute offset
  timestampMs: number | null // start time; backend consumes from here
  endTimeMs: number | null // client-side upper bound applied to returned records
  limit: number
}

export interface BrowseState {
  query: MessageQuery
  messages: Message[]
  loading: boolean
  error: string | null
  selected: Message | null
  lastOffset: number
  hasMore: boolean
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export const useBrowseStore = defineStore('browse', () => {
  const states = ref<Record<string, BrowseState>>({})

  function stateFor(tabId: string): BrowseState {
    if (!states.value[tabId]) {
      states.value[tabId] = {
        query: { partition: -1, offset: OffsetEarliest, timestampMs: null, endTimeMs: null, limit: 500 },
        messages: [],
        loading: false,
        error: null,
        selected: null,
        lastOffset: -1,
        hasMore: false,
      }
    }
    return states.value[tabId]
  }

  async function fetch(tabId: string, connectionId: string, topic: string, query?: Partial<MessageQuery>): Promise<void> {
    const st = stateFor(tabId)
    if (query) st.query = { ...st.query, ...query }
    st.loading = true
    st.error = null
    try {
      const req: ConsumeRequest = {
        connection_id: connectionId,
        topic,
        partition: st.query.partition,
        offset: st.query.offset,
        limit: st.query.limit,
      }
      let msgs: Message[]
      if (st.query.timestampMs != null) {
        req.timestamp_ms = st.query.timestampMs
        msgs = await getApi().consumeMessagesByTimestamp(req)
      } else {
        msgs = await getApi().consumeMessages(req)
      }
      const endMs = st.query.endTimeMs
      if (endMs != null) {
        msgs = msgs.filter((m) => m.timestamp <= endMs)
      }
      st.messages = msgs
      st.selected = null
      st.lastOffset = msgs.length ? msgs[msgs.length - 1].offset : -1
      // Cross-partition ("All") fetches do not paginate by offset yet.
      st.hasMore = st.query.partition >= 0 && msgs.length === st.query.limit
    } catch (e) {
      st.error = message(e)
    } finally {
      st.loading = false
    }
  }

  async function fetchMore(tabId: string, connectionId: string, topic: string): Promise<void> {
    const st = stateFor(tabId)
    if (st.query.partition < 0 || st.query.timestampMs != null || st.lastOffset < 0 || st.loading) return
    st.loading = true
    st.error = null
    try {
      const req: ConsumeRequest = {
        connection_id: connectionId,
        topic,
        partition: st.query.partition,
        offset: st.lastOffset + 1,
        limit: st.query.limit,
      }
      const msgs = await getApi().consumeMessages(req)
      const seen = new Set(st.messages.map((m) => `${m.partition}:${m.offset}`))
      for (const m of msgs) {
        const key = `${m.partition}:${m.offset}`
        if (!seen.has(key)) {
          st.messages.push(m)
          seen.add(key)
        }
      }
      st.lastOffset = msgs.length ? msgs[msgs.length - 1].offset : st.lastOffset
      st.hasMore = msgs.length === st.query.limit
    } catch (e) {
      st.error = message(e)
    } finally {
      st.loading = false
    }
  }

  function select(tabId: string, m: Message | null): void {
    stateFor(tabId).selected = m
  }

  function clear(tabId: string): void {
    delete states.value[tabId]
  }

  return { states, stateFor, fetch, fetchMore, select, clear }
})
