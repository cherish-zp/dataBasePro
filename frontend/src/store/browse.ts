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

// A pending jump target: the offset the user jumped to, used to highlight the
// matching record (or the nearest one) once the results render.
export interface JumpTarget {
  offset: number
}

export interface BrowseState {
  query: MessageQuery
  messages: Message[]
  loading: boolean
  error: string | null
  selected: Message | null
  lastOffset: number
  hasMore: boolean
  target: JumpTarget | null
  // Monotonic counter bumped after each successful jump so consumers can
  // re-scroll to the target even when its key is unchanged (e.g. jumping to
  // the same offset again after the view scrolled away).
  scrollRequest: number
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function rowKey(m: Message): string {
  return `${m.partition}:${m.offset}`
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
        target: null,
        scrollRequest: 0,
      }
    }
    return states.value[tabId]
  }

  async function fetch(
    tabId: string,
    connectionId: string,
    topic: string,
    query?: Partial<MessageQuery>,
    opts?: { jumpOffset?: number },
  ): Promise<void> {
    const st = stateFor(tabId)
    if (opts?.jumpOffset != null) {
      // A jump runs the offset query path from the entered offset (any time
      // range does not apply). The highlight target is recorded only once the
      // fetch succeeds, so a failed jump leaves any previous highlight intact.
      st.query = { ...st.query, offset: opts.jumpOffset, timestampMs: null, endTimeMs: null }
    } else {
      // Regular queries clear any previous jump highlight.
      st.target = null
    }
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
      if (opts?.jumpOffset != null) {
        st.target = { offset: opts.jumpOffset }
        st.scrollRequest += 1
      }
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

  // jumpToOffset runs a fetch from the entered absolute offset and highlights
  // the record at that offset once results arrive. An optional query partial
  // (e.g. the partition/limit currently picked in the filter bar) is merged
  // in; the jump itself always fixes the starting offset and clears the time
  // range.
  async function jumpToOffset(
    tabId: string,
    connectionId: string,
    topic: string,
    offset: number,
    query?: Partial<MessageQuery>,
  ): Promise<void> {
    await fetch(tabId, connectionId, topic, query, { jumpOffset: offset })
  }

  // targetKey resolves the row to highlight for a tab: the record matching the
  // jumped offset (falling back to the first returned record when the offset
  // is missing, e.g. compacted), or — for time-based queries — the first
  // returned record (earliest at/after the start). Null when there is nothing
  // to highlight.
  function targetKey(tabId: string): string | null {
    const st = stateFor(tabId)
    if (!st.messages.length) return null
    const target = st.target
    if (target) {
      const exact = st.messages.find((m) => m.offset === target.offset)
      return rowKey(exact ?? st.messages[0])
    }
    if (st.query.timestampMs != null) return rowKey(st.messages[0])
    return null
  }

  function clear(tabId: string): void {
    delete states.value[tabId]
  }

  return { states, stateFor, fetch, fetchMore, select, clear, jumpToOffset, targetKey }
})
