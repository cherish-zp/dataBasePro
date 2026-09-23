import { describe, expect, it } from 'vitest'
import { buildDocSkeleton } from './esDocSkeleton'

// buildDocSkeleton 按映射字段生成新增文档骨架:数值族 → 0(大小写不敏感
// 前缀匹配,覆盖 unsigned_long/half_float/scaled_float 与 *_range 衍生),
// boolean → false,object/空类型跳过,其余(keyword/text/date/...)→ null;
// 点路径生成嵌套对象,键序与传入一致,输出 2 空格缩进 JSON 文本。
describe('buildDocSkeleton', () => {
  it('数值族映射为 0,大小写不敏感且前缀命中衍生类型', () => {
    expect(
      buildDocSkeleton([
        { name: 'age', type: 'long' },
        { name: 'count', type: 'INTEGER' },
        { name: 'size', type: 'Byte' },
        { name: 'ratio', type: 'scaled_float' },
        { name: 'half', type: 'half_float' },
        { name: 'big', type: 'unsigned_long' },
        { name: 'span', type: 'integer_range' },
        { name: 'w', type: 'double' },
        { name: 'f', type: 'float' },
        { name: 's', type: 'short' },
      ]),
    ).toBe(
      JSON.stringify(
        { age: 0, count: 0, size: 0, ratio: 0, half: 0, big: 0, span: 0, w: 0, f: 0, s: 0 },
        null,
        2,
      ),
    )
  })

  it('boolean 映射为 false', () => {
    expect(buildDocSkeleton([{ name: 'active', type: 'boolean' }])).toBe(
      JSON.stringify({ active: false }, null, 2),
    )
  })

  it('keyword/text/date 等其余类型映射为 null', () => {
    expect(
      buildDocSkeleton([
        { name: 'name', type: 'keyword' },
        { name: 'desc', type: 'text' },
        { name: 'created', type: 'date' },
        { name: 'nano', type: 'date_nanos' },
        { name: 'ip', type: 'ip' },
      ]),
    ).toBe(
      JSON.stringify({ name: null, desc: null, created: null, nano: null, ip: null }, null, 2),
    )
  })

  it('object 类型字段跳过,不生成叶子', () => {
    expect(buildDocSkeleton([{ name: 'meta', type: 'object' }])).toBe('{}')
  })

  it('空类型(无叶子类型)字段跳过', () => {
    expect(
      buildDocSkeleton([
        { name: 'unknown', type: '' },
        { name: 'known', type: 'keyword' },
      ]),
    ).toBe(JSON.stringify({ known: null }, null, 2))
  })

  it('object 父字段跳过,但其点路径子字段仍生成嵌套对象', () => {
    expect(
      buildDocSkeleton([
        { name: 'meta', type: 'object' },
        { name: 'meta.created', type: 'date' },
      ]),
    ).toBe(JSON.stringify({ meta: { created: null } }, null, 2))
  })

  it('点路径生成嵌套对象,多级与兄弟键合并', () => {
    expect(
      buildDocSkeleton([
        { name: 'a.b.c', type: 'long' },
        { name: 'a.b.tag', type: 'keyword' },
        { name: 'a.flag', type: 'boolean' },
      ]),
    ).toBe(
      JSON.stringify({ a: { b: { c: 0, tag: null }, flag: false } }, null, 2),
    )
  })

  it('空字段列表返回空对象文本', () => {
    expect(buildDocSkeleton([])).toBe('{}')
  })

  it('输出键按传入顺序排列(不排序)', () => {
    expect(
      buildDocSkeleton([
        { name: 'zebra', type: 'keyword' },
        { name: 'alpha', type: 'long' },
        { name: 'mid.active', type: 'boolean' },
      ]),
    ).toBe('{\n  "zebra": null,\n  "alpha": 0,\n  "mid": {\n    "active": false\n  }\n}')
  })

  it('输出为 2 空格缩进的 JSON 文本', () => {
    expect(buildDocSkeleton([{ name: 'a', type: 'long' }])).toBe('{\n  "a": 0\n}')
    expect(buildDocSkeleton([{ name: 'a.b', type: 'long' }])).toBe(
      '{\n  "a": {\n    "b": 0\n  }\n}',
    )
  })
})
