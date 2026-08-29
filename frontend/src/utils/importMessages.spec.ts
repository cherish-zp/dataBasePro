import { describe, expect, it } from 'vitest'
import { COUNT_MAX } from './batchProduce'
import { parseImportFile } from './importMessages'

describe('parseImportFile', () => {
  describe('JSON array', () => {
    it('maps string elements to value-only messages', () => {
      expect(parseImportFile('["a","b","c"]', 'data.json')).toEqual([
        { key: '', value: 'a' },
        { key: '', value: 'b' },
        { key: '', value: 'c' },
      ])
    })

    it('stringifies objects and ignores partition/timestamp fields', () => {
      expect(parseImportFile('[{"value":"a","partition":1,"timestamp":123},{"x":1}]', 'data.json')).toEqual([
        { key: '', value: '{"value":"a"}' },
        { key: '', value: '{"x":1}' },
      ])
    })

    it('throws for an empty JSON array', () => {
      expect(() => parseImportFile('[]', 'data.json')).toThrow('文件为空或无有效消息')
    })

    it('caps oversized arrays at COUNT_MAX', () => {
      const big = JSON.stringify(Array.from({ length: COUNT_MAX + 5 }, (_, i) => `m-${i}`))
      expect(parseImportFile(big, 'data.json')).toHaveLength(COUNT_MAX)
    })
  })

  describe('JSONL / NDJSON', () => {
    it('maps each line to one message and ignores partition/timestamp', () => {
      const text = ['{"name":"a","partition":1}', '"plain"', '{"n":2}', ''].join('\n')
      expect(parseImportFile(text, 'data.jsonl')).toEqual([
        { key: '', value: '{"name":"a"}' },
        { key: '', value: 'plain' },
        { key: '', value: '{"n":2}' },
      ])
    })

    it('accepts a single JSON object as one message', () => {
      expect(parseImportFile('{"k":"v"}', 'data.txt')).toEqual([{ key: '', value: '{"k":"v"}' }])
    })

    it('throws with the line number on the first bad line', () => {
      expect(() => parseImportFile('{"ok":1}\nnot json\n{"n":3}', 'data.jsonl')).toThrow('第 2 行 JSON 解析失败')
    })
  })

  describe('CSV', () => {
    it('maps key,value header rows and unquotes comma-in-quotes', () => {
      const text = 'key,value\nk1,v1\nk2,"v,2"'
      expect(parseImportFile(text, 'data.csv')).toEqual([
        { key: 'k1', value: 'v1' },
        { key: 'k2', value: 'v,2' },
      ])
    })

    it('defaults key to empty when only a value column exists', () => {
      const text = 'name,value\na,1\nb,2'
      expect(parseImportFile(text, 'data.csv')).toEqual([
        { key: '', value: '1' },
        { key: '', value: '2' },
      ])
    })

    it('treats a single column CSV as value-only messages', () => {
      const text = 'payload\nalice\nbob'
      expect(parseImportFile(text, 'data.csv')).toEqual([
        { key: '', value: 'alice' },
        { key: '', value: 'bob' },
      ])
    })

    it('rejects a CSV without a value column', () => {
      expect(() => parseImportFile('name,age\na,1', 'data.csv')).toThrow('CSV 缺少 value 列')
    })
  })

  describe('limits and errors', () => {
    it('throws for files larger than 2MB', () => {
      expect(() => parseImportFile('x'.repeat(2_000_001), 'data.jsonl')).toThrow('文件过大（>2MB），请分批导入')
    })

    it('throws for empty input', () => {
      expect(() => parseImportFile('', 'data.csv')).toThrow('文件为空或无有效消息')
      expect(() => parseImportFile('   \n\n', 'data.jsonl')).toThrow('文件为空或无有效消息')
    })
  })
})
