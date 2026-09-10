<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useTabsStore, type Tab } from '@/store/tabs'
import type { Connection } from '@/api/types'
import ConnectionTree from '@/components/common/ConnectionTree.vue'
import CommandPalette from '@/components/common/CommandPalette.vue'
import MessageBrowser from '@/components/kafka/MessageBrowser.vue'
import ConsumerGroupView from '@/components/kafka/ConsumerGroupView.vue'
import ProducerPanel from '@/components/kafka/ProducerPanel.vue'
import SqlConsole from '@/components/kafka/SqlConsole.vue'
import GlobalLagView from '@/components/kafka/GlobalLagView.vue'
import RedisKeysView from '@/components/kafka/RedisKeysView.vue'
import ClusterHealthPanel from '@/components/kafka/ClusterHealthPanel.vue'
import CHTableBrowser from '@/components/kafka/CHTableBrowser.vue'
import CHSqlConsole from '@/components/kafka/CHSqlConsole.vue'
import MysqlTableBrowser from '@/components/kafka/MysqlTableBrowser.vue'
import MysqlSqlConsole from '@/components/kafka/MysqlSqlConsole.vue'
import SettingsPanel from '@/components/settings/SettingsPanel.vue'
import UpdateDialog from './UpdateDialog.vue'
import StatusBar from '@/components/layout/StatusBar.vue'
import QueryFilesPanel, { type SqlConsoleApi } from './QueryFilesPanel.vue'
import { useToastStore } from '@/store/toast'
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
const showUpdate = ref(false)

// toast:全局轻提示浮层,在 Layout 底部居中渲染;自动消失由 store 负责。
const toast = useToastStore()

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

// --- SQL文件右栏 --------------------------------------------------------------
// 与左侧连接栏同款拖拽交互,方向相反:向左拖变宽。宽度与展开状态持久化到
// localStorage,默认收起;每次展开(含启动即展开)让面板 refresh() 拉一次列表。
const FILES_WIDTH_KEY = 'dbclient-files-width'
const FILES_OPEN_KEY = 'dbclient-files-open'
const MIN_FILES_WIDTH = 180
const MAX_FILES_WIDTH = 560
const DEFAULT_FILES_WIDTH = 260

function readStoredFilesWidth(): number {
  const v = Number(localStorage.getItem(FILES_WIDTH_KEY))
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_FILES_WIDTH
  return Math.min(MAX_FILES_WIDTH, Math.max(MIN_FILES_WIDTH, v))
}

const filesOpen = ref(localStorage.getItem(FILES_OPEN_KEY) === '1')
const filesWidth = ref(readStoredFilesWidth())
const filesResizing = ref(false)
const filesPanelRef = ref<InstanceType<typeof QueryFilesPanel> | null>(null)
let filesDragStartX = 0
let filesDragStartWidth = 0

function toggleFilesPanel(): void {
  filesOpen.value = !filesOpen.value
  localStorage.setItem(FILES_OPEN_KEY, filesOpen.value ? '1' : '0')
  if (filesOpen.value) {
    // 等面板挂载完成再刷新,首次展开也能立即拿到文件列表。
    void nextTick(() => filesPanelRef.value?.refresh())
  }
}

