import { describe, expect, it } from 'vitest'
import { renderJsonView } from './jsonview'

function texts(v: { tokens: { text: string; type: string }[] }, type: string): string[] {
  return v.tokens.filter((t) => t.type === type).map((t) => t.text)
}

describe('renderJsonView', () => {
  it('formats a flat object with 2-space indentation', () => {
    const v = renderJsonView('{"a":1,"b":"x"}')
    expect(v.ok).toBe(true)
    expect(v.text).toBe('{\n  "a": 1,\n  "b": "x"\n}')
  })

  it('formats nested arrays and objects', () => {
    const v = renderJsonView('{"a":[1,{"b":true}]}')
    expect(v.ok).toBe(true)
    expect(v.text).toBe('{\n  "a": [\n    1,\n    {\n      "b": true\n    }\n  ]\n}')
  })

  it('classifies keys, strings, numbers, booleans and null into distinct span types', () => {
    const v = renderJsonView('{"name":"tom","age":3,"ok":true,"n":null}')
    expect(v.ok).toBe(true)
    expect(texts(v, 'key')).toEqual(['"name"', '"age"', '"ok"', '"n"'])
    expect(texts(v, 'string')).toEqual(['"tom"'])
    expect(texts(v, 'number')).toEqual(['3'])
    expect(texts(v, 'boolean')).toEqual(['true'])
    expect(texts(v, 'null')).toEqual(['null'])
  })

  it('concatenated spans reproduce the pretty text exactly', () => {
    const v = renderJsonView('{"a":[1,{"b":true}],"c":"中文","d":-1.5e3}')
    expect(v.ok).toBe(true)
    expect(v.tokens.map((t) => t.text).join('')).toBe(v.text)
  })

  it('keeps Chinese keys and values intact', () => {
    const v = renderJsonView('{"名字":"值","msg":"你好，世界"}')
    expect(v.ok).toBe(true)
    expect(v.text).toContain('名字')
    expect(v.text).toContain('你好，世界')
    expect(texts(v, 'key')).toEqual(['"名字"', '"msg"'])
    expect(texts(v, 'string')).toEqual(['"值"', '"你好，世界"'])
  })

  it('handles escaped quotes inside strings without splitting the span', () => {
    const v = renderJsonView('{"a":"say \\"hi\\""}')
    expect(v.ok).toBe(true)
    expect(texts(v, 'string')).toEqual(['"say \\"hi\\""'])
  })

  it('returns the raw text unchanged for invalid JSON', () => {
    const v = renderJsonView('not json {')
    expect(v.ok).toBe(false)
    expect(v.text).toBe('not json {')
    expect(v.tokens).toEqual([{ text: 'not json {', type: 'plain' }])
  })

  it('treats scalar JSON as parseable', () => {
    expect(renderJsonView('42').ok).toBe(true)
    expect(renderJsonView('"hi"').ok).toBe(true)
    expect(renderJsonView('true').ok).toBe(true)
    expect(renderJsonView('null').ok).toBe(true)
  })
})
