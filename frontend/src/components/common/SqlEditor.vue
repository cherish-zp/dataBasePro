<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorState, Compartment, type Extension } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
  placeholder as cmPlaceholder,
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

export interface SqlTableSchema {
  name: string
  columns?: string[]
}

const props = withDefaults(
  defineProps<{
    modelValue: string
    tables?: SqlTableSchema[]
    placeholder?: string
    height?: string
  }>(),
  { height: '180px', tables: () => [], placeholder: undefined },
)

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

const host = ref<HTMLElement | null>(null)
let view: EditorView | null = null

// schema 与 placeholder 用独立 compartment,支持运行期热替换(如元数据异步加载完成)。
const sqlCompartment = new Compartment()
const placeholderCompartment = new Compartment()

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

const updateListener = EditorView.updateListener.of((update) => {
  if (update.docChanged) emit('update:modelValue', update.state.doc.toString())
})

onMounted(() => {
  if (!host.value) return
  const extensions: Extension[] = [
    lineNumbers(),
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

// 外部值变化(且与内部文档不同)→ 全文替换;相同则跳过,避免 v-model 回环与光标跳动。
watch(
  () => props.modelValue,
  (value) => {
    if (!view || value === view.state.doc.toString()) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
  },
)

onBeforeUnmount(() => {
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
  <div class="sql-editor" data-test="sql-editor">
    <div ref="host" class="editor-host" data-test="sql-editor-content" :style="{ height }"></div>
  </div>
</template>

<style scoped>
/* 边框/圆角/聚焦描边与现有 .input 风格保持一致 */
.sql-editor {
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
</style>