// SQL文件面板点击条目:按文件归属的数据源自动打开/切换对应 SQL 控制台并载入。
// 归属连接已删除或不支持 SQL 控制台(如 Redis)时,toast 提示且不动 tab。
async function openQueryFileFromPanel(name: string, connectionId: string): Promise<void> {
  const conn = props.connections.find((c) => c.id === connectionId)
  if (!conn) {
    toast.show('未找到文件关联的数据源,无法打开 SQL 控制台')
    return
  }
  const target: 'sql' | 'ch-sql' | 'mysql-sql' | null =
    conn.type === 'kafka'
      ? 'sql'
      : conn.type === 'clickhouse'
        ? 'ch-sql'
        : conn.type === 'mysql' || conn.type === 'tidb'
          ? 'mysql-sql'
          : null
  if (!target) {
    toast.show('该数据源类型暂不支持 SQL 控制台')
    return
  }
  const act = active.value
  if (act && act.kind === target && act.connectionId === connectionId) {
    activeConsoleApi.value?.loadQueryFile(name)
    return
  }
  if (target === 'ch-sql') {
    tabs.openCHSql(connectionId)
  } else if (target === 'mysql-sql') {
    tabs.openMysqlSql(connectionId)
  } else {
    // Kafka 不带 topic:通用「SQL 查询」tab,表名写在 SQL 的 FROM 子句里。
    tabs.openSql(connectionId, '', [])
  }
  // 等 tab 切换后控制台组件挂载完成,再取它暴露的 API 载入文件。
  await nextTick()
  activeConsoleApi.value?.loadQueryFile(name)
}

function startFilesResize(e: MouseEvent): void {
  filesResizing.value = true
  filesDragStartX = e.clientX
  filesDragStartWidth = filesWidth.value
  window.addEventListener('mousemove', onFilesResize)
  window.addEventListener('mouseup', endFilesResize)
}

function onFilesResize(e: MouseEvent): void {
  const width = filesDragStartWidth - (e.clientX - filesDragStartX)
  filesWidth.value = Math.min(MAX_FILES_WIDTH, Math.max(MIN_FILES_WIDTH, width))
}

function endFilesResize(): void {
  filesResizing.value = false
  localStorage.setItem(FILES_WIDTH_KEY, String(filesWidth.value))
  window.removeEventListener('mousemove', onFilesResize)
  window.removeEventListener('mouseup', endFilesResize)
}

const active = computed<Tab | null>(() => tabs.openTabs.find((t) => t.id === tabs.activeTabId) ?? null)
const activeTopic = computed<Tab | null>(() => (active.value?.kind === 'topic' ? active.value : null))

// SQL文件面板面向「激活的 SQL 控制台」操作:按激活 tab 类型取对应控制台的
// 模板 ref;其余 tab(含无激活 tab)一律没有可操作的控制台。
const sqlConsoleRef = ref<SqlConsoleApi | null>(null)
const chSqlConsoleRef = ref<SqlConsoleApi | null>(null)
const mysqlSqlConsoleRef = ref<SqlConsoleApi | null>(null)

const activeConsoleApi = computed<SqlConsoleApi | null>(() => {
  const a = active.value
  if (!a) return null
  if (a.kind === 'sql') return sqlConsoleRef.value
  if (a.kind === 'ch-sql') return chSqlConsoleRef.value
  if (a.kind === 'mysql-sql') return mysqlSqlConsoleRef.value
  return null
})

// 顶栏「新建查询」:Kafka 系 tab 打开 SQL 控制台(topic tab 预选 topic),
// ClickHouse 系 tab 打开 CH SQL 控制台,MySQL 系 tab 打开 MySQL SQL 控制台;
// redis 或无激活 tab 时禁用。
const canNewQuery = computed(() => active.value !== null && active.value.kind !== 'redis-keys')

function openNewQuery(): void {
  const a = active.value
  if (!a) return
  if (a.kind === 'ch-table' || a.kind === 'ch-sql') {
    tabs.openCHSql(a.connectionId)
    return
  }
  const kind = a.kind
  if (kind === 'mysql-table' || kind === 'mysql-sql') {
    tabs.openMysqlSql(a.connectionId, a.database ?? '')
    return
  }
  tabs.openSql(a.connectionId, a.topic ?? '', a.partitions ?? [])
}

function openTopic(connectionId: string, topic: string, partitions: number[]): void {
  tabs.openTopic(connectionId, topic, partitions)
}

function openGroup(connectionId: string, group: string, topic?: string): void {
  tabs.openGroup(connectionId, group, topic)
}

// Lag 总览行点击:active 一定存在(lag tab 打开时),组定位 tab、Topic 预选。
function openGroupLagFromOverview(group: string, topic: string): void {
  const conn = active.value
  if (!conn) return
  openGroup(conn.connectionId, group, topic)
}

