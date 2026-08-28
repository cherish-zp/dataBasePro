<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

// LagTrend draws a mini lag trend line from samples pulled via the injected
// sampler (keeps the component reusable and testable without API wiring).
// sampleKey identifies the sampled series: changing it clears the history and
// starts sampling the new series.
const props = defineProps<{ sampler: () => Promise<number>; title?: string; sampleKey?: string | number }>()

// The line is a moving window: only the most recent samples are kept.
const MAX_POINTS = 60
const WIDTH = 560
const HEIGHT = 120
const PAD = 6

const intervalOptions = [
  { label: '关闭', value: 0 },
  { label: '5s', value: 5000 },
  { label: '10s', value: 10000 },
  { label: '30s', value: 30000 },
]

const points = ref<number[]>([])
const error = ref('')
const intervalMs = ref(0)

let timer: number | null = null

async function sample(): Promise<void> {
  try {
    const value = await props.sampler()
    points.value = [...points.value, value].slice(-MAX_POINTS)
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function stopTimer(): void {
  if (timer !== null) {
    window.clearInterval(timer)
    timer = null
  }
}

watch(intervalMs, (ms) => {
  stopTimer()
  if (ms > 0) timer = window.setInterval(() => void sample(), ms)
})

watch(
  () => props.sampleKey,
  () => {
    points.value = []
    void sample()
  },
)

function refresh(): void {
  void sample()
}

onMounted(refresh)
onBeforeUnmount(stopTimer)

const polylinePoints = computed(() => {
  const pts = points.value
  if (pts.length === 0) return ''
  const min = Math.min(...pts)
  const max = Math.max(...pts)
  const span = max - min
  return pts
    .map((v, i) => {
      const x = pts.length === 1 ? WIDTH / 2 : (i / (pts.length - 1)) * WIDTH
      const y = span === 0 ? HEIGHT / 2 : HEIGHT - PAD - ((v - min) / span) * (HEIGHT - PAD * 2)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
})

const latest = computed(() => points.value.at(-1) ?? null)
const min = computed(() => (points.value.length ? Math.min(...points.value) : null))
const max = computed(() => (points.value.length ? Math.max(...points.value) : null))
</script>

<template>
  <div class="trend" data-test="lag-trend">
    <div class="trend-header">
      <span class="trend-title">{{ title || 'Lag 趋势' }}</span>
      <div class="trend-tools">
        <label class="trend-field">
          自动刷新
          <select v-model.number="intervalMs" data-test="select-trend-interval" class="trend-select">
            <option v-for="opt in intervalOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </label>
        <button class="trend-btn" type="button" data-test="btn-trend-refresh" @click="refresh">刷新</button>
      </div>
    </div>
    <svg
      class="trend-svg"
      :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
      preserveAspectRatio="none"
      data-test="trend-svg"
      aria-hidden="true"
    >
      <polyline
        data-test="trend-polyline"
        :points="polylinePoints"
        fill="none"
        stroke="var(--accent)"
        stroke-width="2"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
    </svg>
    <div v-if="error" class="trend-error" data-test="trend-error">{{ error }}</div>
    <div v-if="latest === null" class="trend-empty" data-test="trend-empty">暂无采样数据</div>
    <div v-else class="trend-stats">
      <span>最新 <b class="mono" data-test="trend-latest">{{ latest }}</b></span>
      <span>最小 <b class="mono" data-test="trend-min">{{ min }}</b></span>
      <span>最大 <b class="mono" data-test="trend-max">{{ max }}</b></span>
    </div>
  </div>
</template>

<style scoped>
.trend { margin-top: 14px; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 10px 12px; }
.trend-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
.trend-title { font-weight: 600; font-size: 13px; color: var(--text); }
.trend-tools { display: flex; gap: 8px; align-items: center; }
.trend-field { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--text-secondary); }
.trend-select {
  background: var(--bg-subtle); border: 1px solid var(--border); color: var(--text);
  border-radius: 7px; padding: 4px 8px; font-size: 12px;
}
.trend-select:focus { outline: none; border-color: var(--accent); }
.trend-btn {
  background: transparent; color: var(--text); border: 1px solid var(--border-strong);
  border-radius: 7px; padding: 4px 10px; font-size: 12px; cursor: pointer;
  transition: background 0.15s ease;
}
.trend-btn:hover { background: var(--bg-hover); }
.trend-svg { display: block; width: 100%; height: 120px; }
.trend-error { margin-top: 6px; font-size: 12px; color: var(--danger); }
.trend-empty { text-align: center; color: var(--text-tertiary); font-size: 12px; padding: 8px 0 2px; }
.trend-stats { display: flex; gap: 16px; margin-top: 6px; font-size: 12px; color: var(--text-secondary); }
.trend-stats .mono { font-family: var(--mono); color: var(--text); }
</style>
