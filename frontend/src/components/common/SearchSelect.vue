<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { fuzzyScore } from '@/utils/fuzzy'

export interface SelectOption {
  value: string
  label?: string
}

const props = defineProps<{
  modelValue: string | null
  options: SelectOption[]
  placeholder?: string
}>()
const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

const open = ref(false)
const query = ref('')
const root = ref<HTMLElement | null>(null)

const selected = computed(() => props.options.find((o) => o.value === props.modelValue) ?? null)

const filtered = computed(() => {
  const q = query.value.trim()
  if (!q) return props.options
  return props.options
    .map((o) => ({ o, score: fuzzyScore(q, o.value) }))
    .filter((x) => x.score !== Infinity)
    .sort((a, b) => a.score - b.score)
    .map((x) => x.o)
})

function toggle(): void {
  open.value = !open.value
  if (open.value) query.value = ''
}

function select(value: string): void {
  emit('update:modelValue', value)
  open.value = false
}

function onOutside(event: MouseEvent): void {
  if (root.value && !root.value.contains(event.target as Node)) open.value = false
}

watch(open, (v) => {
  if (v) document.addEventListener('click', onOutside)
  else document.removeEventListener('click', onOutside)
})
onBeforeUnmount(() => document.removeEventListener('click', onOutside))
</script>

<template>
  <div ref="root" class="search-select" data-test="search-select">
    <button type="button" class="trigger" data-test="search-select-trigger" @click="toggle">
      <span class="value" data-test="search-select-value">{{ selected?.label ?? selected?.value ?? placeholder ?? '选择…' }}</span>
      <span class="caret">▾</span>
    </button>
    <div v-if="open" class="panel" data-test="search-select-panel">
      <input
        v-model="query"
        class="search"
        type="search"
        data-test="search-select-input"
        placeholder="搜索…"
        autocapitalize="off"
        autocorrect="off"
        autocomplete="off"
        spellcheck="false"
      />
      <div class="options" role="listbox">
        <div
          v-for="o in filtered"
          :key="o.value"
          class="option"
          :class="{ active: o.value === modelValue }"
          role="option"
          aria-selected="false"
          tabindex="0"
          :data-test="`search-select-option`"
          @click="select(o.value)"
          @keydown.enter.prevent="select(o.value)"
          @keydown.space.prevent="select(o.value)"
        >{{ o.label ?? o.value }}</div>
        <div v-if="filtered.length === 0" class="empty" data-test="search-select-empty">无匹配</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-select { position: relative; min-width: 200px; }
.trigger {
  -webkit-appearance: none; appearance: none;
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  width: 100%; box-sizing: border-box;
  background: var(--bg-subtle); border: 1px solid var(--border); color: var(--text);
  border-radius: 7px; padding: 6px 9px; font-size: 13px; line-height: 1.4; cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.trigger:hover { background: var(--bg-elevated); }
.trigger:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.caret { color: var(--text-tertiary); font-size: 11px; }
.panel {
  position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 50;
  background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  padding: 6px; display: flex; flex-direction: column; gap: 6px;
}
.search {
  -webkit-appearance: none; appearance: none;
  width: 100%; box-sizing: border-box;
  background: var(--bg-subtle); border: 1px solid var(--border); color: var(--text);
  border-radius: 6px; padding: 5px 8px; font-size: 12px; line-height: 1.4;
}
.search:focus { outline: none; border-color: var(--accent); }
.options { max-height: 220px; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.option {
  -webkit-appearance: none; appearance: none;
  /* flex:none 禁止收缩:内容超过 max-height 时必须滚动而不是把每个选项
     等比压瘪(overflow:hidden 使 flex 最小高度为 0,214 个选项时全部
     被压成 1px 细线——真实集群 214 个消费组时的翻车现场)。 */
  flex: none;
  background: none; border: none; text-align: left; cursor: pointer;
  padding: 6px 8px; border-radius: 6px; font-size: 13px; line-height: 1.4; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.option:hover { background: var(--bg-hover); }
.option.active { background: var(--accent-soft); color: var(--accent); }
.option:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--accent); }
.empty { padding: 8px; text-align: center; font-size: 12px; color: var(--text-tertiary); }
</style>
