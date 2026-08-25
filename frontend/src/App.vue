<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useConnectionsStore } from '@/store/connections'
import Layout from '@/components/layout/Layout.vue'
import NewConnectionModal from '@/components/connection/NewConnectionModal.vue'

const store = useConnectionsStore()
const showNew = ref(false)

onMounted(() => {
  void store.load()
})

async function removeConnection(id: string): Promise<void> {
  await store.remove(id)
}
</script>

<template>
  <div class="app-root">
    <Layout :connections="store.connections" @new="showNew = true" @delete-connection="removeConnection" />
    <NewConnectionModal :show="showNew" @close="showNew = false" />
  </div>
</template>

<style>
.app-root { height: 100vh; }
</style>
