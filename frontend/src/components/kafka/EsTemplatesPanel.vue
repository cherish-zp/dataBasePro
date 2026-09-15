<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import * as App from '../../../wailsjs/go/backend/App'
import { useToastStore } from '@/store/toast'

const props = defineProps<{
  connectionId: string
  // 树分段入口:initialTemplate 指向待选中的模板名(树模板项单击),
  // newMode 表示进入新建态(分区标题 +)。由 watch 响应变化。
  initialTemplate?: string
  newMode?: boolean
}>()

interface EsTemplateMeta {
  name: string
  order: number
}

// Es* 模板绑定尚未由 wails generate module 生成,这里按显式形状断言调用
// (与 EsTableBrowser 同一模式);生成后签名一致,无需改动本文件。
// 走 legacy /_template API(6.1 OSS 可用),非 composable 模板。
const app = App as unknown as {
  ListEsTemplates(id: string): Promise<EsTemplateMeta[]>
  GetEsTemplate(req: { connection_id: string; name: string }): Promise<{ template_json: string }>
  PutEsTemplate(req: { connection_id: string; name: string; template_json: string }): Promise<void>
  DeleteEsTemplate(req: { connection_id: string; name: string }): Promise<void>
}

const toast = useToastStore()

const templates = ref<EsTemplateMeta[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
// 首次列表是否拉取成功 + 在途请求句柄:定位入口在列表未就绪时等待/补拉,
// 避免与挂载期加载重复请求。
let listLoaded = false
let listPromise: Promise<void> = Promise.resolve()

const search = ref('')
// 当前编辑目标:selectedName 指向已有模板;新建态用 isNew 标记(名称可编辑)。
// 两者皆空时右栏显示空态引导。
const selectedName = ref<string | null>(null)
const isNew = ref(false)
const nameDraft = ref('')
const jsonDraft = ref('')
const saving = ref(false)

// 删除确认:待删模板名与弹窗开关(ConfirmDialog Teleport 到 body)。
const confirmDelete = ref(false)
const deleteName = ref('')

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return templates.value
  return templates.value.filter((t) => t.name.toLowerCase().includes(q))
})

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// prettyJson 将后端返回的 template_json 格式化为两空格缩进;解析失败原样
// 展示(前端不重复做语法校验,保存时由后端拒绝并透出错误)。
function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

async function loadList(): Promise<void> {
  loading.value = true
  error.value = null
  listPromise = (async () => {
    try {
      const list = await app.ListEsTemplates(props.connectionId)
      // wire 形状防御:后端异常时按空数组渲染,避免模板期 TypeError。
      templates.value = Array.isArray(list) ? list : []
      listLoaded = true
    } catch (e) {
      error.value = errMsg(e)
    } finally {
      loading.value = false
    }
  })()
  return listPromise
}

// ensureList 保证定位前列表已就绪:加载中等待完成,未加载(含首拉失败)则补拉。
async function ensureList(): Promise<void> {
  if (loading.value) {
    await listPromise
    return
  }
  if (!listLoaded) await loadList()
}

onMounted(() => {
  void boot()
})

// applyInitial 应用树定位 props:newMode 优先进入新建态;initialTemplate 非空
// 选中该模板并载入内容(列表无此项时忽略);两者都空维持现状。
async function applyInitial(): Promise<void> {
  if (props.newMode) {
    startNew()
    return
  }
  const name = props.initialTemplate
  if (!name) return
  await ensureList()
  const meta = templates.value.find((t) => t.name === name)
  if (!meta) return
  await selectTemplate(meta)
}

// boot 挂载初始化:先拉列表再应用初始定位 props。
async function boot(): Promise<void> {
  await ensureList()
  await applyInitial()
}

// Layout 以 :key=active.id 挂载面板,同 tab 重复打开不会重挂载:定位/新建
// 意图变化必须由 watch 响应 props(普通打开 → 定位到模板 / 新建态)。
watch([() => props.initialTemplate, () => props.newMode], () => {
  void applyInitial()
})

// selectTemplate 选中已有模板:锁定名称并载入 pretty JSON;重复点击同一
// 模板不重复请求。
async function selectTemplate(t: EsTemplateMeta): Promise<void> {
  if (!isNew.value && selectedName.value === t.name) return
  selectedName.value = t.name
  isNew.value = false
  nameDraft.value = t.name
  error.value = null
  try {
    const res = await app.GetEsTemplate({ connection_id: props.connectionId, name: t.name })
    jsonDraft.value = prettyJson(res.template_json ?? '')
  } catch (e) {
    error.value = errMsg(e)
  }
}

// startNew 进入新建态:名称可编辑、编辑器清空,保存时才下发名称。
function startNew(): void {
  selectedName.value = null
  isNew.value = true
  nameDraft.value = ''
  jsonDraft.value = ''
  error.value = null
}

