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
