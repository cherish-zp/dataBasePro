<script setup lang="ts">
import { computed, onMounted, ref, unref, watch } from 'vue'
import type { SqlTableSchema } from '@/components/common/SqlEditor.vue'
import { commentAbove, splitSqlStatements, type SqlSegment } from '@/utils/sqlSplit'
import { useQueryFiles } from '@/composables/queryFiles'
import { useTabsStore } from '@/store/tabs'
import { getApi } from '@/api/client'
import type { HiveStatementResult } from '@/api/types'
import SqlEditor from '@/components/common/SqlEditor.vue'
import SqlResultCard from '@/components/common/SqlResultCard.vue'
import SqlResultTabs, { type ResultTabItem } from '@/components/common/SqlResultTabs.vue'
import PromptDialog from '@/components/common/PromptDialog.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

// Hive SQL 控制台(照 MysqlSqlConsole 裁剪):HiveExecute 执行、服务端分页
// 500 条/页、库选择器、查询文件全链路、tab 草稿持久化、语句标记。Hive 表
// 浏览器/结果集不做行级写(无单元格编辑、无删除行),死代码不留。

// tabId 必填:控制台据此把 tabs store 中自己的 tab 重命名为当前关联文件名。
const props = defineProps<{ tabId: string; connectionId: string; database?: string }>()

const sql = ref('')
const running = ref(false)
const error = ref<string | null>(null)
const results = ref<HiveStatementResult[]>([])
const editor = ref<InstanceType<typeof SqlEditor> | null>(null)

// --- 结果 Tab 条:每个语句结果一个 tab,Tab 条下方只渲染 active 的那张卡。 ---
// label = 语句起始上方最近的注释文本(commentAbove),无注释回退「结果 N」;
// status 随运行推进 running → ok/fail;title 为语句单行摘要。
const resultTabs = ref<ResultTabItem[]>([])
const activeResult = ref(0)
const activeCard = computed(() => results.value[activeResult.value])

// --- 结果区分页(服务端分页,默认 500 条/页) --------------------------------
// 新查询成功后记录 lastRequest(重放依据)并回到第 1 页;翻页 = lastRequest
// + 新 offset 重新执行,不经过编辑器(编辑器内容可能与重放脚本不同)。
const PAGE_SIZE = 500
const page = ref(1)
const lastRequest = ref<{ sql: string; database: string } | null>(null)

// 行结果:无错误且 rows 是数组的结果,分页信息以行为准。
const rowResults = computed(() =>
  results.value.filter((r) => !r.error && Array.isArray(r.rows)),
)

// 精确总数:第一个行结果上 ≥0 的 total_rows(-1 是「无法计数」);null = 全部
// 不可计数或未启用分页。
const exactTotal = computed<number | null>(() => {
  for (const r of rowResults.value) {
    if (r.total_rows != null && r.total_rows >= 0) return r.total_rows
  }
  return null
})

// 所有行结果都无法计数(total_rows === -1)→ 「至少 N 条」。
const allUnknownTotal = computed(
  () =>
    rowResults.value.length > 0 &&
    rowResults.value.every((r) => r.total_rows === -1),
)

