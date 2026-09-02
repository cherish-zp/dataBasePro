<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
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
import StatusBar from '@/components/layout/StatusBar.vue'
import HomeView from '@/views/HomeView.vue'

const props = defineProps<{ connections: Connection[] }>()
const emit = defineEmits<{
  (e: 'new'): void
  (e: 'delete-connection', id: string): void
  (e: 'edit-connection', conn: Connection): void
}>()

const tabs = useTabsStore()

// refreshRequest drives the unified refresh: the top bar 刷新 button (and the
// tab context menu's 刷新 item) bump the counter, and each data panel watches
// its refreshRequest prop to re-run its own fetch. It only ever increments,
// so a mount never double-fetches.
const refreshRequest = ref(0)

// Tab right-click menu state: the targeted tab plus the cursor position where
// the fixed-position menu should render.
const contextTab = ref<Tab | null>(null)
const contextX = ref(0)
const contextY = ref(0)
const contextMenuEl = ref<HTMLElement | null>(null)

// Drag-reorder state: the openTabs index currently being dragged.
const dragFrom = ref<number | null>(null)

const showProducer = ref(false)
const showSettings = ref(false)

// paletteRef drives the command palette from the global shortcut handler: ⌘K
// toggles it through the exposed toggle(), keeping a single keydown owner.
const paletteRef = ref<InstanceType<typeof CommandPalette> | null>(null)

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

function editConnection(conn: Connection): void {
  emit('edit-connection', conn)
}

function openProducerPanel(): void {
  showProducer.value = true
}

function openSqlTab(): void {
  if (activeTopic.value) {
    tabs.openSql(activeTopic.value.connectionId, activeTopic.value.topic ?? '', activeTopic.value.partitions ?? [])
  }
}

// refreshActive bumps the unified refresh counter for the active tab. sql
// consoles own their editor state and are excluded from unified refresh.
function refreshActive(): void {
  if (!active.value || active.value.kind === 'sql') return
  refreshRequest.value++
}

// --- Tab right-click context menu -------------------------------------------

// Menu is 130px min-width and up to 4 items tall; clamp the cursor position so
// a tab bar near the right/bottom edge cannot push it off-screen.
const CONTEXT_MENU_W = 160
const CONTEXT_MENU_H = 180

function openTabContextMenu(e: MouseEvent, t: Tab): void {
  contextTab.value = t
  contextX.value = Math.max(0, Math.min(e.clientX, window.innerWidth - CONTEXT_MENU_W))
  contextY.value = Math.max(0, Math.min(e.clientY, window.innerHeight - CONTEXT_MENU_H))
}

function closeContextMenu(): void {
  contextTab.value = null
}

// onDocClick closes the tab context menu on clicks landing outside of it.
function onDocClick(e: MouseEvent): void {
  if (contextTab.value && contextMenuEl.value && !contextMenuEl.value.contains(e.target as Node)) {
    closeContextMenu()
  }
}

// onGlobalKeydown is the app-wide shortcut owner (registered once on mount,
// removed on unmount): ⌘K toggles the command palette, ⌘R refreshes the active
// tab, ⌘D closes it, and Escape closes the tab context menu. Modifier combos
// guard against IME composition; ⌘R/⌘D are additionally ignored while focus
// sits in an editable field so typing can never refresh or close a tab. Escape
// (no modifier) always processes, so the context menu can close even mid-IME.
function onGlobalKeydown(e: KeyboardEvent): void {
  const mod = e.metaKey || e.ctrlKey
  if (mod && (e.isComposing || e.keyCode === 229)) return
  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    paletteRef.value?.toggle()
    return
  }
  const target = e.target instanceof HTMLElement ? e.target : null
  const editing =
    target !== null &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  if (!editing && mod && e.key.toLowerCase() === 'r') {
    e.preventDefault()
    refreshActive()
    return
  }
  if (!editing && mod && e.key.toLowerCase() === 'd') {
    e.preventDefault()
    if (tabs.activeTabId) tabs.closeTab(tabs.activeTabId)
    return
  }
  if (e.key === 'Escape') closeContextMenu()
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  window.addEventListener('keydown', onGlobalKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  window.removeEventListener('keydown', onGlobalKeydown)
})

function contextClose(): void {
  if (!contextTab.value) return
  tabs.closeTab(contextTab.value.id)
  closeContextMenu()
}

function contextCloseOthers(): void {
  if (!contextTab.value) return
  tabs.closeOthers(contextTab.value.id)
  closeContextMenu()
}

function contextCloseAll(): void {
  tabs.closeAll()
  closeContextMenu()
}

// contextRefresh refreshes the right-clicked tab through the same unified path
// as the top bar button. An already-active tab bumps refreshRequest directly;
// switching to another tab fetches on its own (the panel mounts or its
// connection/topic watch fires), so bumping there too would double-fetch.
function contextRefresh(): void {
  const target = contextTab.value
  if (!target) return
  const wasActive = tabs.activeTabId === target.id
  tabs.setActive(target.id)
  if (wasActive) refreshRequest.value++
  closeContextMenu()
}

