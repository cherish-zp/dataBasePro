<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  EditorState,
  Compartment,
  Range,
  RangeSet,
  RangeValue,
  type Extension,
} from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
  gutter,
  GutterMarker,
  ViewPlugin,
  Decoration,
  placeholder as cmPlaceholder,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { sql } from '@codemirror/lang-sql'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import {
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
  HighlightStyle,
} from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { splitSqlStatements } from '@/utils/sqlSplit'

export interface SqlTableSchema {
  name: string
  columns?: string[]
}

// 语句执行状态标记:from 为语句起始 offset(与 splitSqlStatements 的 segment.from 对应),
// 内容变化后失配的标记会被忽略,由消费方重传。
export interface StatementMark {
  from: number
  status: 'ok' | 'fail' | 'running'
  detail?: string
}

// cursor 事件的 1 基行列。
export interface CursorPos {
  line: number
  col: number
}

const props = withDefaults(
  defineProps<{
    modelValue: string
    tables?: SqlTableSchema[]
    placeholder?: string
    height?: string
    /** 行号槽渲染每条语句首行的 ▶ 执行按钮(点击 emit run-statement)。 */
    statementGutter?: boolean
    /** 语句执行状态标记,渲染在语句首行行号旁(✓/✗/转圈,悬浮 detail)。 */
    statementMarks?: StatementMark[]
    /** 光标所在语句整段背景微高亮。 */
    highlightCursorStatement?: boolean
    /** 右键执行菜单(执行选中语句 / 执行当前语句 / 运行全部),默认关闭。 */
    enableRunMenu?: boolean
  }>(),
  {
    height: '180px',
    tables: () => [],
    placeholder: undefined,
    statementGutter: false,
    statementMarks: () => [],
    highlightCursorStatement: false,
    enableRunMenu: false,
  },
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'run-statement', text: string): void
  (e: 'cursor', pos: CursorPos): void
  /** 右键菜单「执行选中语句」:携带选中文本。 */
  (e: 'run-selection', text: string): void
  /** 右键菜单「执行当前语句」:定位由控制台按光标自行处理。 */
  (e: 'run-current'): void
  /** 右键菜单「运行全部」。 */
  (e: 'run-all'): void
}>()

const host = ref<HTMLElement | null>(null)
const rootEl = ref<HTMLElement | null>(null)
let view: EditorView | null = null

// schema / placeholder / 语句级扩展均用独立 compartment,支持运行期热替换。
const sqlCompartment = new Compartment()
const placeholderCompartment = new Compartment()
const runGutterCompartment = new Compartment()
const marksGutterCompartment = new Compartment()
const cursorDecoCompartment = new Compartment()

function schemaOf(tables: SqlTableSchema[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const table of tables ?? []) out[table.name] = table.columns ?? []
  return out
}

function sqlExtension(tables: SqlTableSchema[]): Extension {
  // upperCaseKeywords:键入 as/select 等自动转大写。
  return sql({ schema: schemaOf(tables), upperCaseKeywords: true })
}

// 主题色全部走 CSS 变量,自动跟随 [data-theme] 深浅色切换。
const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'transparent' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.5', overflow: 'auto' },
  '.cm-content': { padding: '8px 10px 10px 0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--text-tertiary)' },
  '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg-hover)', color: 'var(--text-secondary)' },
  '.cm-placeholder': { color: 'var(--text-tertiary)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    boxShadow: 'var(--shadow-md)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--accent-soft)',
    color: 'var(--accent)',
  },
  // —— 语句 ▶ 运行按钮(绿色三角)——
  '.cm-run-statement': {
    color: 'var(--ok)',
    cursor: 'pointer',
    fontSize: '10px',
    lineHeight: '19px',
    background: 'none',
    border: 'none',
    padding: '0 4px',
    opacity: '0.75',
  },
  '.cm-run-statement:hover': { opacity: '1' },
  // —— 语句执行状态标记(行号旁 ✓/✗/⟳)——
  '.cm-statement-gutter .cm-gutterElement, .cm-marks-gutter .cm-gutterElement': {
    padding: '0 2px',
  },
  '.cm-statement-mark': { fontSize: '11px', padding: '0 2px', display: 'inline-block' },
  '.cm-statement-mark-ok': { color: 'var(--ok)' },
  '.cm-statement-mark-fail': { color: 'var(--danger)' },
  '.cm-statement-mark-running': {
    color: 'var(--info)',
    animation: 'cm-mark-spin 0.9s linear infinite',
  },
  // —— 光标所在语句微高亮 ——
  '.cm-current-statement': { backgroundColor: 'var(--accent-soft)' },
})

