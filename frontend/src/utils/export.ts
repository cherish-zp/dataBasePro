// Client-side export helpers: pure CSV/JSONL string builders plus one DOM
// trigger. Builders are framework-free so they can be fully unit tested; only
// downloadFile touches the document.
import type { Message } from '@/api/types'

// ExportColumn describes one CSV column: its header label and how to read the
// cell value out of a row. Generic so callers keep their row types.
export interface ExportColumn<T> {
  label: string
  value: (row: T) => string
}

export const CSV_MIME = 'text/csv'
export const JSONL_MIME = 'application/x-ndjson'

// EXT_BY_MIME maps the supported download mimes to file extensions; unknown
// mimes fall back to .txt.
const EXT_BY_MIME: Record<string, string> = {
  [CSV_MIME]: 'csv',
  [JSONL_MIME]: 'jsonl',
}

// csvField quotes a field when it contains a comma, double quote, newline or
// carriage return, doubling embedded quotes (RFC 4180).
function csvField(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

// exportCsv renders rows as CSV per RFC 4180 quoting with LF row separators,
// prefixed with a UTF-8 BOM so Excel detects the encoding and keeps Chinese
// readable. The header row is always emitted; empty rows yield just the BOM
// plus header.
export function exportCsv<T>(rows: readonly T[], cols: readonly ExportColumn<T>[]): string {
  const lines = [cols.map((c) => csvField(c.label)).join(',')]
  for (const row of rows) {
    lines.push(cols.map((c) => csvField(c.value(row))).join(','))
  }
  return `\uFEFF${lines.join('\n')}`
}

// exportJsonl renders rows as newline-delimited JSON with no trailing
// newline; empty rows yield an empty string.
export function exportJsonl<T>(rows: readonly T[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n')
}

// downloadFile saves content as <filename>.<ext>, deriving the extension from
// the mime type. The anchor is attached to the document before the click and
// removed afterwards — WKWebView only honours a[download] for attached
// anchors.
export function downloadFile(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${filename}.${EXT_BY_MIME[mime] ?? 'txt'}`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// MESSAGE_EXPORT_COLUMNS is the column set shared by the message browse table
// and the SQL result grid. Timestamps export as ISO 8601 (deterministic and
// machine-readable) and empty key/value stay empty cells rather than the
// '(empty)' display placeholder.
export const MESSAGE_EXPORT_COLUMNS: ExportColumn<Message>[] = [
  { label: 'Partition', value: (m) => String(m.partition) },
  { label: 'Offset', value: (m) => String(m.offset) },
  { label: 'Timestamp', value: (m) => (m.timestamp ? new Date(m.timestamp).toISOString() : '') },
  { label: 'Key', value: (m) => m.key ?? '' },
  { label: 'Value', value: (m) => m.value ?? '' },
]