// --- 脚本只读判定:翻页 = 重放整段脚本,含 DML 的脚本翻一页就重复执行一次,
// 仅当本次执行的每条语句首个关键字都属于只读集合才显示分页条。Hive 无
// TABLE/VALUES 语句;WITH 可能是数据修改 CTE,与其他一切语句(INSERT/
// UPDATE/SET/USE/…)一律保守视为不可重放。 ---
const READONLY_KEYWORDS = new Set(['SELECT', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN'])

// 取语句首个关键字:跳过前导空白与注释(-- 与 # 行注释、/* */ 块注释),
// 大小写不敏感;纯注释/空白/无法识别返回 null(保守视为非只读)。
function firstStatementKeyword(stmt: string): string | null {
  let i = 0
  const n = stmt.length
  for (;;) {
    while (i < n && /\s/.test(stmt[i] as string)) i += 1
    if (stmt.startsWith('--', i) || stmt[i] === '#') {
      const nl = stmt.indexOf('\n', i)
      i = nl === -1 ? n : nl + 1
      continue
    }
    if (stmt.startsWith('/*', i)) {
      const end = stmt.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    break
  }
  const m = /^[A-Za-z_]+/.exec(stmt.slice(i, i + 64))
  return m ? m[0].toUpperCase() : null
}

// 脚本只读判定:全部语句只读 → true;空集或含任何非只读语句 → false。
function scriptIsReadonly(statements: string[]): boolean {
  return (
    statements.length > 0 &&
    statements.every((s) => {
      const kw = firstStatementKeyword(s)
      return kw !== null && READONLY_KEYWORDS.has(kw)
    })
  )
}

// 分页条可见:有行结果,且本次执行的脚本整体只读(重放翻页安全)。
const pagerVisible = computed(
  () => rowResults.value.length > 0 && scriptIsReadonly(results.value.map((r) => r.sql)),
)

const lastPage = computed(() =>
  exactTotal.value == null ? null : Math.max(1, Math.ceil(exactTotal.value / PAGE_SIZE)),
)

// 页码信息:精确总数 → 共 N 条 · 第 p/last 页;全部 -1 → 至少 N 条 · 第 p 页;
// 结果上没有 total_rows(未启用分页的响应)→ 第 x-y 条。
const pagerInfo = computed(() => {
  const first = rowResults.value[0]
  const pageLen = first?.rows?.length ?? 0
  const offset = (page.value - 1) * PAGE_SIZE
  if (exactTotal.value != null) {
    return `共 ${exactTotal.value.toLocaleString('en-US')} 条 · 第 ${page.value}/${lastPage.value ?? 1} 页`
  }
  if (allUnknownTotal.value) {
    return `至少 ${(offset + pageLen).toLocaleString('en-US')} 条 · 第 ${page.value} 页`
  }
  if (pageLen === 0) return `第 ${page.value} 页`
  return `第 ${offset + 1}-${offset + pageLen} 条`
})

const canPrev = computed(() => !running.value && page.value > 1)

// 下一页:执行中禁用;有精确总数时按 lastPage 判定(恰好整页已取完不可再翻,
// total=0 亦不可翻);总数未知(-1/缺省)沿用「本页行数 < PAGE_SIZE 则无更多」。
const canNext = computed(() => {
  if (running.value || rowResults.value.length === 0) return false
  if (exactTotal.value != null) {
    return lastPage.value != null && page.value < lastPage.value
  }
  return rowResults.value.some((r) => (r.rows?.length ?? 0) >= PAGE_SIZE)
})

// 翻页 = 上次成功执行的请求 + 新 offset 重新执行。
function goToPage(target: number): void {
  const req = lastRequest.value
  if (!req) return
  void executeScript(req.sql, req.database, target)
}

function prevPage(): void {
  if (canPrev.value) void goToPage(page.value - 1)
}

function nextPage(): void {
  if (canNext.value) void goToPage(page.value + 1)
}

// 语句单行摘要:第一条非空行(trim,超长截断),供 tab 悬浮提示。
function statementSummary(text: string): string {
  const line = (text.split('\n').find((l) => l.trim() !== '') ?? '').trim()
  return line.length > 80 ? `${line.slice(0, 80)}…` : line
}

// tab 标签:语句起始 offset 上方最近的注释;无注释回退「结果 N」。
// doc 为注释检索的文本:新查询 = 编辑器当前内容,翻页 = 重放的脚本。
function tabLabel(doc: string, from: number, index: number): string {
  return commentAbove(doc, from) ?? `结果 ${index + 1}`
}

// 发起「运行全部」:按拆分段生成 running tab,active 指向第 0 个。
function tabsFromSegments(segs: SqlSegment[], doc: string): ResultTabItem[] {
  return segs.map((s, i) => ({
    label: tabLabel(doc, s.from, i),
    status: 'running',
    title: statementSummary(s.text),
  }))
}

// 运行完成:按结果 error 映射 ok/fail;结果可能少于段数(后端遇错即停)。
function applyTabStatus(tabs: ResultTabItem[], res: HiveStatementResult[]): ResultTabItem[] {
  return tabs.slice(0, res.length).map((t, i) => ({
    ...t,
    status: res[i]?.error ? 'fail' : 'ok',
  }))
}

// --- 两层补全(表名层):Hive 无 information_schema,逐表 DESCRIBE 代价高,
// 补全降级为仅表名层;失败静默降级为空,不打断编辑。 ---
const tables = ref<SqlTableSchema[]>([])

// --- 当前库(单一状态源):命令条选择器、执行 payload、保存文件头都取自
// activeDb;初值来自入口传参(表浏览器/树入口),为空 = 连接默认库。 ---
const activeDb = ref(props.database ?? '')
const databases = ref<string[]>([])

// 选项 = 后端库清单;activeDb(含失败降级场景)不在清单时动态追加,保证当前值可见。
const dbOptions = computed(() =>
  activeDb.value && !databases.value.includes(activeDb.value)
    ? [...databases.value, activeDb.value]
    : databases.value,
)

// 拉取库清单供选择器展示;失败静默为空,不影响编辑与执行。
async function loadDatabases(): Promise<void> {
  try {
    databases.value = (await getApi().listHiveDatabases?.(props.connectionId)) ?? []
  } catch {
    databases.value = []
  }
}

// 切换当前库(选择器手动切换 / 载入文件恢复):重拉表名补全并重置语句标记;
// 同库为幂等空操作。
async function switchDb(db: string): Promise<void> {
  if (activeDb.value === db) return
  activeDb.value = db
  markedStatements.value = []
  await loadTables()
}

function onDbChange(e: Event): void {
  void switchDb((e.target as HTMLSelectElement).value)
}

async function loadTables(): Promise<void> {
  // 未指定库按 Hive 默认库 default 拉表清单(仅影响补全,不改 activeDb)。
  const db = activeDb.value || 'default'
  try {
    const list = (await getApi().listHiveTables?.({
      connection_id: props.connectionId,
      database: db,
    })) ?? []
    tables.value = list.map((t) => ({ name: t.name }))
  } catch {
    tables.value = []
  }
}

// --- 语句状态标记 -------------------------------------------------------------
// markedStatements 保存最近一次运行的语句级状态(运行中/成功/失败);编辑器
// 内容变化后按语句文本(trim 后相等)对 split 结果重新定位,匹配不到的丢弃。
interface MarkedStatement {
  text: string
  status: 'ok' | 'fail' | 'running'
  detail?: string
}
const markedStatements = ref<MarkedStatement[]>([])

const statementMarks = computed(() => {
  const segs = splitSqlStatements(sql.value)
  const used = new Set<number>()
  const marks: { from: number; status: 'ok' | 'fail' | 'running'; detail?: string }[] = []
  for (const m of markedStatements.value) {
    const idx = segs.findIndex((s, i) => !used.has(i) && s.text.trim() === m.text.trim())
    if (idx === -1) continue
    used.add(idx)
    marks.push({ from: segs[idx].from, status: m.status, detail: m.detail })
  }
  return marks
})

// 返回结果与发起文本按顺序映射成语句标记:耗时来自 duration_ms,错误用原文。
function marksFromResults(texts: string[], res: HiveStatementResult[]): MarkedStatement[] {
  return res.map((r, i): MarkedStatement => ({
    text: texts[i] ?? r.sql,
    status: r.error ? 'fail' : 'ok',
    detail: r.error ?? `${r.duration_ms} ms`,
  }))
}

// --- 光标位置与「执行当前语句」 ------------------------------------------------
// SqlEditor 的 cursor emit(1 基行列)记录最新光标;⌘Enter 时把行列换算成文本
// offset,在 split 结果中定位光标所在语句段(段间空白归属前一段)。
const cursorPos = ref({ line: 1, col: 1 })

function onCursor(pos: { line: number; col: number }): void {
  cursorPos.value = { line: pos.line, col: pos.col }
}

function cursorOffset(text: string, pos: { line: number; col: number }): number {
  const lines = text.split('\n')
  let offset = 0
  for (let i = 0; i < Math.min(pos.line - 1, lines.length); i++) offset += lines[i].length + 1
  const lineText = lines[Math.min(Math.max(pos.line - 1, 0), lines.length - 1)] ?? ''
  return offset + Math.min(Math.max(pos.col - 1, 0), lineText.length)
}

function statementAtCursor(): string | null {
  const segs = splitSqlStatements(sql.value)
  if (segs.length === 0) return null
  const offset = cursorOffset(sql.value, cursorPos.value)
  const seg =
    segs.find((s) => offset >= s.from && offset <= s.to) ??
    [...segs].reverse().find((s) => s.to <= offset)
  return (seg ?? segs[0]).text
}

// 单语句执行:只发该段文本,结果数组替换为该条结果;发起即置 running 标记,
// 并预置单个 running tab(标签优先取该语句的前置注释)。新查询成功后记录
// lastRequest 并回到第 1 页(服务端分页默认 500 条/页)。
async function runSingle(text: string): Promise<void> {
  if (running.value) return
  if (!text.trim()) return
  running.value = true
  error.value = null
  resultsOpen.value = true
  markedStatements.value = [{ text, status: 'running' }]
  const seg = splitSqlStatements(sql.value).find((s) => s.text.trim() === text.trim())
  resultTabs.value = [
    {
      label: seg ? tabLabel(sql.value, seg.from, 0) : '结果 1',
      status: 'running',
      title: statementSummary(text),
    },
  ]
  activeResult.value = 0
  try {
    const res = (await getApi().hiveExecute?.({
      connection_id: props.connectionId,
      sql: text,
      database: activeDb.value,
      limit: PAGE_SIZE,
      offset: 0,
    })) ?? []
    results.value = res
    lastRequest.value = { sql: text, database: activeDb.value }
    page.value = 1
    // 选中文本可能含多条语句:结果多于预置 tab 时按序回退「结果 N」补齐。
    resultTabs.value = res.map((r, i) => ({
      label: resultTabs.value[i]?.label ?? `结果 ${i + 1}`,
      status: r.error ? 'fail' : 'ok',
      title: resultTabs.value[i]?.title ?? statementSummary(r.sql),
    }))
    markedStatements.value = marksFromResults([text], res)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    error.value = msg
    markedStatements.value = [{ text, status: 'fail', detail: msg }]
    resultTabs.value = resultTabs.value.map((t) => ({ ...t, status: 'fail' }))
  } finally {
    running.value = false
  }
}

// ⌘Enter:选区非空仍执行选中文本(沿用 getSelection 优先);否则执行光标所在语句。
async function runCurrentStatement(): Promise<void> {
  const selection = editor.value?.getSelection() ?? ''
  if (selection.trim() !== '') {
    await runSingle(selection)
    return
  }
  const text = statementAtCursor()
  if (text === null || !text.trim()) return
  await runSingle(text)
}

// 运行全部:整段脚本交给后端拆分,标记按 split 段与返回结果顺序映射;
// 结果 tab 同步推进(running → ok/fail),active 重置到第 0 个。
async function runAll(): Promise<void> {
  if (running.value) return
  if (!sql.value.trim()) return
  await executeScript(sql.value, activeDb.value, 1)
}

// 执行一段脚本(新查询 targetPage=1;翻页 = 重放 lastRequest + 新 offset)。
// 成功后记录 lastRequest 与当前页码;失败保持原页码,便于重试。
async function executeScript(script: string, database: string, targetPage: number): Promise<void> {
  if (running.value) return
  running.value = true
  error.value = null
  resultsOpen.value = true
  const segs = splitSqlStatements(script)
  markedStatements.value = segs.map((s): MarkedStatement => ({ text: s.text, status: 'running' }))
  resultTabs.value = tabsFromSegments(segs, script)
  activeResult.value = 0
  try {
    const res = (await getApi().hiveExecute?.({
      connection_id: props.connectionId,
      sql: script,
      database,
      limit: PAGE_SIZE,
      offset: (targetPage - 1) * PAGE_SIZE,
    })) ?? []
    results.value = res
    resultTabs.value = applyTabStatus(resultTabs.value, res)
    markedStatements.value = res.map((r, i): MarkedStatement => ({
      text: segs[i]?.text ?? r.sql,
      status: r.error ? 'fail' : 'ok',
      detail: r.error ?? `${r.duration_ms} ms`,
    }))
    lastRequest.value = { sql: script, database }
    page.value = targetPage
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    error.value = msg
    markedStatements.value = segs.map((s): MarkedStatement => ({ text: s.text, status: 'fail', detail: msg }))
    resultTabs.value = resultTabs.value.map((t) => ({ ...t, status: 'fail' }))
  } finally {
    running.value = false
  }
}

// SqlEditor 主动请求执行某条语句(如编辑器内置快捷键)——走单语句逻辑。
function onRunStatement(text: string): void {
  void runSingle(text)
}

// 右键菜单「执行选中语句」:按整段选中文本执行(多语句由后端拆分);空选区忽略。
function onRunSelection(text: string): void {
  if (!text.trim()) return
  void runSingle(text)
}

// --- IDE 式布局:可拖拽结果区 ---------------------------------------------------
// 结果区仅打开时渲染;高度 160..窗口 80% 可拖拽,双击分隔条恢复 50/50,
// 持久化到 localStorage(与其它控制台共用同一 key)。
const RESULTS_HEIGHT_KEY = 'dbclient-sql-results-height'
const MIN_RESULTS_HEIGHT = 160
const DEFAULT_RESULTS_HEIGHT = 320

const resultsOpen = ref(false)
const rootRef = ref<HTMLElement | null>(null)

function maxResultsHeight(): number {
  return Math.max(MIN_RESULTS_HEIGHT, Math.floor(window.innerHeight * 0.8))
}

function clampResultsHeight(h: number): number {
  return Math.min(maxResultsHeight(), Math.max(MIN_RESULTS_HEIGHT, h))
}

function readStoredResultsHeight(): number {
  const v = Number(localStorage.getItem(RESULTS_HEIGHT_KEY))
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_RESULTS_HEIGHT
  return clampResultsHeight(Math.round(v))
}

const resultsHeight = ref(readStoredResultsHeight())
const resultsResizing = ref(false)
let resultsDragStartY = 0
let resultsDragStartHeight = 0

function startResultsResize(e: MouseEvent): void {
  resultsResizing.value = true
  resultsDragStartY = e.clientY
  resultsDragStartHeight = resultsHeight.value
  window.addEventListener('mousemove', onResultsResize)
  window.addEventListener('mouseup', endResultsResize)
}

function onResultsResize(e: MouseEvent): void {
  // 结果区在下方:向上拖(dy 为负)增高。
  resultsHeight.value = clampResultsHeight(resultsDragStartHeight - (e.clientY - resultsDragStartY))
}

function endResultsResize(): void {
  resultsResizing.value = false
  localStorage.setItem(RESULTS_HEIGHT_KEY, String(resultsHeight.value))
  window.removeEventListener('mousemove', onResultsResize)
  window.removeEventListener('mouseup', endResultsResize)
}

// 双击分隔条:恢复上下 50/50(容器无布局高度时按窗口高折半)。
function resetResultsHeight(): void {
  const total = rootRef.value?.clientHeight || window.innerHeight
  resultsHeight.value = clampResultsHeight(Math.round(total / 2))
  localStorage.setItem(RESULTS_HEIGHT_KEY, String(resultsHeight.value))
}

// --- 状态栏:光标行列 / 语句条数 / 最近耗时 ------------------------------------
const statementCount = computed(() => splitSqlStatements(sql.value).length)
const lastDurationMs = computed(() => results.value.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0))

// --- 查询文件:保存/载入/删除由共享 composable 驱动,文件列表展示在全局右栏
// (Layout 层);本组件只负责编辑器侧的对话框与脏检查。 ---
// 快照:最近一次「载入/保存」完成时的编辑器内容,用于载入前的脏检查。
const savedSnapshot = ref('')

const qf = useQueryFiles({
  connectionId: () => props.connectionId,
  getContent: () => sql.value,
  // 文件内容回填编辑器的时刻 = 已保存状态,同步刷新快照。
  setContent: (s: string) => {
    sql.value = s
    savedSnapshot.value = s
  },
  // 保存把当前库写入文件头;载入按文件头恢复库并刷新补全。
  // 空串 = 文件未关联库,保持当前库不动,不误切。
  getDatabase: () => activeDb.value,
  setDatabase: (db: string) => {
    if (db) void switchDb(db)
  },
  // 同名覆盖保存时 currentFile 不变、下方 watcher 不触发,靠 onSaved 对齐
  // 快照,避免刚保存的内容被下一次载入误判为「未保存」。
  onSaved: () => {
    savedSnapshot.value = sql.value
  },
})

// composable 把 ref 嵌在普通对象里返回,模板不自动解包,这里统一取值。
const currentFile = computed(() => unref(qf.currentFile))
const nameDialogShow = computed(() => unref(qf.nameDialog.open))
const nameDialogMode = computed(() => unref(qf.nameDialog.mode))
const nameDialogTitle = computed(() => (nameDialogMode.value === 'save-as' ? '另存查询' : '保存查询'))
const overwriteShow = computed(() => unref(qf.overwriteConfirm.open))
const deleteConfirmShow = computed(() => unref(qf.deleteConfirm.open))
const deleteConfirmMessage = computed(() => unref(qf.deleteConfirm.message))

// 挂载恢复:本组件随 Layout 的 :key="active.id" 在切 tab 时销毁重建,编辑器
// 内容与文件关联持久化在所属 tab 的 draft 上;有草稿则在首次渲染前同步恢复
// (sql + 脏检查快照 + 文件关联 + 库选择,不读盘),标题由下方 renameTab watch
// 校准;恢复的 activeDb 让挂载补全按该库加载,不再退回「连接默认数据库」。
const mountedDraft = useTabsStore().openTabs.find((t) => t.id === props.tabId)?.draft
if (mountedDraft) {
  sql.value = mountedDraft.sql
  savedSnapshot.value = mountedDraft.sql
  qf.restoreFile(mountedDraft.file)
  if (mountedDraft.database) activeDb.value = mountedDraft.database
}

// 保存成功(currentFile 变化)也刷新快照,避免刚保存的内容被误判为脏。
watch(currentFile, () => {
  savedSnapshot.value = sql.value
})

// --- tab 标题跟随当前打开的 SQL 文件 -----------------------------------------
// 载入文件、⌘S 保存为新文件(关联变化)、删除/取消关联(currentFile 归空回退
// 默认标题「SQL 控制台」)都经 currentFile 变化驱动;immediate 保证挂载时校准。
const tabs = useTabsStore()
watch(
  currentFile,
  (f) => {
    tabs.renameTab(props.tabId, f ?? 'SQL 控制台')
  },
  { immediate: true },
)

// 编辑器内容、文件关联与库选择变化时写回 tab draft,供切 tab 销毁重建后
// 恢复(见上方挂载恢复);draft 随 tab 对象存在,关闭 tab 自然丢弃。
watch([sql, currentFile, activeDb], ([v, f, db]) => {
  tabs.setTabDraft(props.tabId, { sql: v, file: f, database: db })
})

// ⌘S / Ctrl+S 保存;⌘Enter / Ctrl+Enter 执行当前语句;⌘Shift+Enter 运行全部
// (与其它 SQL 控制台一致,忽略 IME 组合中的按键)。事件从 CodeMirror
// contentDOM 冒泡到外层容器在此接住;编辑器自带的 run-statement emit 也接入,
// 双入口由 running 守卫去重。
function onEditorKeydown(e: KeyboardEvent): void {
  if (e.isComposing || e.keyCode === 229) return
  if (running.value) return
  if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault()
    qf.requestSave()
    return
  }
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'Enter') {
    e.preventDefault()
    void runAll()
    return
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    void runCurrentStatement()
  }
}

