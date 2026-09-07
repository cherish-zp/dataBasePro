<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { getApi } from '@/api/client'
import { APP_VERSION } from '@/version'
import type { UpdateCheckResult } from '@/api/types'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

// 状态机:checking → up-to-date / available → downloading → apply → close。
// 下载进度靠轮询 UpdateProgress(引擎无关,不依赖 Wails 事件绑定);
// 任一环节失败进入 error,提供「重试」与「打开下载页」两个出口。
type Phase = 'checking' | 'uptodate' | 'available' | 'downloading' | 'error'

const phase = ref<Phase>('checking')
const result = ref<UpdateCheckResult | null>(null)
const percent = ref(0)
const errorText = ref('')
let pollTimer: ReturnType<typeof setInterval> | null = null

watch(
  () => props.show,
  (show) => {
    if (!show) {
      stopPolling()
      return
    }
    phase.value = 'checking'
    result.value = null
    errorText.value = ''
    percent.value = 0
    void check()
  },
  { immediate: true },
)

async function check(): Promise<void> {
  phase.value = 'checking'
  try {
    const res = await getApi().checkUpdate({ current_version: APP_VERSION })
    result.value = res
    phase.value = res.has_update ? 'available' : 'uptodate'
  } catch (e) {
    phase.value = 'error'
    errorText.value = e instanceof Error ? e.message : String(e)
  }
}

const downloadURL = computed(() => result.value?.download_url ?? '')

async function install(): Promise<void> {
  if (!downloadURL.value) return
  phase.value = 'downloading'
  percent.value = 0
  startPolling()
  try {
    await getApi().downloadUpdate({ url: downloadURL.value })
    // 下载调用返回后再确认终态(轮询与下载并发推进);轮询读到 error 时
    // 已写入具体错误,这里不再覆盖。
    const done = await waitForDone()
    if (!done) return
    emit('close')
  } catch (e) {
    stopPolling()
    phase.value = 'error'
    errorText.value = e instanceof Error ? e.message : String(e)
  }
}

// waitForDone 轮询进度到 done;done 时调用 applyUpdate(后端写脚本、
// 替换并重启)然后返回 true。error 时写入具体错误并返回 false。
async function waitForDone(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    stopPolling()
    pollTimer = setInterval(async () => {
      try {
        const p = await getApi().updateProgress()
        percent.value = p.percent
        if (p.phase === 'done') {
          stopPolling()
          await getApi().applyUpdate({})
          resolve(true)
        } else if (p.phase === 'error') {
          stopPolling()
          phase.value = 'error'
          errorText.value = p.error || '下载失败'
          resolve(false)
        }
      } catch {
        // 单次轮询失败忽略,下一轮再试
      }
    }, 300)
  })
}

function startPolling(): void {
  stopPolling()
  pollTimer = setInterval(async () => {
    try {
      const p = await getApi().updateProgress()
      percent.value = p.percent
    } catch {
      // 忽略单次轮询失败
    }
  }, 300)
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

const statusText = computed(() => {
  switch (phase.value) {
    case 'checking':
      return '正在检查更新…'
    case 'uptodate':
      return '已是最新版本'
    case 'available':
      return `发现新版本 ${result.value?.latest_version ?? ''}`
    case 'downloading':
      return `下载中 ${percent.value}%`
    default:
      return errorText.value || '更新失败'
  }
})
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="overlay">
      <div class="dialog" data-test="update-dialog">
        <div class="head">
          <span class="title">软件更新</span>
          <button class="close" type="button" data-test="btn-update-close" @click="emit('close')">✕</button>
        </div>
        <div class="status" data-test="update-status">
          <span v-if="phase === 'checking' || phase === 'downloading'" class="spinner" aria-hidden="true"></span>
          {{ statusText }}
        </div>
        <div v-if="phase === 'available' && result?.notes" class="notes" data-test="update-notes">{{ result.notes }}</div>
        <div v-if="phase === 'downloading'" class="bar">
          <div class="bar-fill" :style="{ width: `${percent}%` }"></div>
        </div>

        <div class="actions">
          <button
            v-if="phase === 'error'"
            class="btn ghost"
            type="button"
            data-test="btn-update-open-page"
            @click="getApi().openURL(downloadURL)"
          >
            打开下载页
          </button>
          <button
            v-if="phase === 'error'"
            class="btn ghost"
            type="button"
            data-test="btn-update-retry"
            @click="install"
          >
            重试
          </button>
          <button
            v-if="phase === 'available'"
            class="btn primary"
            type="button"
            data-test="btn-update-install"
            @click="install"
          >
            立即更新
          </button>
          <button
            v-if="phase === 'checking' || phase === 'uptodate' || phase === 'available'"
            class="btn ghost"
            type="button"
            data-test="btn-update-later"
            @click="emit('close')"
          >
            {{ phase === 'uptodate' ? '确定' : '以后再说' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.32);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1200;
  font-family: var(--font);
  color: var(--text);
}
.dialog {
  width: 380px;
  max-width: calc(100vw - 48px);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.22);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.head { display: flex; align-items: center; justify-content: space-between; }
.title { font-weight: 600; font-size: 15px; }
.close { background: none; border: none; color: var(--text-tertiary); cursor: pointer; border-radius: 5px; padding: 1px 6px; }
.close:hover { background: var(--bg-hover); color: var(--text); }
.status { font-size: 13px; display: flex; align-items: center; gap: 8px; }
.spinner {
  width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid var(--border-strong); border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.notes {
  font-size: 12px; color: var(--text-secondary);
  background: var(--bg-subtle); border: 1px solid var(--border);
  border-radius: 8px; padding: 8px 10px;
  max-height: 120px; overflow: auto; white-space: pre-wrap;
}
.bar {
  height: 6px; border-radius: 99px; background: var(--bg-subtle); overflow: hidden;
}
.bar-fill { height: 100%; background: var(--accent); transition: width 0.2s ease; }
.actions { display: flex; justify-content: flex-end; gap: 8px; }
.btn { border-radius: 7px; padding: 6px 14px; font-size: 13px; cursor: pointer; border: 1px solid transparent; }
.btn.primary { background: var(--accent); color: #fff; }
.btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--border-strong); }
.btn.ghost:hover:not(:disabled) { background: var(--bg-hover); }
</style>
