// Shared Vitest setup. Naive UI components query matchMedia and friends.
import { vi } from 'vitest'
import { enableAutoUnmount } from '@vue/test-utils'
import { afterEach } from 'vitest'

// Unmount every mounted component (and teleported DOM) after each test so
// teleported modals rendered into <body> do not leak between tests.
enableAutoUnmount(afterEach)

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
})

// jsdom does not implement Range.getClientRects. CodeMirror measures text
// asynchronously after unmount/teardown; without this stub those late
// measurements surface as Vitest unhandled errors even when assertions pass.
if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 }) as DOMRect
}