// 语法高亮复用现有 --json-* / --text-* 变量,深浅色主题均已定义。
const sqlHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--json-boolean)' },
  { tag: t.string, color: 'var(--json-string)' },
  { tag: t.number, color: 'var(--json-number)' },
  { tag: t.comment, color: 'var(--text-tertiary)', fontStyle: 'italic' },
  { tag: [t.operator, t.punctuation, t.separator], color: 'var(--text-secondary)' },
  { tag: t.typeName, color: 'var(--json-key)' },
])

// —— gutter markers:▶ 运行按钮 ——

class RunStatementMarker extends GutterMarker {
  text: string
  constructor(text: string) {
    super()
    this.text = text
  }
  eq(other: RangeValue): boolean {
    return other instanceof RunStatementMarker && other.text === this.text
  }
  toDOM(): HTMLElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'cm-run-statement'
    btn.title = '执行该语句'
    btn.textContent = '▶'
    // mousedown 并 preventDefault:避免点击时编辑器失焦/选区丢失。
    btn.addEventListener('mousedown', (ev) => {
      ev.preventDefault()
      emit('run-statement', this.text)
    })
    return btn
  }
}

// ▶ 槽:每条语句首行一个按钮(渲染在行号左侧)。
function runGutterExtension(): Extension {
  return gutter({
    class: 'cm-statement-gutter',
    markers(view) {
      const doc = view.state.doc
      const ranges: Range<GutterMarker>[] = []
      for (const seg of splitSqlStatements(doc.toString())) {
        const lineFrom = doc.lineAt(seg.from).from
        ranges.push(new RunStatementMarker(seg.text).range(lineFrom))
      }
      return ranges.length ? RangeSet.of(ranges, true) : RangeSet.empty
    },
  })
}

// —— gutter markers:语句执行状态 ——

class StatementStatusMarker extends GutterMarker {
  status: StatementMark['status']
  detail: string | undefined
  constructor(mark: StatementMark) {
    super()
    this.status = mark.status
    this.detail = mark.detail
  }
  eq(other: RangeValue): boolean {
    return (
      other instanceof StatementStatusMarker &&
      other.status === this.status &&
      other.detail === this.detail
    )
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = `cm-statement-mark cm-statement-mark-${this.status}`
    if (this.detail) el.title = this.detail
    el.textContent = this.status === 'ok' ? '✓' : this.status === 'fail' ? '✗' : '⟳'
    return el
  }
}

// 状态槽:statementMarks 的 from 映射到语句首行(行号右侧);映射不到的忽略
// (内容变化后由消费方重传)。同一行多条语句时,后到的标记覆盖先前的。
function marksGutterExtension(marks: StatementMark[]): Extension {
  return gutter({
    class: 'cm-marks-gutter',
    markers(view) {
      const doc = view.state.doc
      const segByFrom = new Map(splitSqlStatements(doc.toString()).map((seg) => [seg.from, seg]))
      const markByLine = new Map<number, StatementMark>()
      for (const mark of marks) {
        const seg = segByFrom.get(mark.from)
        if (!seg) continue
        markByLine.set(doc.lineAt(seg.from).from, mark)
      }
      const ranges: Range<GutterMarker>[] = [...markByLine].map(([lineFrom, mark]) =>
        new StatementStatusMarker(mark).range(lineFrom),
      )
      return ranges.length ? RangeSet.of(ranges, true) : RangeSet.empty
    },
  })
}

// —— 光标所在语句微高亮 ——