// --- 载入前的未保存确认(组件本地状态):右栏载入文件时,若编辑器有
// 未保存改动,先弹确认,避免无声覆盖用户正在编辑的 SQL。 ---
const loadConfirmShow = ref(false)
let pendingLoadName: string | null = null

function isDirty(): boolean {
  // 已关联文件:内容与快照不一致即脏;未关联:只要输入过非空白内容即脏。
  return currentFile.value ? sql.value !== savedSnapshot.value : sql.value.trim() !== ''
}

function requestLoadQueryFile(name: string): void {
  if (isDirty()) {
    pendingLoadName = name
    loadConfirmShow.value = true
    return
  }
  void qf.loadQueryFile(name)
}

function confirmLoad(): void {
  loadConfirmShow.value = false
  const name = pendingLoadName
  pendingLoadName = null
  if (name) void qf.loadQueryFile(name)
}

function cancelLoad(): void {
  loadConfirmShow.value = false
  pendingLoadName = null
}

// 暴露给全局右栏(Layout 层)调用的查询文件能力。
defineExpose({
  requestSave: () => {
    qf.requestSave()
  },
  requestSaveAs: () => {
    qf.requestSaveAs()
  },
  loadQueryFile: requestLoadQueryFile,
  askRemoveCurrentFile: () => {
    qf.askRemoveCurrentFile()
  },
  currentFile: (): string | null => currentFile.value,
})

