<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTabsStore, type Tab } from '@/store/tabs'
import type { Connection } from '@/api/types'
import ConnectionTree from '@/components/common/ConnectionTree.vue'
import MessageBrowser from '@/components/kafka/MessageBrowser.vue'
import ConsumerGroupView from '@/components/kafka/ConsumerGroupView.vue'
import ProducerPanel from '@/components/kafka/ProducerPanel.vue'
import SqlConsole from '@/components/kafka/SqlConsole.vue'
import SettingsPanel from '@/components/settings/SettingsPanel.vue'
import HomeView from '@/views/HomeView.vue'

const props = defineProps<{ connections: Connection[] }>()
const emit = defineEmits<{
  (e: 'new'): void
  (e: 'delete-connection', id: string): void
}>()

const tabs = useTabsStore()

const showProducer = ref(false)
const showSql = ref(false)
const showSettings = ref(false)

const active = computed<Tab | null>(() => tabs.openTabs.find((t) => t.id === tabs.activeTabId) ?? null)
const activeTopic = computed<Tab | null>(() => (active.value?.kind === 'topic' ? active.value : null))

function openTopic(connectionId: string, topic: string, partitions: number[]): void {
  tabs.openTopic(connectionId, topic, partitions)
}

function openGroup(connectionId: string, group: string): void {
  tabs.openGroup(connectionId, group)
}

function removeConnection(id: string): void {
  for (const t of [...tabs.openTabs]) {
    if (t.connectionId === id) tabs.closeTab(t.id)
  }
  emit('delete-connection', id)
}

function openProducer(): void {
  if (activeTopic.value) showProducer.value = true
}

function openSql(): void {
  if (activeTopic.value) showSql.value = true
}
</script>

<template>
  <div class="layout" data-test="layout">
    <header class="topbar">
      <div class="brand">🪐 dataBasePro</div>
      <div class="spacer"></div>
      <button class="btn ghost" type="button" data-test="btn-sql" :disabled="!activeTopic" @click="openSql">查询控制台</button>
      <button class="btn ghost" type="button" data-test="btn-producer" :disabled="!activeTopic" @click="openProducer">生产消息</button>
      <button class="btn ghost" type="button" data-test="btn-settings" @click="showSettings = true">设置</button>
      <button class="btn primary" type="button" data-test="btn-new" @click="emit('new')">＋ 新建连接</button>
    </header>

    <div class="body">
      <aside class="sidebar">
        <ConnectionTree
          :connections="props.connections"
          @open-topic="openTopic"
          @open-group="openGroup"
          @delete="removeConnection"
          @new="emit('new')"
        />
      </aside>

      <main class="workspace">
        <div v-if="tabs.openTabs.length" class="tabbar">
          <div
            v-for="t in tabs.openTabs"
            :key="t.id"
            class="tab"
            :class="{ active: t.id === tabs.activeTabId }"
            data-test="tab"
            @click="tabs.setActive(t.id)"
          >
            <span class="tab-title">{{ t.title }}</span>
            <button class="tab-close" type="button" data-test="tab-close" @click.stop="tabs.closeTab(t.id)">✕</button>
          </div>
        </div>

        <div class="workspace-body">
          <HomeView v-if="!active" @new="emit('new')" />
          <template v-else-if="active.kind === 'topic'">
            <MessageBrowser
              :tab-id="active.id"
              :connection-id="active.connectionId"
              :topic="active.topic ?? ''"
              :partitions="active.partitions ?? []"
            />
          </template>
          <template v-else-if="active.kind === 'group'">
            <ConsumerGroupView :tab-id="active.id" :connection-id="active.connectionId" />
          </template>
        </div>
      </main>
    </div>

    <ProducerPanel
      v-if="activeTopic"
      :show="showProducer"
      :connection-id="activeTopic.connectionId"
      :topic="activeTopic.topic ?? ''"
      :partitions="activeTopic.partitions ?? []"
      @close="showProducer = false"
    />
    <SqlConsole
      v-if="activeTopic"
      :show="showSql"
      :tab-id="activeTopic.id"
      :connection-id="activeTopic.connectionId"
      :topic="activeTopic.topic ?? ''"
      :partitions="activeTopic.partitions ?? []"
      @close="showSql = false"
    />
    <SettingsPanel :show="showSettings" @close="showSettings = false" />
  </div>
</template>

<style scoped>
.layout {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: transparent;
  color: var(--text);
  font-family: var(--font);
}
.topbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.72);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
  z-index: 10;
}
.brand { font-weight: 600; font-size: 15px; letter-spacing: -0.01em; }
.spacer { flex: 1; }
.btn {
  border-radius: 7px;
  padding: 6px 13px;
  font-size: 13px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease;
}
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn.primary {
  background: var(--accent);
  color: #fff;
  box-shadow: 0 1px 2px rgba(0, 113, 227, 0.3);
}
.btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn.ghost {
  background: transparent;
  color: var(--text);
  border-color: var(--border-strong);
}
.btn.ghost:hover:not(:disabled) { background: var(--bg-hover); }
.body { flex: 1; display: flex; min-height: 0; }
.sidebar {
  width: 272px;
  border-right: 1px solid var(--border);
  overflow: auto;
  background: var(--sidebar-bg);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
}
.workspace { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.tabbar { display: flex; align-items: flex-end; gap: 4px; padding: 8px 12px 0; }
.tab {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 12px;
  border-radius: 9px 9px 0 0;
  cursor: pointer; font-size: 13px; color: var(--text-secondary);
  border: 1px solid transparent; border-bottom: none; max-width: 200px;
  transition: background 0.15s ease, color 0.15s ease;
}
.tab:hover { background: var(--bg-hover); color: var(--text); }
.tab.active {
  background: var(--bg-elevated);
  color: var(--text);
  border-color: var(--border);
  box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.04);
}
.tab-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tab-close {
  background: none; border: none; color: var(--text-tertiary);
  cursor: pointer; font-size: 12px; border-radius: 4px; line-height: 1;
  padding: 1px 3px;
}
.tab-close:hover { color: var(--danger); }
.workspace-body { flex: 1; min-height: 0; overflow: auto; }
</style>
