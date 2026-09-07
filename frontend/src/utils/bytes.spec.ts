import { describe, expect, it } from 'vitest'
import { formatBytes } from './bytes'

describe('formatBytes', () => {
  it('renders small values verbatim', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(999)).toBe('999 B')
  })
  it('abbreviates KB/MB/GB with one decimal, trailing zeros dropped', () => {
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(15360)).toBe('15 KB')
    expect(formatBytes(1048576)).toBe('1 MB')
    expect(formatBytes(1610612736)).toBe('1.5 GB')
  })
  it('clamps negatives to zero', () => {
    // MEMORY USAGE 不会返回负数;负值视为异常输入归零。
    expect(formatBytes(-5)).toBe('0 B')
  })
})
