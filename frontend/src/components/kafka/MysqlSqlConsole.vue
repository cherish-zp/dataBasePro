<script setup lang="ts">
import { computed, onMounted, ref, unref, watch } from 'vue'
import type { SqlTableSchema } from '@/components/common/SqlEditor.vue'
import { parseCHSingleTableSelect } from '@/utils/chSql'
import { commentAbove, splitSqlStatements, type SqlSegment } from '@/utils/sqlSplit'
import { useQueryFiles } from '@/composables/queryFiles'
import { useTabsStore } from '@/store/tabs'
import SqlEditor from '@/components/common/SqlEditor.vue'
import SqlResultCard from '@/components/common/SqlResultCard.vue'
import SqlResultTabs, { type ResultTabItem } from '@/components/common/SqlResultTabs.vue'
import PromptDialog from '@/components/common/PromptDialog.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import * as App from '../../../wailsjs/go/backend/App'

// tabId 必填:控制台据此把 tabs store 中自己的 tab 重命名为当前关联文件名。
const props = defineProps<{ tabId: string; connectionId: string; database?: string }>()

// MysqlExecute / MysqlPreviewCellUpdate / MysqlUpdateCell / ListMysqlTables 绑定
// 尚未由 wails generate module 生成,这里按显式形状断言调用(req 为
// snake_case 字段原样,Wails 按字段名序列化);生成后签名一致,无需改动本文件。
interface MysqlColumn {
  name: string
  type: string
  comment?: string
}
interface MysqlStatementResult {
  sql: string
  duration_ms: number
  error?: string
  columns?: MysqlColumn[]
  rows?: (string | null)[][]
  // 单表 SELECT 时后端填充的主键列名数组(供结果卡行选择/INSERT 选项)。
  primary_key?: string[]
}
interface MysqlTableInfo {
  name: string
  engine?: string
  table_rows?: number
  comment?: string
}
// 单元格更新目标:参数化在后端,前端只传列名与值(禁止拼 SQL 文本执行)。
interface MysqlCellRef {
  column: string
  value: string | null
}
interface MysqlCellUpdateTarget {
  connection_id: string
  database: string // '' = 连接当前库
  table: string
  set: MysqlCellRef
  where: MysqlCellRef[] // 行定位(整行所有列原值)
}

const app = App as unknown as {
  MysqlExecute(req: { connection_id: string; sql: string; database?: string }): Promise<MysqlStatementResult[]>
  MysqlPreviewCellUpdate(req: MysqlCellUpdateTarget): Promise<{ statement: string; matched_rows: number }>
  MysqlUpdateCell(req: MysqlCellUpdateTarget): Promise<void>
  ListMysqlTables(req: { connection_id: string; database: string }): Promise<MysqlTableInfo[]>
  // ListMysqlDatabases 绑定已生成,签名为 (connection_id: string) => Promise<string[]>;
  // 为与未生成方法统一经断言对象调用,这里按实际形状声明。
  ListMysqlDatabases(id: string): Promise<string[]>
}

const sql = ref('')
const running = ref(false)
const error = ref<string | null>(null)
const results = ref<MysqlStatementResult[]>([])
const editor = ref<InstanceType<typeof SqlEditor> | null>(null)

// --- 结果 Tab 条:每个语句结果一个 tab,Tab 条下方只渲染 active 的那张卡。 ---
// label = 语句起始上方最近的注释文本(commentAbove),无注释回退「结果 N」;
// status 随运行推进 running → ok/fail;title 为语句单行摘要。
const resultTabs = ref<ResultTabItem[]>([])
const activeResult = ref(0)
const activeCard = computed(() => results.value[activeResult.value])

// 语句单行摘要:第一条非空行(trim,超长截断),供 tab 悬浮提示。
function statementSummary(text: string): string {
  const line = (text.split('\n').find((l) => l.trim() !== '') ?? '').trim()
  return line.length > 80 ? `${line.slice(0, 80)}…` : line
}

// tab 标签:语句起始 offset 上方最近的注释;无注释回退「结果 N」。
function tabLabel(from: number, index: number): string {
  return commentAbove(sql.value, from) ?? `结果 ${index + 1}`
}

// 发起「运行全部」:按拆分段生成 running tab,active 指向第 0 个。
function tabsFromSegments(segs: SqlSegment[]): ResultTabItem[] {
  return segs.map((s, i) => ({
    label: tabLabel(s.from, i),
    status: 'running',
    title: statementSummary(s.text),
  }))
}

