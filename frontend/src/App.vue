<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useConnectionsStore } from '@/store/connections'
import type { Connection } from '@/api/types'
import Layout from '@/components/layout/Layout.vue'
import NewConnectionModal from '@/components/connection/NewConnectionModal.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const store = useConnectionsStore()
const showNew = ref(false)
// editing 携带被编辑的连接:非 null 时 NewConnectionModal 进入编辑模式并预填。
const editing = ref<Connection | null>(null)
// pendingDelete 记录待删除的连接(id+名称):树上点 🗑 先弹应用内确认
// (window.confirm 在 WKWebView 中不可用),确认后才真正调 store.remove。
const pendingDelete = ref<{ id: string; name: string } | null>(null)

const deleteConfirmMessage = computed(() =>
  pendingDelete.value
    ? `确认删除连接「${pendingDelete.value.name}」？连接配置将被移除，此操作不可恢复。`
    : '',
)

onMounted(() => {
  void store.load()
})

function openNew(): void {
  editing.value = null
  showNew.value = true
}

function openEdit(conn: Connection): void {
  editing.value = conn
  showNew.value = true
}

function closeModal(): void {
  showNew.value = false
  editing.value = null
}

function askRemoveConnection(id: string): void {
  const conn = store.connections.find((c) => c.id === id)
  if (!conn) return
  pendingDelete.value = { id, name: conn.name }
}

async function confirmRemove(): Promise<void> {
  const target = pendingDelete.value
  if (!target) return
  pendingDelete.value = null
  await store.remove(target.id)
}
</script>

<template>
  <div class="app-root">
    <Layout
      :connections="store.connections"
      @new="openNew"
      @delete-connection="askRemoveConnection"
      @edit-connection="openEdit"
    />
    <NewConnectionModal :show="showNew" :connection="editing" @close="closeModal" />
    <ConfirmDialog
      :show="!!pendingDelete"
      :message="deleteConfirmMessage"
      confirm-text="删除"
      danger
      @confirm="confirmRemove"
      @cancel="pendingDelete = null"
    />
  </div>
</template>

<style>
.app-root { height: 100vh; }
</style>
