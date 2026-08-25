<script setup lang="ts">
import { ref, onMounted } from 'vue'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const THEME_KEY = 'dbclient-theme'
const theme = ref<'dark' | 'light'>(localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light')

function apply(theme: 'dark' | 'light'): void {
  document.documentElement.setAttribute('data-theme', theme)
  localStorage.setItem(THEME_KEY, theme)
}

function changeTheme(): void {
  apply(theme.value)
}

onMounted(() => {
  apply(theme.value)
})

function close(): void {
  emit('close')
}
</script>

<template>
  <div v-if="show" class="modal-backdrop" data-test="settings-panel" @click.self="close">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">设置</span>
        <button class="modal-close" type="button" data-test="modal-close" @click="close">✕</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label class="label">主题</label>
          <select v-model="theme" data-test="select-theme" class="input" @change="changeTheme">
            <option value="dark">深色</option>
            <option value="light">浅色</option>
          </select>
        </div>
        <div class="info">
          <div class="info-row"><span class="info-label">数据目录</span><span class="info-value mono">~/.db-client/config.db</span></div>
          <div class="info-row"><span class="info-label">客户端</span><span class="info-value">Go + Wails + Vue 3</span></div>
          <div class="info-row"><span class="info-label">版本</span><span class="info-value">0.1.0</span></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.22);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  display: flex; align-items: center; justify-content: center; z-index: 900;
}
.modal {
  width: 380px; max-width: 92vw; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
  color: var(--text); font-family: var(--font);
}
.modal-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 18px; border-bottom: 1px solid var(--border); }
.modal-title { font-weight: 600; font-size: 15px; }
.modal-close { background: none; border: none; color: var(--text-tertiary); font-size: 16px; cursor: pointer; border-radius: 6px; padding: 1px 6px; }
.modal-close:hover { background: var(--bg-hover); color: var(--text); }
.modal-body { padding: 16px 18px; }
.field { margin-bottom: 14px; }
.label { display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; }
.input { background: var(--bg-subtle); border: 1px solid var(--border); color: var(--text); border-radius: 7px; padding: 8px 10px; font-size: 13px; width: 100%; box-sizing: border-box; transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease; }
.input:focus { outline: none; border-color: var(--accent); background: var(--bg-elevated); box-shadow: 0 0 0 3px var(--accent-soft); }
.info { border-top: 1px solid var(--border); padding-top: 12px; }
.info-row { display: flex; justify-content: space-between; font-size: 13px; padding: 4px 0; }
.info-label { color: var(--text-secondary); }
.info-value { color: var(--text); }
.mono { font-family: var(--mono); }
</style>
