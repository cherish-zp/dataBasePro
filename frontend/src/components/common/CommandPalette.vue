<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { getApi } from '@/api/client'
import type { Connection, ConsumerGroup, Topic } from '@/api/types'
import { fuzzyScore } from '@/utils/fuzzy'
import { useConnectionsStore } from '@/store/connections'
import { useTabsStore } from '@/store/tabs'

// One connection's searchable entries, cached on the component for the whole
// app session (the palette stays mounted; only its overlay opens and closes).
interface ConnEntries {
  topics: Topic[]
  groups: ConsumerGroup[]
}

// A merged search hit across all kafka connections.
interface PaletteResult {
  key: string
  kind: 'topic' | 'group'
  name: string
  connId: string
  connName: string
}

const connStore = useConnectionsStore()
const tabs = useTabsStore()

const RESULT_LIMIT = 50

const open = ref(false)
const query = ref('')
const cursor = ref(0)
const inputEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)

const entriesByConn = reactive<Record<string, ConnEntries>>({})
const loadingByConn = reactive<Record<string, boolean>>({})
const errorByConn = reactive<Record<string, string>>({})

const kafkaConns = computed(() => connStore.connections.filter((c) => c.type === 'kafka'))
const hasQuery = computed(() => query.value.trim().length > 0)

// results merges every cached connection's topics and groups that fuzzy-match
// the query, sorted by ascending fuzzyScore (lower = better). Ties keep
// insertion order: topics before groups, connections in store order.
const results = computed<(PaletteResult & { score: number })[]>(() => {
  const q = query.value.trim()
  if (!q) return []
  const items: (PaletteResult & { score: number })[] = []
  for (const conn of kafkaConns.value) {
    const entry = entriesByConn[conn.id]
    if (!entry) continue
    for (const t of entry.topics) {
      const score = fuzzyScore(q, t.name)
      if (score !== Infinity) {
        items.push({ key: `topic:${conn.id}:${t.name}`, kind: 'topic', name: t.name, connId: conn.id, connName: conn.name, score })
      }
    }
    for (const g of entry.groups) {
      const score = fuzzyScore(q, g.name)
      if (score !== Infinity) {
        items.push({ key: `group:${conn.id}:${g.name}`, kind: 'group', name: g.name, connId: conn.id, connName: conn.name, score })
      }
    }
  }
  return items.sort((a, b) => a.score - b.score)
})

const visibleResults = computed(() => results.value.slice(0, RESULT_LIMIT))
const remainingCount = computed(() => Math.max(0, results.value.length - RESULT_LIMIT))

// activeIndex clamps the raw cursor so a shrinking result list can never
// leave the highlight out of bounds.
const activeIndex = computed(() => {
  const n = visibleResults.value.length
  return n === 0 ? -1 : Math.min(cursor.value, n - 1)
})

// fetchConn loads both entry kinds of one connection in parallel. Failures
// propagate so callers can decide whether to surface them.
async function fetchConn(connId: string): Promise<void> {
  const [topics, groups] = await Promise.all([
    getApi().listTopics(connId),
    getApi().listConsumerGroups(connId),
  ])
  entriesByConn[connId] = { topics, groups }
}

// ensureLoaded fills a cache miss with a visible per-connection loading state,
// or — on a cache hit — revalidates silently in the background (SWR): the
// palette opens instantly from the stale cache and updates when done.
async function ensureLoaded(conn: Connection): Promise<void> {
  if (entriesByConn[conn.id]) {
    void fetchConn(conn.id).catch(() => {
      // A failed background refresh keeps serving the stale cache.
    })
    return
  }
  if (loadingByConn[conn.id]) return
  loadingByConn[conn.id] = true
  errorByConn[conn.id] = ''
  try {
    await fetchConn(conn.id)
  } catch (e) {
    errorByConn[conn.id] = e instanceof Error ? e.message : String(e)
  } finally {
    loadingByConn[conn.id] = false
  }
}

function openPalette(): void {
  open.value = true
  query.value = ''
  cursor.value = 0
  for (const conn of kafkaConns.value) void ensureLoaded(conn)
  void nextTick(() => inputEl.value?.focus())
}

function close(): void {
  open.value = false
  query.value = ''
}

function toggle(): void {
  if (open.value) close()
  else openPalette()
}

// onGlobalKeydown binds ⌘K/Ctrl+K anywhere in the app. Escape is handled here
// too so closing works no matter where the focus sits.
function onGlobalKeydown(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    toggle()
    return
  }
  if (open.value && e.key === 'Escape') {
    e.preventDefault()
    close()
  }
}

onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown))

// move shifts the highlight with wrap-around in both directions.
function move(delta: number): void {
  const n = visibleResults.value.length
  if (n === 0) return
  cursor.value = (activeIndex.value + delta + n) % n
}

