<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTabsStore, type Tab } from '@/store/tabs'
import type { Connection } from '@/api/types'
import ConnectionTree from '@/components/common/ConnectionTree.vue'
import CommandPalette from '@/components/common/CommandPalette.vue'
import MessageBrowser from '@/components/kafka/MessageBrowser.vue'
import ConsumerGroupView from '@/components/kafka/ConsumerGroupView.vue'
import ProducerPanel from '@/components/kafka/ProducerPanel.vue'
import SqlConsole from '@/components/kafka/SqlConsole.vue'
import GlobalLagView from '@/components/kafka/GlobalLagView.vue'
import ClusterHealthPanel from '@/components/kafka/ClusterHealthPanel.vue'
import SettingsPanel from '@/components/settings/SettingsPanel.vue'
import HomeView from '@/views/HomeView.vue'

const props = defineProps<{ connections: Connection[] }>()
const emit = defineEmits<{
  (e: 'new'): void
  (e: 'delete-connection', id: string): void
}>()

const tabs = useTabsStore()

const showProducer = ref(false)
const showSettings = ref(false)

// Sidebar can be resized by dragging the divider so long topic/consumer names
// stay readable. Width is clamped between MIN_SIDEBAR and MAX_SIDEBAR.
const MIN_SIDEBAR = 200
const MAX_SIDEBAR = 640
const sidebarWidth = ref(336)
const resizing = ref(false)
let dragStartX = 0
let dragStartWidth = 0

function startResize(e: MouseEvent): void {
  resizing.value = true
  dragStartX = e.clientX
  dragStartWidth = sidebarWidth.value
  window.addEventListener('mousemove', onResize)
  window.addEventListener('mouseup', endResize)
}

function onResize(e: MouseEvent): void {
  const width = dragStartWidth + (e.clientX - dragStartX)
  sidebarWidth.value = Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, width))
}

function endResize(): void {
  resizing.value = false
  window.removeEventListener('mousemove', onResize)
  window.removeEventListener('mouseup', endResize)
}

const active = computed<Tab | null>(() => tabs.openTabs.find((t) => t.id === tabs.activeTabId) ?? null)
const activeTopic = computed<Tab | null>(() => (active.value?.kind === 'topic' ? active.value : null))

function openTopic(connectionId: string, topic: string, partitions: number[]): void {
  tabs.openTopic(connectionId, topic, partitions)
}

function openGroup(connectionId: string, group: string): void {
  tabs.openGroup(connectionId, group)
}

function openLag(connectionId: string): void {
  tabs.openLag(connectionId)
}

function openHealth(connectionId: string): void {
  tabs.openHealth(connectionId)
}

function removeConnection(id: string): void {
  for (const t of [...tabs.openTabs]) {
    if (t.connectionId === id) tabs.closeTab(t.id)
  }
  emit('delete-connection', id)
}

function openProducerPanel(): void {
  showProducer.value = true
}

function openSqlTab(): void {
  if (activeTopic.value) {
    tabs.openSql(activeTopic.value.connectionId, activeTopic.value.topic ?? '', activeTopic.value.partitions ?? [])
  }
}
</script>

<template>
  <div class="layout" :class="{ resizing }" data-test="layout">
    <header class="topbar" data-test="topbar">
      <div class="brand" data-test="brand">🪐 dataBasePro</div>
      <div class="spacer"></div>
      <button class="btn ghost" type="button" data-test="btn-settings" @click="showSettings = true">设置</button>
    </header>

    <div class="body">
      <aside class="sidebar" :style="{ width: `${sidebarWidth}px` }" data-test="sidebar">
        <ConnectionTree
          :connections="props.connections"
          @open-topic="openTopic"
          @open-group="openGroup"
          @open-lag="openLag"
          @open-health="openHealth"
          @delete="removeConnection"
          @new="emit('new')"
        />
      </aside>

      <div
        class="sidebar-resizer"
        data-test="sidebar-resizer"
        title="拖动调整侧边栏宽度"
        @mousedown.prevent="startResize"
      ></div>

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
              @open-sql="openSqlTab"
              @open-producer="openProducerPanel"
            />
          </template>
          <template v-else-if="active.kind === 'group'">
            <ConsumerGroupView :tab-id="active.id" :connection-id="active.connectionId" :group="active.group ?? ''" />
          </template>
          <template v-else-if="active.kind === 'sql'">
            <SqlConsole
              :tab-id="active.id"
              :connection-id="active.connectionId"
              :topic="active.topic ?? ''"
              :partitions="active.partitions ?? []"
            />
          </template>
          <template v-else-if="active.kind === 'lag'">
            <GlobalLagView :connection-id="active.connectionId" />
          </template>
          <template v-else-if="active.kind === 'health'">
            <ClusterHealthPanel :connection-id="active.connectionId" />
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
    <SettingsPanel :show="showSettings" @close="showSettings = false" />
    <CommandPalette />
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
  width: 336px;
  border-right: none;
  overflow: auto;
  background: var(--sidebar-bg);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
  flex: none;
}
.sidebar-resizer {
  width: 5px;
  flex: none;
  cursor: col-resize;
  background: transparent;
  transition: background 0.15s ease;
  position: relative;
  z-index: 5;
}
.sidebar-resizer:hover,
.layout.resizing .sidebar-resizer {
  background: var(--accent-soft);
}
.layout.resizing {
  cursor: col-resize;
  user-select: none;
  -webkit-user-select: none;
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