// 空态引导示例:legacy 模板三段结构(index_patterns/settings/mappings)。
const SAMPLE_JSON = JSON.stringify(
  {
    index_patterns: ['log-*'],
    settings: { number_of_shards: 1 },
    mappings: {
      properties: {
        '@timestamp': { type: 'date' },
        level: { type: 'keyword' },
      },
    },
  },
  null,
  2,
)

// fillSample 一键填入示例模板并进入新建态。
function fillSample(): void {
  selectedName.value = null
  isNew.value = true
  nameDraft.value = ''
  jsonDraft.value = SAMPLE_JSON
  error.value = null
}

// canSave 名称非空才允许保存(新建态名称即模板名,编辑态名称锁定不变)。
const canSave = computed(() => nameDraft.value.trim().length > 0 && !saving.value)

// save 保存模板(PUT /_template/{name}):新建态以输入的名称创建,编辑态
// 整体替换;成功后 toast、刷新列表并停留在该模板。
async function save(): Promise<void> {
  const name = nameDraft.value.trim()
  if (!name || saving.value) return
  saving.value = true
  error.value = null
  try {
    await app.PutEsTemplate({ connection_id: props.connectionId, name, template_json: jsonDraft.value })
    toast.show('模板已保存')
    isNew.value = false
    selectedName.value = name
    nameDraft.value = name
    await loadList()
  } catch (e) {
    error.value = errMsg(e)
  } finally {
    saving.value = false
  }
}

const deleteMessage = computed(() => `确认删除模板「${deleteName.value}」?此操作不可恢复。`)

// askDelete 删除前危险确认:仅已有模板可删(新建态无后端对象)。
function askDelete(): void {
  if (isNew.value || !selectedName.value) return
  deleteName.value = selectedName.value
  confirmDelete.value = true
}

// doDelete 确认删除:清空编辑器回到空态引导并刷新列表;失败时弹窗已关、
// 错误留在错误区,列表保持原状。
async function doDelete(): Promise<void> {
  confirmDelete.value = false
  const name = deleteName.value
  deleteName.value = ''
  if (!name) return
  try {
    await app.DeleteEsTemplate({ connection_id: props.connectionId, name })
    selectedName.value = null
    isNew.value = false
    nameDraft.value = ''
    jsonDraft.value = ''
    await loadList()
  } catch (e) {
    error.value = errMsg(e)
  }
}
</script>

<template>
  <div class="es-templates" data-test="es-templates-panel">
    <!-- 左栏:模板列表(搜索 + 新建 + 名称/order 徽标) -->
    <aside class="tpl-list">
      <div class="list-head">
        <input
          v-model="search"
          class="search-input"
          type="search"
          data-test="es-tpl-search"
          placeholder="🔍 模糊搜索模板…"
          autocapitalize="off"
          autocorrect="off"
          autocomplete="off"
          spellcheck="false"
        />
        <button class="btn ghost" type="button" data-test="es-tpl-new" title="新建模板" @click="startNew">新建</button>
      </div>
      <div v-if="loading" class="muted" data-test="es-tpl-loading">加载中…</div>
      <template v-else>
        <div
          v-for="t in filtered"
          :key="t.name"
          class="tpl-item"
          :class="{ active: !isNew && selectedName === t.name }"
          :data-test="`es-tpl-item-${t.name}`"
          :title="`${t.name}(order ${t.order})`"
          @click="selectTemplate(t)"
        >
          <span class="tpl-name">{{ t.name }}</span>
          <span class="tpl-order" data-test="es-tpl-order" title="模板合并顺序(order 越大优先级越高)">{{ t.order }}</span>
        </div>
        <div v-if="filtered.length === 0" class="muted" data-test="es-tpl-empty">
          {{ templates.length === 0 ? '（无模板）' : '无匹配模板' }}
        </div>
      </template>
    </aside>

    <!-- 右栏:编辑器 / 空态引导 -->
    <section class="tpl-editor">
      <div v-if="error" class="msg err" data-test="es-tpl-error">{{ error }}</div>

      <div v-if="!isNew && !selectedName" class="empty" data-test="es-tpl-guide">
        <div class="empty-icon">⚙</div>
        <div>索引模板管理</div>
        <div class="empty-hint">新建模板:{"index_patterns":["log-*"],"settings":{...},"mappings":{...}}</div>
        <button class="btn ghost" type="button" data-test="es-tpl-sample" @click="fillSample">填入示例模板</button>
      </div>

      <template v-else>
        <div class="editor-head">
          <label class="name-label">
            名称
            <input
              v-model="nameDraft"
              class="name-input"
              type="text"
              data-test="es-tpl-name"
              :disabled="!isNew"
              placeholder="模板名称"
              autocapitalize="off"
              autocorrect="off"
              autocomplete="off"
              spellcheck="false"
              title="新建态可编辑;已有模板名称锁定,改名请另建新模板"
            />
          </label>
        </div>
        <textarea
          v-model="jsonDraft"
          class="json-editor"
          data-test="es-tpl-editor"
          autocapitalize="off"
          autocorrect="off"
          autocomplete="off"
          spellcheck="false"
        ></textarea>
        <div class="actions">
          <button class="btn primary" type="button" data-test="es-tpl-save" :disabled="!canSave" @click="save">
            {{ saving ? '保存中…' : '保存' }}
          </button>
          <button
            class="btn ghost danger"
            type="button"
            data-test="es-tpl-delete"
            :disabled="isNew || !selectedName"
            @click="askDelete"
          >
            删除
          </button>
        </div>
        <div class="hint">保存以该 JSON 整体创建/替换模板(PUT /_template/{名称});JSON 语法错误由后端校验。</div>
      </template>
    </section>

    <!-- 删除模板:危险操作,文案含模板名。 -->
    <ConfirmDialog
      :show="confirmDelete"
      :message="deleteMessage"
      confirm-text="删除"
      danger
      @confirm="doDelete"
      @cancel="confirmDelete = false"
    />
  </div>