// --- Tab drag reorder --------------------------------------------------------

function onTabDragStart(e: DragEvent, from: number): void {
  dragFrom.value = from
  // Firefox needs a payload to initiate a drag; the drop is consumed anyway.
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', '')
  }
}

function onTabDragOver(e: DragEvent, to: number): void {
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
}

function onTabDrop(_e: DragEvent, to: number): void {
  const from = dragFrom.value
  if (from == null || from === to) return
  // Dropping onto the tab at index `to` lands the dragged tab where that
  // target currently sits; dragging rightwards shifts the target left by one
  // after the removal.
  tabs.move(from, from < to ? to - 1 : to)
  dragFrom.value = null
}

function onTabDragEnd(): void {
  dragFrom.value = null
}
</script>

<template>
  <div class="layout" :class="{ resizing }" data-test="layout">
    <header class="topbar" data-test="topbar">
      <div class="brand" data-test="brand">🪐 dataBasePro</div>
      <div class="spacer"></div>
      <button
        class="btn ghost"
        type="button"
        data-test="btn-refresh-active"
        :disabled="!active || active.kind === 'sql'"
        @click="refreshActive"
      >
        刷新
      </button>
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
          @edit-connection="editConnection"
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
            v-for="(t, i) in tabs.openTabs"
            :key="t.id"
            class="tab"
            :class="{ active: t.id === tabs.activeTabId, dragging: dragFrom === i }"
            data-test="tab"
            draggable="true"
            @click="tabs.setActive(t.id)"
            @contextmenu.prevent.stop="openTabContextMenu($event, t)"
            @dragstart="onTabDragStart($event, i)"
            @dragover.prevent="onTabDragOver($event, i)"
            @drop.prevent="onTabDrop($event, i)"
            @dragend="onTabDragEnd"
          >
            <span class="tab-title" data-test="tab-title">{{ t.title }}</span>
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
              :refresh-request="refreshRequest"
              @open-sql="openSqlTab"
              @open-producer="openProducerPanel"
            />
          </template>
          <template v-else-if="active.kind === 'group'">
            <ConsumerGroupView
              :tab-id="active.id"
              :connection-id="active.connectionId"
              :group="active.group ?? ''"
              :refresh-request="refreshRequest"
            />
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
            <GlobalLagView :connection-id="active.connectionId" :refresh-request="refreshRequest" />
          </template>
          <template v-else-if="active.kind === 'health'">
            <ClusterHealthPanel :connection-id="active.connectionId" :refresh-request="refreshRequest" />
          </template>
        </div>
      </main>
    </div>

    <StatusBar />

    <ProducerPanel
      v-if="activeTopic"
      :show="showProducer"
      :connection-id="activeTopic.connectionId"
      :topic="activeTopic.topic ?? ''"
      :partitions="activeTopic.partitions ?? []"
      @close="showProducer = false"
    />
    <SettingsPanel :show="showSettings" @close="showSettings = false" />
    <CommandPalette ref="paletteRef" />

    <!-- Tab context menu. Teleported to <body> so a backdrop-filter ancestor
         cannot confine the fixed positioning (same rationale as the command
         palette). It renders at the cursor and closes on outside click or
         Escape; the 刷新 item is omitted for sql tabs, which own their editor
         state and are excluded from unified refresh. -->
    <Teleport to="body">
      <div
        v-if="contextTab"
        ref="contextMenuEl"
        class="tab-context-menu"
        data-test="tab-context-menu"
        :style="{ left: `${contextX}px`, top: `${contextY}px` }"
        @click.stop
        @contextmenu.prevent.stop
      >
        <button class="context-item" type="button" data-test="context-close" @click="contextClose">关闭</button>
        <button class="context-item" type="button" data-test="context-close-others" @click="contextCloseOthers">
          关闭其他
        </button>
        <button class="context-item" type="button" data-test="context-close-all" @click="contextCloseAll">关闭全部</button>
        <button
          v-if="contextTab.kind !== 'sql'"
          class="context-item"
          type="button"
          data-test="context-refresh"
          @click="contextRefresh"
        >
          刷新
        </button>
      </div>
    </Teleport>
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
.tab.dragging {
  opacity: 0.5;
  border-color: var(--accent);
}
.tab-context-menu {
  position: fixed;
  z-index: 1200;
  min-width: 130px;
  display: flex;
  flex-direction: column;
  padding: 4px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
}
.context-item {
  text-align: left;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--text);
  font-size: 13px;
  font-family: var(--font);
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  transition: background 0.1s ease;
}
.context-item:hover { background: var(--bg-hover); }
.workspace-body { flex: 1; min-height: 0; overflow: auto; }
</style>
