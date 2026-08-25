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
      <div class="brand">🪐 DB Client</div>
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
  background: #0e141b;
  color: #d6dee8;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid #2a3542;
  background: #121a24;
}
.brand { font-weight: 700; font-size: 15px; }
.spacer { flex: 1; }
.btn { border-radius: 6px; padding: 6px 12px; font-size: 13px; cursor: pointer; border: 1px solid transparent; }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn.primary { background: #1f6feb; color: #fff; }
.btn.ghost { background: transparent; color: #c3ccd6; border-color: #33404f; }
.body { flex: 1; display: flex; min-height: 0; }
.sidebar { width: 280px; border-right: 1px solid #2a3542; overflow: auto; background: #121a24; }
.workspace { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.tabbar { display: flex; gap: 2px; padding: 6px 8px 0; border-bottom: 1px solid #2a3542; background: #121a24; }
.tab {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px; border-radius: 6px 6px 0 0;
  cursor: pointer; font-size: 13px; color: #9aa7b5;
  border: 1px solid transparent; border-bottom: none; max-width: 200px;
}
.tab.active { background: #1b2430; color: #d6dee8; border-color: #2a3542; }
.tab-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tab-close { background: none; border: none; color: #7a8698; cursor: pointer; font-size: 12px; }
.workspace-body { flex: 1; min-height: 0; overflow: auto; }
</style>