</template>

<style scoped>
/* 两栏布局整体撑满 tab(与 SQL 控制台同款 height:100% 思路)。 */
.es-templates {
  height: 100%;
  box-sizing: border-box;
  display: flex;
  gap: 12px;
  padding: 12px;
  color: var(--text);
  font-family: var(--font);
  overflow: hidden;
}
.tpl-list {
  flex: none;
  width: 260px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-elevated);
  padding: 8px;
}
.list-head { display: flex; gap: 6px; align-items: center; flex: none; }
.list-head .search-input { flex: 1; min-width: 0; }
.search-input {
  background: var(--bg-subtle); border: 1px solid var(--border); color: var(--text);
  border-radius: 7px; padding: 5px 9px; font-size: 12px;
}
.search-input:focus { outline: none; border-color: var(--accent); background: var(--bg-elevated); box-shadow: 0 0 0 3px var(--accent-soft); }
.search-input::placeholder { color: var(--text-tertiary); }
.tpl-item {
  flex: none;
  display: flex; align-items: center; gap: 6px;
  padding: 6px 8px; border-radius: 7px; cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.tpl-item:hover { background: var(--bg-hover); }
.tpl-item.active { background: var(--accent-soft); }
.tpl-item.active .tpl-name { color: var(--accent); font-weight: 600; }
.tpl-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-family: var(--mono); }
.tpl-order {
  flex: none; font-size: 10px; font-family: var(--mono);
  color: var(--text-tertiary);
  background: var(--bg-hover); border-radius: 99px; padding: 0 7px; line-height: 16px;
}
.tpl-item.active .tpl-order { color: var(--accent); background: var(--bg-elevated); }
.muted { color: var(--text-tertiary); font-size: 12px; padding: 6px 8px; }
.tpl-editor {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column;
  border: 1px solid var(--border); border-radius: 10px;
  background: var(--bg-elevated);
  padding: 12px;
  overflow: auto;
}
.msg { padding: 8px 10px; font-size: 13px; border-radius: 7px; margin-bottom: 8px; }
.msg.err { background: var(--danger-soft); color: var(--danger); }
.empty { margin: auto; text-align: center; color: var(--text-tertiary); padding: 28px 24px; }
.empty-icon { font-size: 26px; margin-bottom: 6px; }
.empty-hint { font-size: 12px; margin: 6px 0 12px; color: var(--text-tertiary); font-family: var(--mono); word-break: break-all; }
.editor-head { display: flex; gap: 8px; align-items: center; flex: none; margin-bottom: 8px; }
.name-label {
  display: flex; flex: 1; align-items: center; gap: 8px;
  font-size: 12px; color: var(--text-secondary); min-width: 0;
}
.name-input {
  flex: 1; min-width: 0;
  background: var(--bg-subtle); border: 1px solid var(--border); color: var(--text);
  border-radius: 7px; padding: 6px 9px; font-size: 13px; font-family: var(--mono);
}
.name-input:focus { outline: none; border-color: var(--accent); background: var(--bg-elevated); box-shadow: 0 0 0 3px var(--accent-soft); }
.name-input:disabled { opacity: 0.6; cursor: not-allowed; background: var(--bg-subtle); }
.json-editor {
  flex: 1; min-height: 240px; resize: none;
  box-sizing: border-box; width: 100%;
  background: var(--bg-subtle); border: 1px solid var(--border); color: var(--text);
  border-radius: 7px; padding: 8px 10px; font-size: 12px; line-height: 1.5;
  font-family: var(--mono);
}
.json-editor:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.actions { display: flex; gap: 8px; margin-top: 10px; flex: none; }
.hint { margin-top: 8px; font-size: 11px; color: var(--text-tertiary); flex: none; }
.btn { border-radius: 7px; padding: 6px 13px; font-size: 13px; cursor: pointer; border: 1px solid transparent; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--border-strong); }
.btn.ghost:hover:not(:disabled) { background: var(--bg-hover); }
.btn.ghost.danger { color: var(--danger); border-color: var(--danger); }
.btn.ghost.danger:hover:not(:disabled) { background: var(--danger-soft); }
.btn.primary { background: var(--accent); color: #fff; }
.btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
</style>