function buildCursorDeco(view: EditorView): DecorationSet {
  const pos = view.state.selection.main.head
  const seg = splitSqlStatements(view.state.doc.toString()).find(
    (s) => s.from <= pos && pos <= s.to,
  )
  if (!seg) return Decoration.none
  return Decoration.set([
    Decoration.mark({ class: 'cm-current-statement' }).range(seg.from, seg.to),
  ])
}

const cursorStatementPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildCursorDeco(view)
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet) {
        this.decorations = buildCursorDeco(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations },
)

// —— 更新监听:v-model 回写 + cursor 事件 ——

const updateListener = EditorView.updateListener.of((update) => {
  if (update.docChanged) emit('update:modelValue', update.state.doc.toString())
  if (update.docChanged || update.selectionSet) {
    const head = update.state.selection.main.head
    const line = update.state.doc.lineAt(head)
    emit('cursor', { line: line.number, col: head - line.from + 1 })
  }
})

// —— 右键执行菜单(enableRunMenu)——

const menuEl = ref<HTMLElement | null>(null)
const menuVisible = ref(false)
// 菜单锚点:相对组件根元素的偏移(absolute 定位)。
const menuPos = ref({ x: 0, y: 0 })
const menuHasSelection = ref(false)
// 打开菜单瞬间捕获的选中文本(emit 用,无需响应式)。
let menuSelectionText = ''

function onContentContextmenu(ev: MouseEvent): void {
  if (!props.enableRunMenu) return
  ev.preventDefault()
  const sel = getSelection()
  menuSelectionText = sel
  menuHasSelection.value = sel.length > 0
  const rect = rootEl.value?.getBoundingClientRect()
  menuPos.value = { x: ev.clientX - (rect?.left ?? 0), y: ev.clientY - (rect?.top ?? 0) }
  menuVisible.value = true
}

function closeRunMenu(): void {
  menuVisible.value = false
}

function onRunSelection(): void {
  closeRunMenu()
  emit('run-selection', menuSelectionText)
}

function onRunCurrent(): void {
  closeRunMenu()
  emit('run-current')
}

function onRunAll(): void {
  closeRunMenu()
  emit('run-all')
}

// 点击菜单外关闭;菜单内部 mousedown 不关(mousedown 先于 click,提前关会吞掉菜单项点击)。
function onDocMouseDown(ev: MouseEvent): void {
  if (!menuVisible.value) return
  if (menuEl.value && ev.target instanceof Node && menuEl.value.contains(ev.target)) return
  closeRunMenu()
}

function onDocKeydown(ev: KeyboardEvent): void {
  if (menuVisible.value && ev.key === 'Escape') closeRunMenu()
}

onMounted(() => {
  if (!host.value) return
  const extensions: Extension[] = [
    runGutterCompartment.of(props.statementGutter ? runGutterExtension() : []),
    lineNumbers(),
    marksGutterCompartment.of(
      props.statementMarks.length ? marksGutterExtension(props.statementMarks) : [],
    ),
    cursorDecoCompartment.of(props.highlightCursorStatement ? cursorStatementPlugin : []),
    drawSelection(),
    history(),
    indentOnInput(),
    bracketMatching(),
    autocompletion(),
    closeBrackets(),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap]),
    sqlCompartment.of(sqlExtension(props.tables)),
    placeholderCompartment.of(props.placeholder ? cmPlaceholder(props.placeholder) : []),
    editorTheme,
    syntaxHighlighting(sqlHighlightStyle),
    updateListener,
  ]
  view = new EditorView({
    state: EditorState.create({ doc: props.modelValue, extensions }),
    parent: host.value,
  })
  // 右键执行菜单:拦截 contentDOM 的 contextmenu(enableRunMenu 关闭时不拦截,行为不变)。
  view.contentDOM.addEventListener('contextmenu', onContentContextmenu)
  document.addEventListener('mousedown', onDocMouseDown)
  document.addEventListener('keydown', onDocKeydown)
})

// tables 变化(如异步加载完元数据)→ 热替换 sql schema。
watch(
  () => props.tables,
  (tables) => {
    view?.dispatch({ effects: sqlCompartment.reconfigure(sqlExtension(tables)) })
  },
  { deep: true },
)

