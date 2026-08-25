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
.tree { padding: 8px; font-size: 13px; color: var(--text); font-family: var(--font); }
.tree-new {
  width: 100%; box-sizing: border-box;
  background: var(--accent); color: #fff; border: none;
  border-radius: 8px; padding: 8px; cursor: pointer; margin-bottom: 10px; font-size: 13px;
  box-shadow: 0 1px 2px rgba(0, 113, 227, 0.3);
  transition: background 0.15s ease;
}
.tree-new:hover { background: var(--accent-hover); }
.tree-empty { color: var(--text-tertiary); padding: 10px 8px; }
.conn { margin-bottom: 2px; }
.conn-row { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 8px; cursor: pointer; transition: background 0.12s ease; }
.conn-row:hover { background: var(--bg-hover); }
.caret { width: 14px; color: var(--text-tertiary); font-size: 10px; }
.conn-name { font-weight: 600; flex: 1; color: var(--text); }
.conn-type { font-size: 11px; color: var(--info); background: var(--info-soft); padding: 1px 6px; border-radius: 5px; }
.conn-delete { background: none; border: none; color: var(--text-tertiary); cursor: pointer; border-radius: 4px; padding: 1px 3px; }
.conn-delete:hover { color: var(--danger); background: var(--danger-soft); }
.conn-children { margin-left: 16px; border-left: 1px solid var(--border); padding-left: 8px; }
.group-label { font-size: 11px; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.05em; margin: 8px 0 3px; }
.leaf { padding: 4px 7px; border-radius: 6px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: background 0.12s ease, color 0.12s ease; }
.leaf:hover { background: var(--bg-hover); color: var(--text); }
.leaf.muted { color: var(--text-tertiary); cursor: default; }
.conn-loading { color: var(--text-secondary); padding: 5px; }
.conn-error { color: var(--danger); padding: 5px; }
</style>