function openRedisKeys(connectionId: string, db: number): void {
  tabs.openRedisKeys(connectionId, db)
}

// ClickHouse 表浏览器:双击树上的表节点打开/聚焦对应 tab。
function openCHTable(connectionId: string, database: string, table: string): void {
  tabs.openCHTable(connectionId, database, table)
}

// MySQL 表浏览器:双击树上的表节点打开/聚焦对应 tab。
function openMysqlTable(connectionId: string, database: string, table: string): void {
  tabs.openMysqlTable(connectionId, database, table)
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

// refreshActive bumps the unified refresh counter for the active tab. sql
// consoles (Kafka, ClickHouse and MySQL) own their editor state and are
// excluded from unified refresh.
function refreshActive(): void {
  if (!active.value) return
  if (
    active.value.kind === 'sql' ||
    active.value.kind === 'ch-sql' ||
    active.value.kind === 'mysql-sql'
  ) {
    return
  }
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
  // 启动即展开时(上次会话遗留状态),让面板立即拉一次文件列表。
  if (filesOpen.value) filesPanelRef.value?.refresh()
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
  <div class="layout" :class="{ resizing, 'files-resizing': filesResizing }" data-test="layout">
    <header class="topbar" data-test="topbar">
      <div class="brand" data-test="brand">🪐 dataBasePro</div>
      <div class="spacer"></div>
      <button
        class="btn ghost"
        type="button"
        data-test="btn-refresh-active"
        :disabled="!active || active.kind === 'sql' || active.kind === 'ch-sql' || active.kind === 'mysql-sql'"
        @click="refreshActive"
      >
        刷新
      </button>
      <button
        class="btn ghost icon-btn"
        type="button"
        data-test="btn-update"
        title="检查更新"
        @click="showUpdate = true"
      >
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
          <path d="M8 2.5v7.2M8 2.5 5.4 5.1M8 2.5l2.6 2.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M3 10.5v1.8c0 .7.5 1.2 1.2 1.2h7.6c.7 0 1.2-.5 1.2-1.2v-1.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>
      <button
        class="btn ghost"
        type="button"
        data-test="btn-new-query"
        :disabled="!canNewQuery"
        :title="canNewQuery ? '新建查询' : '请先打开 Kafka/ClickHouse 连接的标签页'"
        @click="openNewQuery"
      >
        新建查询
      </button>
      <button class="btn ghost" type="button" data-test="btn-settings" @click="showSettings = true">设置</button>
      <button
        class="btn ghost icon-btn"
        type="button"
        data-test="btn-sql-files"
        title="SQL文件"
        @click="toggleFilesPanel"
      >
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
          <path d="M4 1.5h5.2l3.3 3.3v9.7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
          <path d="M9.2 1.5v3.3h3.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
          <path d="M5 8h5.4M5 10.5h4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
      </button>
    </header>

    <div class="body">
      <aside class="sidebar" :style="{ width: `${sidebarWidth}px` }" data-test="sidebar">
        <ConnectionTree
          :connections="props.connections"
          @open-topic="openTopic"
          @open-group="openGroup"
          @open-lag="openLag"
          @open-redis-keys="openRedisKeys"
          @open-health="openHealth"
          @open-ch-table="openCHTable"
          @open-mysql-table="openMysqlTable"
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
          <HomeView v-if="!active" />
          <template v-else-if="active.kind === 'topic'">
            <MessageBrowser
              :tab-id="active.id"
              :connection-id="active.connectionId"
              :topic="active.topic ?? ''"
              :partitions="active.partitions ?? []"
              :refresh-request="refreshRequest"
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
              ref="sqlConsoleRef"
              :tab-id="active.id"
              :connection-id="active.connectionId"
              :topic="active.topic ?? ''"
              :partitions="active.partitions ?? []"
            />
          </template>
          <template v-else-if="active.kind === 'lag'">
            <GlobalLagView
              :connection-id="active.connectionId"
              :refresh-request="refreshRequest"
              @open-group-lag="openGroupLagFromOverview"
            />
          </template>
          <template v-else-if="active.kind === 'redis-keys'">
            <RedisKeysView
              :key="active.id"
              :connection-id="active.connectionId"
              :db="active.db ?? 0"
            />
          </template>
          <template v-else-if="active.kind === 'health'">
            <ClusterHealthPanel :connection-id="active.connectionId" :refresh-request="refreshRequest" />
          </template>
          <template v-else-if="active.kind === 'ch-table'">
            <CHTableBrowser
              :key="active.id"
              :connection-id="active.connectionId"
              :database="active.database ?? ''"
              :table="active.table ?? ''"
            />
          </template>
          <template v-else-if="active.kind === 'ch-sql'">
            <CHSqlConsole
              ref="chSqlConsoleRef"
              :key="active.id"
              :tab-id="active.id"
              :connection-id="active.connectionId"
            />
          </template>
          <template v-else-if="active.kind === 'mysql-table'">
            <MysqlTableBrowser
              :key="active.id"
              :connection-id="active.connectionId"
              :database="active.database ?? ''"
              :table="active.table ?? ''"
            />
          </template>
          <template v-else-if="active.kind === 'mysql-sql'">
            <MysqlSqlConsole
              ref="mysqlSqlConsoleRef"
              :key="active.id"
              :tab-id="active.id"
              :connection-id="active.connectionId"
              :database="active.database ?? ''"
            />
          </template>
        </div>
      </main>

      <div
        v-if="filesOpen"
        class="files-resizer"
        data-test="files-resizer"
        title="拖动调整 SQL文件栏宽度"
        @mousedown.prevent="startFilesResize"
      ></div>

      <aside
        v-if="filesOpen"
        class="files-sidebar"
        :style="{ width: `${filesWidth}px` }"
        data-test="files-sidebar"
      >
        <QueryFilesPanel ref="filesPanelRef" :console-api="activeConsoleApi" @open="openQueryFileFromPanel" />
      </aside>
    </div>

    <StatusBar />

    <!-- 全局轻提示浮层:由 toast store 驱动,底部居中,自动消失在 store 内定时。 -->
    <div v-if="toast.message" class="toast" data-test="toast">{{ toast.message }}</div>

    <ProducerPanel
      v-if="activeTopic"
      :show="showProducer"
      :connection-id="activeTopic.connectionId"
      :topic="activeTopic.topic ?? ''"
      :partitions="activeTopic.partitions ?? []"
      @close="showProducer = false"
    />
    <!-- 设置面板「关于」页点检查更新:沿用已有 UpdateDialog,避免重复弹窗。 -->
    <SettingsPanel :show="showSettings" @close="showSettings = false" @check-update="showUpdate = true" />
    <UpdateDialog :show="showUpdate" @close="showUpdate = false" />
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
          v-if="contextTab.kind !== 'sql' && contextTab.kind !== 'ch-sql' && contextTab.kind !== 'mysql-sql'"
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
.icon-btn { display: inline-flex; align-items: center; justify-content: center; padding: 6px 8px; }
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
.layout.resizing,
.layout.files-resizing {
  cursor: col-resize;
  user-select: none;
  -webkit-user-select: none;
}
.files-resizer {
  width: 5px;
  flex: none;
  cursor: col-resize;
  background: transparent;
  transition: background 0.15s ease;
  position: relative;
  z-index: 5;
}
.files-resizer:hover,
.layout.files-resizing .files-resizer {
  background: var(--accent-soft);
}
.files-sidebar {
  border-left: 1px solid var(--border);
  overflow: auto;
  background: var(--sidebar-bg);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
  flex: none;
}
.toast {
  position: fixed;
  left: 50%;
  bottom: 46px;
  transform: translateX(-50%);
  z-index: 1500;
  max-width: 70vw;
  padding: 8px 16px;
  font-size: 13px;
  color: var(--text);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  pointer-events: none;
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
