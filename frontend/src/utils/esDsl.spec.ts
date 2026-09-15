import { describe, expect, it } from 'vitest'
import { EsDslParseError, parseEsDslRequests, prettyJson } from './esDsl'

describe('parseEsDslRequests 基础解析', () => {
  it('单请求无 body:method/path 解析正确,startLine 指向 method 行', () => {
    expect(parseEsDslRequests('GET /_cat/indices')).toEqual([
      { method: 'GET', path: '/_cat/indices', body: '', startLine: 1 },
    ])
  })

  it('单请求带 body:body 原样保留(含换行与缩进),不做语法校验', () => {
    const text = 'POST /idx/_search\n{\n  "query": {\n    "match_all": {}\n  }\n}'
    expect(parseEsDslRequests(text)).toEqual([
      { method: 'POST', path: '/idx/_search', body: '{\n  "query": {\n    "match_all": {}\n  }\n}', startLine: 1 },
    ])
  })

  it('多请求以空行分隔:startLine 逐块递增', () => {
    const text = ['GET /_cat/indices', '', 'PUT /idx', '{', '  "settings": {}', '}', '', 'DELETE /idx'].join('\n')
    expect(parseEsDslRequests(text)).toEqual([
      { method: 'GET', path: '/_cat/indices', body: '', startLine: 1 },
      { method: 'PUT', path: '/idx', body: '{\n  "settings": {}\n}', startLine: 3 },
      { method: 'DELETE', path: '/idx', body: '', startLine: 8 },
    ])
  })

  it('空行可连续多个,首尾空白行不影响解析', () => {
    const text = '\n\nGET /a\n\n\n\nPOST /b\n{"x":1}\n\n'
    expect(parseEsDslRequests(text)).toEqual([
      { method: 'GET', path: '/a', body: '', startLine: 3 },
      { method: 'POST', path: '/b', body: '{"x":1}', startLine: 7 },
    ])
  })

  it('空白字符(空格/制表符)组成的行视为空行分隔符', () => {
    const text = 'GET /a\n  \t\nPOST /b'
    expect(parseEsDslRequests(text)).toEqual([
      { method: 'GET', path: '/a', body: '', startLine: 1 },
      { method: 'POST', path: '/b', body: '', startLine: 3 },
    ])
  })
})

describe('parseEsDslRequests 注释与归一化', () => {
  it('块前注释行跳过:startLine 指向 method 行而非注释', () => {
    const text = '# 拉取全部索引\n// 另一种注释\nGET /_cat/indices'
    expect(parseEsDslRequests(text)).toEqual([
      { method: 'GET', path: '/_cat/indices', body: '', startLine: 3 },
    ])
  })

  it('body 内夹注释行:注释不计入 body,其余行原样保留', () => {
    const text = 'POST /a/_search\n{"x":1}\n# 只查一条\n{"size":1}'
    expect(parseEsDslRequests(text)).toEqual([
      { method: 'POST', path: '/a/_search', body: '{"x":1}\n{"size":1}', startLine: 1 },
    ])
  })

  it('纯注释/空白文本不产出请求,也不报错', () => {
    expect(parseEsDslRequests('# 只有注释\n// 还是一样\n\n')).toEqual([])
    expect(parseEsDslRequests('')).toEqual([])
    expect(parseEsDslRequests('   \n\t\n')).toEqual([])
  })

  it('VERB 大小写不敏感,统一归一为大写', () => {
    const text = 'get /a\n\nDelete /b\n\nHeAd /c\n\npost /d\n\nput /e'
    const reqs = parseEsDslRequests(text)
    expect(reqs.map((r) => r.method)).toEqual(['GET', 'DELETE', 'HEAD', 'POST', 'PUT'])
  })

  it('path 原样保留,允许带 query string', () => {
    expect(parseEsDslRequests('GET /idx/_search?size=1&q=k:v')).toEqual([
      { method: 'GET', path: '/idx/_search?size=1&q=k:v', body: '', startLine: 1 },
    ])
  })

  it('method 行容忍尾部空白,CRLF 行尾按 LF 处理', () => {
    expect(parseEsDslRequests('GET /a  \r\n\r\nPOST /b\r\n')).toEqual([
      { method: 'GET', path: '/a', body: '', startLine: 1 },
      { method: 'POST', path: '/b', body: '', startLine: 3 },
    ])
  })
})

describe('parseEsDslRequests 报错(带行号与块原文)', () => {
  it('块首行是 JSON(缺 method)→ 抛错,行号指向该行,block 为原始文本段', () => {
    const text = 'GET /ok\n\n{"no":"verb"}'
    try {
      parseEsDslRequests(text)
      expect.unreachable('应当抛出 EsDslParseError')
    } catch (e) {
      expect(e).toBeInstanceOf(EsDslParseError)
      const err = e as EsDslParseError
      expect(err.line).toBe(3)
      expect(err.block).toBe('{"no":"verb"}')
      expect(err.message).toContain('3')
    }
  })

  it('缺 path(只有 VERB)→ 抛错', () => {
    expect(() => parseEsDslRequests('GET')).toThrow(EsDslParseError)
    expect(() => parseEsDslRequests('GET ')).toThrow(EsDslParseError)
  })

  it('path 不以 / 开头 → 抛错', () => {
    try {
      parseEsDslRequests('GET _cat/indices')
      expect.unreachable('应当抛出 EsDslParseError')
    } catch (e) {
      expect(e).toBeInstanceOf(EsDslParseError)
      expect((e as EsDslParseError).line).toBe(1)
    }
  })

  it('不支持的 VERB → 抛错', () => {
    expect(() => parseEsDslRequests('FETCH /a')).toThrow(EsDslParseError)
    expect(() => parseEsDslRequests('getx /a')).toThrow(EsDslParseError)
  })

  it('报错定位到当前块(整体抛错,由控制台转错误卡)', () => {
    const text = 'GET /ok\n\nPOST /bad\n\nmethod 行缺失的块'
    try {
      parseEsDslRequests(text)
      expect.unreachable('应当抛出 EsDslParseError')
    } catch (e) {
      expect((e as EsDslParseError).line).toBe(5)
      expect((e as EsDslParseError).block).toBe('method 行缺失的块')
    }
  })
})

describe('prettyJson', () => {
  it('合法 JSON 缩进为 2 空格', () => {
    expect(prettyJson('{"a":1,"b":[1,2]}')).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}')
  })

  it('非法 JSON 原样返回', () => {
    expect(prettyJson('not json {')).toBe('not json {')
  })

  it('空串原样返回', () => {
    expect(prettyJson('')).toBe('')
  })
})