onMounted(() => {
  void loadDatabases()
  void loadTables()
})

// database 变化(如表浏览器入口切库)→ 同步 activeDb 并重拉该库的补全。
watch(
  () => props.database,
  (db) => {
    activeDb.value = db ?? ''
    void loadTables()
  },
)
</script>

<template>
  <div ref="rootRef" class="hive-sql" data-test="hive-sql-console">
    <div class="editor-pane">
      <div class="command-bar">
        <button class="btn primary" type="button" data-test="btn-hive-run" :disabled="running || !sql.trim()" @click="runAll">
          {{ running ? '运行中…' : '运行全部' }}
        </button>
        <!-- 当前库选择器:执行与保存(文件头)统一使用该库;空值 = 连接默认库。 -->
        <label class="db-select" title="当前库:执行与保存的 SQL 都将使用该库">
          <span class="toolbar-hint">库</span>
          <select data-test="hive-db-select" class="input" :value="activeDb" @change="onDbChange">
            <option value="">(连接默认库)</option>
            <option v-for="d in dbOptions" :key="d" :value="d">{{ d }}</option>
          </select>
        </label>
        <span class="toolbar-hint">⌘Enter 执行当前语句 · ⌘Shift+Enter 运行全部 · ⌘S 保存</span>
      </div>
      <div class="editor-wrap" @keydown="onEditorKeydown">
        <SqlEditor
          ref="editor"
          v-model="sql"
          :tables="tables"
          height="100%"
          statement-gutter
          :statement-marks="statementMarks"
          highlight-cursor-statement
          enable-run-menu
          data-test="hive-sql-input"
          placeholder="SELECT * FROM events WHERE dt = '2026-01-01'"
          @run-statement="onRunStatement"
          @run-selection="onRunSelection"
          @run-current="runCurrentStatement"
          @run-all="runAll"
          @cursor="onCursor"
        />
      </div>

      <!-- 运行错误展示区;语句级错误由 SqlResultCard 的错误卡渲染。 -->
      <div v-if="error" class="msg err" data-test="hive-sql-error">{{ error }}</div>
    </div>

    <!-- 结果区:仅打开时渲染,高度可拖拽(160..窗口 80%),双击分隔条恢复 50/50。 -->
    <template v-if="resultsOpen">
      <div
        class="splitter"
        :class="{ active: resultsResizing }"
        data-test="console-splitter"
        title="拖拽调整结果区高度,双击恢复 50/50"
        @mousedown.prevent="startResultsResize"
        @dblclick="resetResultsHeight"
      ></div>
      <div class="results-pane" data-test="results-pane" :style="{ height: `${resultsHeight}px` }">
        <div class="results-head">
          <span class="results-title">结果</span>
          <button class="results-close" type="button" data-test="results-close" title="关闭结果区" @click="resultsOpen = false">×</button>
        </div>
        <div class="results-body" data-test="results-body">
          <!-- 结果 Tab 条:每条语句一个 tab,点击切换下方唯一的结果卡。 -->
          <SqlResultTabs :tabs="resultTabs" :active="activeResult" @select="activeResult = $event" />
          <!-- 分页条:服务端分页(500 条/页),翻页按上次成功请求重放;仅只读脚本可翻。 -->
          <div v-if="pagerVisible" class="result-pager" data-test="result-pager" title="跨页分页由后端 ROW_NUMBER 窗口包装保证;无排序查询顺序以数据库返回为准">
            <button type="button" class="pager-btn" data-test="pager-prev" :disabled="!canPrev" @click="prevPage">上一页</button>
            <span class="pager-info" data-test="pager-info">{{ pagerInfo }}</span>
            <button type="button" class="pager-btn" data-test="pager-next" :disabled="!canNext" @click="nextPage">下一页</button>
          </div>
          <div v-if="results.length === 0" class="empty" data-test="results-empty">⌘Enter 执行当前语句 · ⌘Shift+Enter 运行全部</div>
          <!-- 仅渲染 active tab 对应的结果卡;Hive 结果只读(无行级写)。 -->
          <SqlResultCard
            v-else-if="activeCard"
            :key="activeResult"
            :statement="activeCard.sql"
            :duration-ms="activeCard.duration_ms"
            :columns="activeCard.columns ?? []"
            :rows="activeCard.rows ?? []"
            :total-rows="activeCard.total_rows ?? null"
            :export-name="`hive-result-${activeResult}`"
            :error="activeCard.error ?? null"
          />
        </div>
      </div>
    </template>

    <!-- 状态栏:光标行列 / 语句条数 / 最近耗时。 -->
    <div class="statusbar" data-test="console-statusbar">
      <span data-test="statusbar-cursor">行 {{ cursorPos.line }} : 列 {{ cursorPos.col }}</span>
      <span data-test="statusbar-statements">语句 {{ statementCount }} 条</span>
      <span data-test="statusbar-duration">最近耗时 {{ lastDurationMs }} ms</span>
    </div>

    <!-- 查询文件相关弹窗:名称输入(保存/另存为)、覆盖确认、删除确认由
         composable 的状态驱动;载入确认是本组件的本地状态。 -->
    <PromptDialog
      :show="nameDialogShow"
      :title="nameDialogTitle"
      label="文件名"
      confirm-text="保存"
      @confirm="qf.confirmName"
      @cancel="qf.nameDialog.cancel()"
    />
    <ConfirmDialog
      :show="overwriteShow"
      message="文件已存在,是否覆盖?"
      confirm-text="覆盖"
      :danger="false"
      @confirm="qf.overwriteConfirm.confirm()"
      @cancel="qf.overwriteConfirm.cancel()"
    />
    <ConfirmDialog
      :show="deleteConfirmShow"
      :message="deleteConfirmMessage"
      confirm-text="删除"
      danger
      @confirm="qf.deleteConfirm.confirm()"
      @cancel="qf.deleteConfirm.cancel()"
    />
    <ConfirmDialog
      :show="loadConfirmShow"
      message="当前 SQL 未保存,载入将替换?"
      confirm-text="载入"
      :danger="false"
      @confirm="confirmLoad"
      @cancel="cancelLoad"
    />
  </div>
