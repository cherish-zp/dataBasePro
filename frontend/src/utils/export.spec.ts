import { beforeAll, afterAll, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { Message } from '@/api/types'
import { CSV_MIME, JSONL_MIME, MESSAGE_EXPORT_COLUMNS, downloadFile, exportCsv, exportJsonl } from './export'

interface Row {
  name: string
  note: string
}

const cols = [
  { label: 'Name', value: (r: Row) => r.name },
  { label: 'Note', value: (r: Row) => r.note },
]

describe('exportCsv', () => {
  it('builds a BOM-prefixed table with a header row', () => {
    const rows: Row[] = [{ name: 'a', note: 'b' }]
    expect(exportCsv(rows, cols)).toBe('\uFEFFName,Note\na,b')
  })

  it('joins multiple rows with newlines and no trailing newline', () => {
    const rows: Row[] = [
      { name: 'a', note: 'b' },
      { name: 'c', note: 'd' },
    ]
    expect(exportCsv(rows, cols)).toBe('\uFEFFName,Note\na,b\nc,d')
  })

  it('quotes fields containing commas', () => {
    const rows: Row[] = [{ name: 'a,b', note: 'x' }]
    expect(exportCsv(rows, cols)).toBe('\uFEFFName,Note\n"a,b",x')
  })

  it('escapes double quotes by doubling them', () => {
    const rows: Row[] = [{ name: 'say "hi"', note: 'x' }]
    expect(exportCsv(rows, cols)).toBe('\uFEFFName,Note\n"say ""hi""",x')
  })

  it('quotes fields containing newlines and carriage returns', () => {
    const rows: Row[] = [
      { name: 'a\nb', note: 'c\rd' },
    ]
    expect(exportCsv(rows, cols)).toBe('\uFEFFName,Note\n"a\nb","c\rd"')
  })

  it('escapes header labels too', () => {
    const tricky = [
      { label: 'a,b', value: (r: Row) => r.name },
      { label: 'say "x"', value: (r: Row) => r.note },
    ]
    expect(exportCsv([], tricky)).toBe('\uFEFF"a,b","say ""x"""')
  })

  it('keeps Chinese text intact behind the BOM without extra quoting', () => {
    const rows: Row[] = [{ name: '中文键', note: '你好，世界' }]
    const out = exportCsv(rows, cols)
    expect(out.startsWith('\uFEFF')).toBe(true)
    expect(out).toContain('中文键')
    expect(out).toContain('你好，世界')
  })

  it('renders only the header for empty rows', () => {
    expect(exportCsv([], cols)).toBe('\uFEFFName,Note')
  })
})

describe('exportJsonl', () => {
  it('writes one JSON object per line', () => {
    const rows = [
      { a: 1, b: 'x' },
      { a: 2, b: 'y' },
    ]
    expect(exportJsonl(rows)).toBe('{"a":1,"b":"x"}\n{"a":2,"b":"y"}')
  })

  it('returns an empty string for empty rows', () => {
    expect(exportJsonl([])).toBe('')
  })

  it('keeps Chinese text as-is and escapes control chars via JSON', () => {
    const rows = [{ k: '中文', v: 'line1\nline2' }]
    expect(exportJsonl(rows)).toBe('{"k":"中文","v":"line1\\nline2"}')
  })
})

describe('MESSAGE_EXPORT_COLUMNS', () => {
  it('exposes the five message table headers', () => {
    expect(MESSAGE_EXPORT_COLUMNS.map((c) => c.label)).toEqual([
      'Partition',
      'Offset',
      'Timestamp',
      'Key',
      'Value',
    ])
  })

  it('maps message fields to string cells', () => {
    const m: Message = { partition: 1, offset: 42, timestamp: 1700000000000, key: 'k', value: 'v', headers: [] }
    expect(MESSAGE_EXPORT_COLUMNS.map((c) => c.value(m))).toEqual([
      '1',
      '42',
      new Date(1700000000000).toISOString(),
      'k',
      'v',
    ])
  })

  it('exports a zero timestamp and missing key/value as empty cells', () => {
    const m: Message = { partition: 0, offset: 0, timestamp: 0, key: '', value: '', headers: [] }
    expect(MESSAGE_EXPORT_COLUMNS.map((c) => c.value(m))).toEqual(['0', '0', '', '', ''])
  })
})

describe('downloadFile', () => {
  const createObjectURL = vi.fn((_obj: Blob | MediaSource) => 'blob:mock')
  const revokeObjectURL = vi.fn()
  const realCreateElement = document.createElement.bind(document)
  let clickSpy: MockInstance
  let createElementSpy: MockInstance

  beforeAll(() => {
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    createElementSpy = vi.spyOn(document, 'createElement').mockImplementation(realCreateElement)
  })

  afterAll(() => {
    clickSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('saves CSV content under <name>.csv via a temporary object URL', async () => {
    downloadFile('query-results', 'a,b', CSV_MIME)
    const anchor = findAnchor()
    expect(anchor.download).toBe('query-results.csv')
    expect(anchor.getAttribute('href')).toBe('blob:mock')
    const blob = createObjectURL.mock.calls[0][0] as Blob
    expect(blob.type).toBe(CSV_MIME)
    expect(await blobText(blob)).toBe('a,b')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock')
  })

  it('saves JSONL content under <name>.jsonl', () => {
    downloadFile('messages-orders', '{"a":1}', JSONL_MIME)
    expect(findAnchor().download).toBe('messages-orders.jsonl')
  })

  it('detaches the anchor after triggering the click', () => {
    downloadFile('x', 'y', CSV_MIME)
    const anchor = findAnchor()
    expect(clickSpy).toHaveBeenCalled()
    expect(anchor.isConnected).toBe(false)
  })

  // findAnchor returns the anchor element created by the last downloadFile
  // call (spied createElement passes through to the real implementation).
  function findAnchor(): HTMLAnchorElement {
    const anchors = createElementSpy.mock.results
      .map((r) => r.value)
      .filter((el): el is HTMLAnchorElement => el instanceof HTMLAnchorElement)
    expect(anchors.length).toBeGreaterThan(0)
    return anchors[anchors.length - 1]
  }

  // blobText reads a Blob as UTF-8 text; jsdom's Blob lacks .text().
  function blobText(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result))
      fr.onerror = () => reject(fr.error)
      fr.readAsText(blob)
    })
  }
})