watch(
  () => props.placeholder,
  (p) => {
    view?.dispatch({ effects: placeholderCompartment.reconfigure(p ? cmPlaceholder(p) : []) })
  },
)

// 语句级 props 变化 → 重配三组扩展(▶ 槽 / 状态槽 / 光标高亮)。
watch(
  () => [props.statementGutter, props.statementMarks, props.highlightCursorStatement] as const,
  () => {
    view?.dispatch({
      effects: [
        runGutterCompartment.reconfigure(props.statementGutter ? runGutterExtension() : []),
        marksGutterCompartment.reconfigure(
          props.statementMarks.length ? marksGutterExtension(props.statementMarks) : [],
        ),
        cursorDecoCompartment.reconfigure(
          props.highlightCursorStatement ? cursorStatementPlugin : [],
        ),
      ],
    })
  },
  { deep: true },
)

// 外部值变化(且与内部文档不同)→ 全文替换;相同则跳过,避免 v-model 回环与光标跳动。
watch(
  () => props.modelValue,
  (value) => {
    if (!view || value === view.state.doc.toString()) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
  },
)

// 运行期关闭右键菜单 → 顺带收起已打开的菜单。
watch(
  () => props.enableRunMenu,
  (on) => {
    if (!on) closeRunMenu()
  },
)

onBeforeUnmount(() => {
  view?.contentDOM.removeEventListener('contextmenu', onContentContextmenu)
  document.removeEventListener('mousedown', onDocMouseDown)
  document.removeEventListener('keydown', onDocKeydown)
  view?.destroy()
  view = null
})

function focus(): void {
  view?.focus()
}

function getValue(): string {
  return view?.state.doc.toString() ?? props.modelValue
}

// 主光标选中的文本;无选区(光标)返回空串。供控制台「选中运行」读取选区。
function getSelection(): string {
  if (!view) return ''
  const range = view.state.selection.main
  return range.empty ? '' : view.state.sliceDoc(range.from, range.to)
}

defineExpose({ focus, getValue, getSelection })
</script>

<template>
  <div ref="rootEl" class="sql-editor" data-test="sql-editor">
    <div ref="host" class="editor-host" data-test="sql-editor-content" :style="{ height }"></div>
    <div
      v-if="menuVisible"
      ref="menuEl"
      class="run-menu"
      data-test="editor-run-menu"
      :style="{ left: `${menuPos.x}px`, top: `${menuPos.y}px` }"
      @contextmenu.prevent
    >
      <button
        v-if="menuHasSelection"
        type="button"
        class="run-menu-item"
        data-test="menu-run-selection"
        @click="onRunSelection"
      >
        执行选中语句
      </button>
      <button
        type="button"
        class="run-menu-item"
        data-test="menu-run-current"
        title="⌘Enter"
        @click="onRunCurrent"
      >
        执行当前语句
      </button>
      <button
        type="button"
        class="run-menu-item"
        data-test="menu-run-all"
        title="⌘⇧Enter"
        @click="onRunAll"
      >
        运行全部
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 边框/圆角/聚焦描边与现有 .input 风格保持一致;relative 供右键菜单 absolute 锚定 */
.sql-editor {
  position: relative;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-subtle);
  overflow: hidden;
  transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}
.sql-editor:focus-within {
  outline: none;
  border-color: var(--accent);
  background: var(--bg-elevated);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.editor-host :deep(.cm-editor) { height: 100%; }
/* 右键执行菜单:自绘,主题变量跟随深浅色 */
.run-menu {
  position: absolute;
  z-index: 30;
  min-width: 148px;
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow-md);
}
.run-menu-item {
  text-align: left;
  background: none;
  border: none;
  color: var(--text);
  font-size: 13px;
  font-family: var(--font);
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s ease;
}
.run-menu-item:hover { background: var(--bg-hover); }
.run-menu-item:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--accent); }
</style>

<style>
/* running 状态标记的旋转动画(@keyframes 无法放进 EditorView.theme) */
@keyframes cm-mark-spin {
  to { transform: rotate(360deg); }
}
</style>