</template>

<style scoped>
.hive-sql {
  height: 100%;
  display: flex; flex-direction: column;
  padding: 14px 16px; box-sizing: border-box;
  color: var(--text); font-family: var(--font);
}

/* 编辑器区:占据结果区之外的剩余空间。 */
.editor-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.command-bar { flex: none; display: flex; align-items: center; gap: 10px; padding-bottom: 8px; }
.toolbar-hint { font-size: 12px; color: var(--text-tertiary); }
/* 当前库选择器:hint 风格小标签 + 下拉,紧邻运行按钮右侧。 */
.db-select { display: inline-flex; align-items: center; gap: 6px; }
.db-select .input {
  background: var(--bg-subtle); border: 1px solid var(--border); color: var(--text);
  border-radius: 7px; padding: 5px 8px; font-size: 12px; max-width: 180px;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.db-select .input:focus { outline: none; border-color: var(--accent); background: var(--bg-elevated); }
.editor-wrap { flex: 1; min-height: 0; display: flex; }
.editor-wrap :deep(.sql-editor) { flex: 1; min-width: 0; }
.msg { font-size: 13px; border-radius: 9px; padding: 8px 12px; }
.msg.err { background: var(--danger-soft); color: var(--danger); }
.editor-wrap + .msg { margin-top: 10px; }

/* 可拖拽分隔条与结果区。 */
.splitter { flex: none; height: 7px; margin: 4px -16px; cursor: row-resize; }
.splitter:hover, .splitter.active { background: var(--accent-soft); }
.results-pane {
  flex: none; display: flex; flex-direction: column;
  border: 1px solid var(--border); border-radius: 10px; background: var(--bg-elevated); overflow: hidden;
}
.results-head { display: flex; align-items: center; gap: 8px; padding: 5px 10px; border-bottom: 1px solid var(--border); }
.results-title { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.results-close {
  margin-left: auto; border: none; background: transparent; color: var(--text-secondary);
  font-size: 14px; line-height: 1; cursor: pointer; padding: 2px 7px; border-radius: 5px;
}
.results-close:hover { background: var(--bg-hover); color: var(--text); }
.results-body { flex: 1; min-height: 0; overflow: auto; padding: 10px; display: flex; flex-direction: column; gap: 12px; }
.empty { text-align: center; color: var(--text-tertiary); padding: 24px; font-size: 13px; }

/* 结果分页条:上一页 / 页码信息 / 下一页。 */
.result-pager { flex: none; display: flex; align-items: center; justify-content: center; gap: 12px; }
.pager-btn {
  border: 1px solid var(--border); background: var(--bg-subtle); color: var(--text);
  border-radius: 7px; padding: 3px 12px; font-size: 12px; cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.pager-btn:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--accent); }
.pager-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.pager-info { font-size: 12px; color: var(--text-secondary); font-family: var(--mono); }

/* 状态栏:光标行列 / 语句条数 / 最近耗时。 */
.statusbar {
  flex: none; display: flex; gap: 14px; margin-top: 8px;
  font-size: 11px; color: var(--text-tertiary); font-family: var(--mono);
}

.btn { border-radius: 7px; padding: 7px 14px; font-size: 13px; cursor: pointer; border: 1px solid transparent; transition: background 0.15s ease, opacity 0.15s ease; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.primary { background: var(--accent); color: #fff; }
.btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
</style>