// 运行完成:按结果 error 映射 ok/fail;结果可能少于段数(后端遇错即停)。
function applyTabStatus(tabs: ResultTabItem[], res: MysqlStatementResult[]): ResultTabItem[] {
  return tabs.slice(0, res.length).map((t, i) => ({
    ...t,
    status: res[i]?.error ? 'fail' : 'ok',
  }))
}

// --- 三层补全(表 → 列):挂载时(及 database 变化)拉表清单,再查一次
// information_schema.columns 组装列;失败静默降级,不打断编辑。 ---
const tables = ref<SqlTableSchema[]>([])

// 数据库名内嵌进只读系统表查询的 SQL 文本前,按 MySQL 字符串字面量转义
// (反斜杠与单引号),防止特殊字符破坏语句结构。
function quoteLiteral(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

// --- 当前库(单一状态源):命令条选择器、执行 payload、保存文件头、三层补全
// 都取自 activeDb;初值来自入口传参(表浏览器等),为空 = 连接默认库。 ---
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
    databases.value = await app.ListMysqlDatabases(props.connectionId)
  } catch {
    databases.value = []
  }
}

// 切换当前库(选择器手动切换 / 载入文件恢复):重拉三层补全并重置语句标记;
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
  let db = activeDb.value
  if (!db) {
    // 未指定库:先探测连接的当前库;失败降级为仅表名层。探测出的库只影响
    // 补全与选择器选项,不改 activeDb(执行仍按连接默认库)。
    try {
      const res = await app.MysqlExecute({
        connection_id: props.connectionId,
        sql: 'SELECT DATABASE()',
        database: activeDb.value,
      })
      db = res[0]?.rows?.[0]?.[0] ?? ''
      if (db && !databases.value.includes(db)) databases.value = [...databases.value, db]
    } catch {
      db = ''
    }
  }
  try {
    const list = await app.ListMysqlTables({ connection_id: props.connectionId, database: db })
    const columnsByTable: Record<string, string[]> = {}
    if (db) {
      try {
        const res = await app.MysqlExecute({
          connection_id: props.connectionId,
          sql: `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = ${quoteLiteral(db)} ORDER BY ordinal_position`,
          database: activeDb.value,
        })
        for (const row of res[0]?.rows ?? []) {
          const tableName = row[0]
          const columnName = row[1]
          if (tableName == null || columnName == null) continue
          ;(columnsByTable[tableName] ??= []).push(columnName)
        }
      } catch {
        // 列清单拉取失败:降级为仅表名层。
      }
    }
    tables.value = list.map((t) => {
      const cols = columnsByTable[t.name]
      return cols && cols.length > 0 ? { name: t.name, columns: cols } : { name: t.name }
    })
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
function marksFromResults(texts: string[], res: MysqlStatementResult[]): MarkedStatement[] {
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
// 并预置单个 running tab(标签优先取该语句的前置注释)。
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
      label: seg ? tabLabel(seg.from, 0) : '结果 1',
      status: 'running',
      title: statementSummary(text),
    },
  ]
  activeResult.value = 0
  try {
    const res = await app.MysqlExecute({
      connection_id: props.connectionId,
      sql: text,
      database: activeDb.value,
    })
    results.value = res
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
  const script = sql.value
  if (!script.trim()) return
  running.value = true
  error.value = null
  resultsOpen.value = true
  const segs = splitSqlStatements(script)
  markedStatements.value = segs.map((s): MarkedStatement => ({ text: s.text, status: 'running' }))
  resultTabs.value = tabsFromSegments(segs)
  activeResult.value = 0
  try {
    const res = await app.MysqlExecute({
      connection_id: props.connectionId,
      sql: script,
      database: activeDb.value,
    })
    results.value = res
    resultTabs.value = applyTabStatus(resultTabs.value, res)
    markedStatements.value = res.map((r, i): MarkedStatement => ({
      text: segs[i]?.text ?? r.sql,
      status: r.error ? 'fail' : 'ok',
      detail: r.error ?? `${r.duration_ms} ms`,
    }))
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
// 持久化到 localStorage(与 CH 控制台共用同一 key)。
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

// --- 查询结果行内编辑(仅单表 SELECT 结果可编辑) -----------------------------
// 结果若来自单表 SELECT(允许 WHERE/ORDER BY/LIMIT),卡片发出 cell-dblclick
// 进入行内编辑;edit-commit 后预览(确认弹窗展示后端生成的 UPDATE 语句全文
// 与匹配行数),确认执行成功后重新执行该条语句刷新结果。复杂查询只读。
// 预览/执行状态机(与 useCHCellUpdate 同构,但 MySQL 侧只传列名与值):
const cuPreviewing = ref(false)
const cuError = ref<string | null>(null)
const cuConfirmOpen = ref(false)
const cuStatement = ref('')
const cuMatchedRows = ref(0)
// 预览通过后暂存的待执行目标,确认时原样发给执行。
let cuPending: MysqlCellUpdateTarget | null = null

async function requestCellUpdate(target: MysqlCellUpdateTarget): Promise<void> {
  cuPending = target
  cuPreviewing.value = true
  cuError.value = null
  try {
    const res = await app.MysqlPreviewCellUpdate(target)
    cuStatement.value = res.statement
    cuMatchedRows.value = res.matched_rows
    cuConfirmOpen.value = true
  } catch (e) {
    cuError.value = e instanceof Error ? e.message : String(e)
    cuPending = null
  } finally {
    cuPreviewing.value = false
  }
}

// 每条语句结果是否可编辑:有 error 的结果与解析不出单表来源的结果只读。
const editableResults = computed<boolean[]>(() =>
  results.value.map((r) => !r.error && parseCHSingleTableSelect(r.sql) !== null),
)

// 行内编辑状态:目标(结果索引/行索引/列索引)+ 初始草稿;null 表示未在编辑。
interface CellEdit {
  stmtIndex: number
  rowIndex: number
  colIndex: number
  draft: string
}
const cellEdit = ref<CellEdit | null>(null)

// 卡片的 editing prop:仅当该卡对应单元格处于编辑态时非空。
function editingFor(stmtIndex: number): { row: number; col: number; draft: string } | null {
  const e = cellEdit.value
  if (!e || e.stmtIndex !== stmtIndex) return null
  return { row: e.rowIndex, col: e.colIndex, draft: e.draft }
}

// 进入编辑:原始值取结果行内存(NULL→空草稿)。运行中或不可编辑结果忽略。
function startCellEdit(stmtIndex: number, rowIndex: number, colIndex: number): void {
  if (running.value || !editableResults.value[stmtIndex]) return
  const row = results.value[stmtIndex]?.rows?.[rowIndex]
  if (!row) return
  cellEdit.value = {
    stmtIndex,
    rowIndex,
    colIndex,
    draft: row[colIndex] ?? '',
  }
}

function cancelCellEdit(): void {
  cellEdit.value = null
}

// 卡片事件适配:edit-commit 的 value 契约为 string|null(实现恒为字符串),
// 统一归一化为空串(空输入按 NULL 写入)。

// where 条件 = 整行所有列的原值(NULL 列 value=null)。
function buildWhere(r: MysqlStatementResult, rowIndex: number): MysqlCellRef[] {
  const row = r.rows?.[rowIndex] ?? []
  return (r.columns ?? []).map((c, i) => ({ column: c.name, value: row[i] ?? null }))
}

// 回车提交:构造 set(空输入→null)与整行 where,交给预览并弹确认。
function commitCellEdit(stmtIndex: number, value: string): void {
  const e = cellEdit.value
  if (!e || e.stmtIndex !== stmtIndex) return
  const r = results.value[stmtIndex]
  const parsed = r ? parseCHSingleTableSelect(r.sql) : null
  const col = r?.columns?.[e.colIndex]
  cellEdit.value = null
  if (!r || !parsed || !col) return
  pendingStmtIndex = stmtIndex
  void requestCellUpdate({
    connection_id: props.connectionId,
    database: parsed.database,
    table: parsed.table,
    set: { column: col.name, value: value === '' ? null : value },
    where: buildWhere(r, e.rowIndex),
  })
}

// 待刷新的结果索引:确认成功后重跑该条语句并原位替换结果。
let pendingStmtIndex: number | null = null

// 确认弹窗文案:UPDATE 语句全文 + 匹配行数;匹配多行时追加警示并把按钮置为危险色。
const cellUpdateMessage = computed(() => {
  const n = cuMatchedRows.value
  const base = `${cuStatement.value}\n匹配 ${n} 行`
  return n > 1 ? `${base}\n注意:该条件命中 ${n} 行,将全部更新。` : base
})

async function confirmCellUpdate(): Promise<void> {
  const idx = pendingStmtIndex
  pendingStmtIndex = null
  if (!cuPending) {
    cuError.value = '没有待执行的单元格更新'
    return
  }
  cuError.value = null
  try {
    await app.MysqlUpdateCell(cuPending)
    cuConfirmOpen.value = false
  } catch (e) {
    cuError.value = e instanceof Error ? e.message : String(e)
    return // 失败:弹窗保持打开,错误复用错误展示区显示
  }
  const target = idx === null ? undefined : results.value[idx]
  if (!target) return
  try {
    const fresh = await app.MysqlExecute({
      connection_id: props.connectionId,
      sql: target.sql,
      database: activeDb.value,
    })
    if (fresh.length > 0) {
      // 仅替换该索引的结果,其他语句结果保持不变。
      results.value = results.value.map((old, i) => (i === idx ? fresh[0] : old))
      // 刷新同样更新该语句的标记与结果 tab 状态(新耗时或错误)。
      const m = markedStatements.value.find((x) => x.text.trim() === target.sql.trim())
      if (m) {
        m.status = fresh[0].error ? 'fail' : 'ok'
        m.detail = fresh[0].error ?? `${fresh[0].duration_ms} ms`
      }
      const t = idx === null ? undefined : resultTabs.value[idx]
      if (t && idx !== null) resultTabs.value[idx] = { ...t, status: fresh[0].error ? 'fail' : 'ok' }
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function cancelCellUpdate(): void {
  pendingStmtIndex = null
  cuPending = null
  cuConfirmOpen.value = false
  cuStatement.value = ''
  cuMatchedRows.value = 0
  cuError.value = null
}

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
})

// composable 把 ref 嵌在普通对象里返回,模板不自动解包,这里统一取值。
const currentFile = computed(() => unref(qf.currentFile))
const nameDialogShow = computed(() => unref(qf.nameDialog.open))
const nameDialogMode = computed(() => unref(qf.nameDialog.mode))
const nameDialogTitle = computed(() => (nameDialogMode.value === 'save-as' ? '另存查询' : '保存查询'))
const overwriteShow = computed(() => unref(qf.overwriteConfirm.open))
const deleteConfirmShow = computed(() => unref(qf.deleteConfirm.open))
const deleteConfirmMessage = computed(() => unref(qf.deleteConfirm.message))

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

// ⌘S / Ctrl+S 保存;⌘Enter / Ctrl+Enter 执行当前语句;⌘Shift+Enter 运行全部
// (与 Kafka/CH SQL 控制台一致,忽略 IME 组合中的按键)。事件从 CodeMirror
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
  <div ref="rootRef" class="mysql-sql" data-test="mysql-sql-console">
    <div class="editor-pane">
      <div class="command-bar">
        <button class="btn primary" type="button" data-test="btn-mysql-run" :disabled="running || !sql.trim()" @click="runAll">
          {{ running ? '运行中…' : '运行全部' }}
        </button>
        <!-- 当前库选择器:执行与保存(文件头)统一使用该库;空值 = 连接默认库。 -->
        <label class="db-select" title="当前库:执行与保存的 SQL 都将使用该库">
          <span class="toolbar-hint">库</span>
          <select data-test="mysql-db-select" class="input" :value="activeDb" @change="onDbChange">
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
          data-test="mysql-sql-input"
          placeholder="SELECT * FROM users WHERE id = 1"
          @run-statement="onRunStatement"
          @run-selection="onRunSelection"
          @run-current="runCurrentStatement"
          @run-all="runAll"
          @cursor="onCursor"
        />
      </div>

      <!-- 运行错误与单元格更新失败(cuError)共用错误展示区;语句级错误由
           SqlResultCard 的错误卡渲染。 -->
      <div v-if="error || cuError" class="msg err" data-test="mysql-sql-error">{{ error || cuError }}</div>
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
          <div v-if="results.length === 0" class="empty" data-test="results-empty">⌘Enter 执行当前语句 · ⌘Shift+Enter 运行全部</div>
          <!-- 仅渲染 active tab 对应的结果卡;MySQL 结果可勾选行复制 INSERT。 -->
          <SqlResultCard
            v-else-if="activeCard"
            :key="activeResult"
            :statement="activeCard.sql"
            :duration-ms="activeCard.duration_ms"
            :columns="activeCard.columns ?? []"
            :rows="activeCard.rows ?? []"
            :insert-target="parseCHSingleTableSelect(activeCard.sql)"
            :export-name="`mysql-result-${activeResult}`"
            :error="activeCard.error ?? null"
            :editing="editingFor(activeResult)"
            selectable
            :primary-key="activeCard.primary_key ?? []"
            @cell-dblclick="(row, col) => startCellEdit(activeResult, row, col)"
            @edit-commit="(value) => commitCellEdit(activeResult, value ?? '')"
            @edit-cancel="cancelCellEdit"
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
    <!-- 单元格更新确认:展示将执行的 UPDATE 语句全文与匹配行数(多行置危险色)。 -->
    <ConfirmDialog
      :show="cuConfirmOpen"
      :message="cellUpdateMessage"
      confirm-text="执行"
      :danger="cuMatchedRows > 1"
      @confirm="confirmCellUpdate"
      @cancel="cancelCellUpdate"
    />
  </div>
</template>

<style scoped>
.mysql-sql {
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
