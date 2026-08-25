export function prettyJSON(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2)
  } catch {
    return input
  }
}

export function formatTime(ms: number): string {
  if (!ms) return '-'
  return new Date(ms).toLocaleString()
}

export function displayValue(v: string | undefined | null): string {
  if (v == null || v === '') return '(empty)'
  return v
}

// decodeBytes renders a raw byte buffer (base64/string) for display purposes.
export function bytesToString(v: string | undefined | null): string {
  return displayValue(v)
}
