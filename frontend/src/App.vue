<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useConnectionsStore } from '@/store/connections'
import type { Connection } from '@/api/types'
import Layout from '@/components/layout/Layout.vue'
import NewConnectionModal from '@/components/connection/NewConnectionModal.vue'

const store = useConnectionsStore()
const showNew = ref(false)
// editing 携带被编辑的连接:非 null 时 NewConnectionModal 进入编辑模式并预填。
const editing = ref<Connection | null>(null)

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

async function removeConnection(id: string): Promise<void> {
  await store.remove(id)
}
</script>

<template>
  <div class="app-root">
    <Layout
      :connections="store.connections"
      @new="openNew"
      @delete-connection="removeConnection"
      @edit-connection="openEdit"
    />
    <NewConnectionModal :show="showNew" :connection="editing" @close="closeModal" />
  </div>
</template>

<style>
.app-root { height: 100vh; }
</style>
