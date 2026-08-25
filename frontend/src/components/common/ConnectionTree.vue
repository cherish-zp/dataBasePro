<script setup lang="ts">
import { ref } from 'vue'
import { getApi } from '@/api/client'
import type { Connection, Topic, ConsumerGroup } from '@/api/types'

const props = defineProps<{ connections: Connection[] }>()
const emit = defineEmits<{
  (e: 'open-topic', connectionId: string, topic: string, partitions: number[]): void
  (e: 'open-group', connectionId: string, group: string): void
  (e: 'delete', connectionId: string): void
  (e: 'new'): void
}>()

const expanded = ref<Record<string, boolean>>({})
const topicsByConn = ref<Record<string, Topic[]>>({})
const groupsByConn = ref<Record<string, ConsumerGroup[]>>({})
const loadingByConn = ref<Record<string, boolean>>({})
const errorByConn = ref<Record<string, string>>({})

function isExpanded(id: string): boolean {
  return !!expanded.value[id]
}

async function toggle(conn: Connection): Promise<void> {
  const id = conn.id
  const nowExpanded = !expanded.value[id]
  expanded.value[id] = nowExpanded
  if (nowExpanded && !topicsByConn.value[id] && conn.type === 'kafka') {
    await load(id)
  }
}

async function load(connId: string): Promise<void> {
  loadingByConn.value[connId] = true
  errorByConn.value[connId] = ''
  try {
    const [topics, groups] = await Promise.all([
      getApi().listTopics(connId),
      getApi().listConsumerGroups(connId),
    ])
    topicsByConn.value[connId] = topics
    groupsByConn.value[connId] = groups
  } catch (e) {
    errorByConn.value[connId] = e instanceof Error ? e.message : String(e)
  } finally {
    loadingByConn.value[connId] = false
  }
}
</script>

<template>
  <div class="tree" data-test="connection-tree">
    <button class="tree-new" type="button" data-test="btn-new" @click="emit('new')">＋ 新建连接</button>
    <div v-if="connections.length === 0" class="tree-empty" data-test="tree-empty">暂无连接</div>
    <div v-for="conn in connections" :key="conn.id" class="conn" data-test="connection">
      <div class="conn-row">
        <span class="caret" data-test="conn-caret" :class="{ open: isExpanded(conn.id) }" @click="toggle(conn)">
          {{ isExpanded(conn.id) ? '▾' : '▸' }}
        </span>
        <span class="conn-name" data-test="conn-name">{{ conn.name }}</span>
        <span class="conn-type">{{ conn.type }}</span>
        <button class="conn-delete" type="button" data-test="btn-delete" @click="emit('delete', conn.id)">🗑</button>
      </div>
      <div v-if="isExpanded(conn.id) && conn.type === 'kafka'" class="conn-children">
        <div v-if="loadingByConn[conn.id]" class="conn-loading" data-test="tree-loading">加载中…</div>
        <div v-else-if="errorByConn[conn.id]" class="conn-error" data-test="tree-error">{{ errorByConn[conn.id] }}</div>
        <template v-else>
          <div class="group-label">📋 Topics</div>
          <div
            v-for="t in topicsByConn[conn.id] || []"
            :key="t.name"
            class="leaf"
            data-test="topic-node"
            :title="`${t.name} (${t.partitions.length} 分区)`"
            @dblclick="emit('open-topic', conn.id, t.name, t.partitions.map((p) => p.id))"
          >
            {{ t.name }}
          </div>
          <div v-if="(topicsByConn[conn.id] || []).length === 0" class="leaf muted">（无主题）</div>
          <div class="group-label">👥 Consumers</div>
          <div
            v-for="g in groupsByConn[conn.id] || []"
            :key="g.name"
            class="leaf"
            data-test="group-node"
            @dblclick="emit('open-group', conn.id, g.name)"
          >
            {{ g.name }}
          </div>
          <div v-if="(groupsByConn[conn.id] || []).length === 0" class="leaf muted">（无消费组）</div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tree { padding: 8px; font-size: 13px; color: #c3ccd6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
.tree-new { width: 100%; box-sizing: border-box; background: #1f6feb; color: #fff; border: none; border-radius: 6px; padding: 8px; cursor: pointer; margin-bottom: 8px; font-size: 13px; }
.tree-empty { color: #7a8698; padding: 8px; }
.conn { margin-bottom: 2px; }
.conn-row { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
.conn-row:hover { background: #232f3d; }
.caret { width: 14px; color: #9aa7b5; }
.conn-name { font-weight: 600; flex: 1; }
.conn-type { font-size: 11px; color: #6ea8fe; background: #1f6feb22; padding: 1px 6px; border-radius: 4px; }
.conn-delete { background: none; border: none; color: #7a8698; cursor: pointer; }
.conn-children { margin-left: 18px; border-left: 1px solid #2a3542; padding-left: 8px; }
.group-label { font-size: 11px; color: #7a8698; text-transform: uppercase; letter-spacing: 0.04em; margin: 6px 0 2px; }
.leaf { padding: 3px 6px; border-radius: 4px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.leaf:hover { background: #232f3d; color: #fff; }
.leaf.muted { color: #7a8698; cursor: default; }
.conn-loading { color: #9aa7b5; padding: 4px; }
.conn-error { color: #f85149; padding: 4px; }
</style>
