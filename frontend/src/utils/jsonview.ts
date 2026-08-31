// jsonview renders a JSON-ish text as a pretty-printed, span-classified view
// used by the message detail drawer. Pure functions only — highlighting is a
// rendering concern handled by the component via token type CSS classes.
import { prettyJSON } from './format'

export type JsonTokenType = 'key' | 'string' | 'number' | 'boolean' | 'null' | 'plain'

export interface JsonToken {
  text: string
  type: JsonTokenType
}

export interface JsonView {
  // ok is true when the input parsed as JSON; text is then the 2-space
  // pretty-printed form and tokens cover it. On failure text is the raw
  // input unchanged and tokens holds a single plain span.
  ok: boolean
  text: string
  tokens: JsonToken[]
}

// Token matcher over pretty-printed JSON output. Strings are matched first so
// that braces/colons inside them never leak into structural parsing; a value
// string in pretty output is never followed by ':', so the optional group
// reliably distinguishes keys from string values.
const TOKEN_SOURCE =
  '("(?:[^"\\\\]|\\\\.)*")(\\s*:)?|(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)|(true|false)|(null)'

function tokenize(pretty: string): JsonToken[] {
  const tokens: JsonToken[] = []
  const re = new RegExp(TOKEN_SOURCE, 'g')
  let last = 0
  for (let m = re.exec(pretty); m !== null; m = re.exec(pretty)) {
    if (m.index > last) tokens.push({ text: pretty.slice(last, m.index), type: 'plain' })
    if (m[1] !== undefined) {
      if (m[2] !== undefined) {
        tokens.push({ text: m[1], type: 'key' })
        tokens.push({ text: m[2], type: 'plain' })
      } else {
        tokens.push({ text: m[1], type: 'string' })
      }
    } else if (m[3] !== undefined) {
      tokens.push({ text: m[3], type: 'number' })
    } else if (m[4] !== undefined) {
      tokens.push({ text: m[4], type: 'boolean' })
    } else if (m[5] !== undefined) {
      tokens.push({ text: m[5], type: 'null' })
    }
    last = m.index + m[0].length
  }
  if (last < pretty.length) tokens.push({ text: pretty.slice(last), type: 'plain' })
  return tokens
}

export function renderJsonView(input: string): JsonView {
  try {
    JSON.parse(input)
  } catch {
    return { ok: false, text: input, tokens: [{ text: input, type: 'plain' }] }
  }
  // Delegate the pretty-print step to prettyJSON so both JSON renderers share
  // one formatting implementation. The input already parsed above, so the
  // parse inside prettyJSON cannot fail here and it returns the same 2-space
  // form the drawer previously computed inline (behavior unchanged).
  const pretty = prettyJSON(input)
  return { ok: true, text: pretty, tokens: tokenize(pretty) }
}