// onInputKeydown handles the input's keys with an IME guard: while a
// composition is in progress (e.g. typing Chinese) Enter commits the candidate
// and the arrows navigate candidates, so those keydowns must be left to the
// IME — no action and no preventDefault. keyCode 229 is the legacy composing
// signal (Safari).
function onInputKeydown(e: KeyboardEvent): void {
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    move(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    move(-1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    chooseActive()
  }
}

function choose(item: PaletteResult): void {
  if (item.kind === 'topic') tabs.openTopic(item.connId, item.name)
  else tabs.openGroup(item.connId, item.name)
  close()
}

function chooseActive(): void {
  const item = visibleResults.value[activeIndex.value]
  if (item) choose(item)
}

watch(query, () => {
  cursor.value = 0
})

// Keep the highlighted row visible while navigating or while background
// refreshes change the list. The optional call keeps jsdom safe.
watch([activeIndex, results, open], async () => {
  await nextTick()
  listEl.value?.querySelector('.palette-item.active')?.scrollIntoView?.({ block: 'nearest' })
})
</script>

<template>
  <!-- Teleport to <body>: same rationale as ConfirmDialog — backdrop-filter
       ancestors would confine position:fixed, and the palette must be able to
       overlay every workspace tab. -->
  <Teleport to="body">
    <div v-if="open" class="palette-backdrop" data-test="command-palette" @click.self="close">
      <div class="palette" data-test="palette-panel" @click.stop>
        <input
          ref="inputEl"
          v-model="query"
          class="palette-input"
          type="text"
          data-test="palette-input"
          placeholder="搜索 Topic / 消费组…"
          autocapitalize="off"
          autocorrect="off"
          autocomplete="off"
          spellcheck="false"
          @keydown="onInputKeydown"
        />
        <div ref="listEl" class="palette-list">
          <div v-if="!hasQuery" class="palette-note muted" data-test="palette-empty">输入以搜索 Topic / 消费组</div>
          <template v-for="conn in kafkaConns" :key="conn.id">
            <div v-if="loadingByConn[conn.id]" class="palette-note" data-test="palette-loading">{{ conn.name }} 加载中…</div>
            <div v-else-if="errorByConn[conn.id]" class="palette-note error" data-test="palette-error">
              {{ conn.name }}：{{ errorByConn[conn.id] }}
            </div>
          </template>
          <template v-if="hasQuery">
            <div
              v-for="(item, i) in visibleResults"
              :key="item.key"
              class="palette-item"
              :class="{ active: i === activeIndex }"
              data-test="palette-item"
              @click="choose(item)"
              @mousemove="cursor = i"
            >
              <span class="badge" :class="item.kind === 'topic' ? 'badge-topic' : 'badge-group'">
                {{ item.kind === 'topic' ? 'Topic' : 'Group' }}
              </span>
              <span class="item-name">{{ item.name }}</span>
              <span class="item-conn">{{ item.connName }}</span>
            </div>
            <div v-if="visibleResults.length === 0" class="palette-note muted" data-test="palette-empty">无匹配结果</div>
            <div v-if="remainingCount > 0" class="palette-note muted" data-test="palette-more">还有 {{ remainingCount }} 条…</div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.palette-backdrop {
  /* Sits above every other overlay (drawers 1000, modals 900) so the palette
     stays visible — and dismissible — even with a drawer or modal open. */
  position: fixed; inset: 0; z-index: 1100;
  background: rgba(0, 0, 0, 0.32);
  -webkit-backdrop-filter: blur(2px);
  backdrop-filter: blur(2px);
  display: flex; align-items: flex-start; justify-content: center;
  padding-top: 12vh;
}
.palette {
  width: 560px; max-width: calc(100vw - 48px); max-height: 70vh;
  display: flex; flex-direction: column;
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: 14px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.18);
  overflow: hidden;
}
.palette-input {
  border: none; outline: none; background: transparent; color: var(--text);
  font-size: 15px; padding: 14px 16px; border-bottom: 1px solid var(--border);
  font-family: var(--font);
}
.palette-input::placeholder { color: var(--text-tertiary); }
.palette-list { overflow-y: auto; padding: 6px; }
.palette-note { font-size: 12px; color: var(--text-secondary); padding: 6px 10px; }
.palette-note.muted { color: var(--text-tertiary); }
.palette-note.error { color: var(--danger); }
.palette-item {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 10px; border-radius: 8px; cursor: pointer;
  transition: background 0.12s ease;
}
.palette-item.active { background: var(--accent-soft); }
.badge {
  flex: none; font-size: 10px; font-weight: 600; letter-spacing: 0.02em;
  padding: 1px 7px; border-radius: 5px;
}
.badge-topic { color: var(--info); background: var(--info-soft); }
.badge-group { color: var(--ok); background: var(--ok-soft); }
.item-name {
  flex: 1; min-width: 0; font-size: 13px; color: var(--text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.item-conn {
  flex: none; max-width: 30%; font-size: 11px; color: var(--text-tertiary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
</style>
