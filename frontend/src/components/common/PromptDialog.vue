<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    show: boolean
    title: string
    label: string
    value?: string | number
    confirmText?: string
    hint?: string
  }>(),
  { value: '', confirmText: '确认', hint: '' },
)

const emit = defineEmits<{
  (e: 'confirm', value: string): void
  (e: 'cancel'): void
}>()

const draft = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

watch(
  () => props.show,
  (show) => {
    if (show) {
      draft.value = String(props.value ?? '')
      // Autofocus after the teleported dialog mounts so typing can start
      // immediately.
      void nextTick(() => inputEl.value?.focus())
    }
  },
  { immediate: true },
)

const canConfirm = (): boolean => draft.value.trim().length > 0

function confirm(): void {
  if (!canConfirm()) return
  emit('confirm', draft.value.trim())
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') confirm()
  if (e.key === 'Escape') emit('cancel')
}
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="overlay" data-test="prompt-overlay">
      <div class="dialog" data-test="prompt-dialog">
        <div class="title" data-test="prompt-title">{{ title }}</div>
        <label class="field">
          <span class="label">{{ label }}</span>
          <input
            ref="inputEl"
            v-model="draft"
            class="input"
            type="text"
            data-test="prompt-input"
            autocapitalize="off"
            autocorrect="off"
            autocomplete="off"
            spellcheck="false"
            @keydown="onKeydown"
          />
        </label>
        <div v-if="hint" class="hint" data-test="prompt-hint">{{ hint }}</div>
        <div class="actions">
          <button class="btn ghost" type="button" data-test="prompt-cancel" @click="emit('cancel')">取消</button>
          <button class="btn primary" type="button" data-test="prompt-confirm" :disabled="!canConfirm()" @click="confirm">
            {{ confirmText }}
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
  width: 320px;
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
.title { font-weight: 600; font-size: 14px; }
.field { display: flex; flex-direction: column; gap: 5px; }
.label { font-size: 12px; color: var(--text-secondary); }
.input {
  background: var(--bg-subtle); border: 1px solid var(--border); color: var(--text);
  border-radius: 7px; padding: 6px 9px; font-size: 13px; font-family: var(--mono);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.hint { font-size: 12px; color: var(--text-tertiary); }
.actions { display: flex; justify-content: flex-end; gap: 8px; }
.btn { border-radius: 7px; padding: 6px 14px; font-size: 13px; cursor: pointer; border: 1px solid transparent; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.primary { background: var(--accent); color: #fff; }
.btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--border-strong); }
.btn.ghost:hover:not(:disabled) { background: var(--bg-hover); }
</style>
