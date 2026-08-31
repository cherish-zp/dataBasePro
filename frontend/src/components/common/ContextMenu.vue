<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

export interface ContextMenuItem {
  key: string
  label: string
  danger?: boolean
}

const props = defineProps<{ show: boolean; x: number; y: number; items: ContextMenuItem[] }>()

const emit = defineEmits<{
  (e: 'select', key: string): void
  (e: 'close'): void
}>()

// Teleported to <body>: the sidebar's backdrop-filter would otherwise become
// the containing block for position:fixed (same rationale as the command
// palette and the tab context menu in Layout).
const MENU_W = 168
// ~28px per item plus padding; generous so edge clamping never clips the last
// item even with font rendering variance.
const MENU_H = computed(() => props.items.length * 30 + 12)

const left = ref(0)
const top = ref(0)
const el = ref<HTMLElement | null>(null)

watch(
  () => props.show,
  (show) => {
    if (!show) return
    left.value = Math.max(0, Math.min(props.x, window.innerWidth - MENU_W))
    top.value = Math.max(0, Math.min(props.y, window.innerHeight - MENU_H.value))
    document.addEventListener('click', onDocClick, true)
    document.addEventListener('keydown', onKeydown, true)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick, true)
  document.removeEventListener('keydown', onKeydown, true)
})

function onDocClick(e: MouseEvent): void {
  if (el.value && !el.value.contains(e.target as Node)) emit('close')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}

function pick(key: string): void {
  emit('select', key)
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="show"
      ref="el"
      class="context-menu"
      data-test="context-menu"
      :style="{ left: `${left}px`, top: `${top}px` }"
      @click.stop
      @contextmenu.prevent.stop
    >
      <button
        v-for="it in items"
        :key="it.key"
        class="context-item"
        :class="{ danger: it.danger }"
        type="button"
        :data-test="`context-item-${it.key}`"
        @click="pick(it.key)"
      >
        {{ it.label }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.context-menu {
  position: fixed;
  z-index: 1300;
  min-width: 168px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-family: var(--font);
  color: var(--text);
}
.context-item {
  text-align: left;
  background: none;
  border: none;
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
  white-space: nowrap;
}
.context-item:hover { background: var(--bg-hover); }
.context-item.danger { color: var(--danger); }
.context-item.danger:hover { background: var(--danger-soft); }
.context-item:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--accent); }
</style>
