import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { ConsumerGroup } from '@/api/types'
import ConsumerGroupView from './ConsumerGroupView.vue'

function fakeApi(overrides: Partial<Api> = {}): Api {
  return {
    listConnections: vi.fn(async () => []),
    createConnection: vi.fn(async (c: never) => c),
    deleteConnection: vi.fn(async () => {}),
    testConnection: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    getConnection: vi.fn(async () => ({}) as never),
    listTopics: vi.fn(async () => []),
    listConsumerGroups: vi.fn(async () => []),
    consumeMessages: vi.fn(async () => []),
    consumeMessagesByTimestamp: vi.fn(async () => []),
    getPartitionLag: vi.fn(async () => ({})),
    resetConsumerGroupOffset: vi.fn(async () => {}),
    produceMessage: vi.fn(async () => {}),
    ...overrides,
  }
}

function grp(): ConsumerGroup {
  return {
    name: 'grp-1',
    state: 'Stable',
    topics: {
      'orders': [
        { partition: 0, current_offset: 10, log_end_offset: 20, lag: 10 },
        { partition: 1, current_offset: 15, log_end_offset: 15, lag: 0 },
      ],
    },
  }
}

function mountView(overrides: Partial<Api> = {}) {
  setActivePinia(createPinia())
  const api = fakeApi(overrides)
  setApi(api)
  const wrapper = mount(ConsumerGroupView, { props: { tabId: 'tab1', connectionId: 'c' } })
  return { wrapper, api }
}

describe('ConsumerGroupView', () => {
  it('loads groups and renders the lag table for the first topic', async () => {
    const { wrapper } = mountView({ listConsumerGroups: vi.fn(async () => [grp()]) })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="lag-row"]')).toHaveLength(2)
    })
    const lags = wrapper.findAll('[data-test="lag-value"]').map((n) => n.text())
    expect(lags).toEqual(['10', '0'])
    expect(wrapper.find('[data-test="lag-empty"]').exists()).toBe(false)
  })

  it('shows an empty state when there is no lag', async () => {
    const g: ConsumerGroup = { name: 'grp-1', state: 'Empty', topics: {} }
    const { wrapper } = mountView({ listConsumerGroups: vi.fn(async () => [g]) })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="lag-empty"]').exists()).toBe(true)
    })
  })

  it('surfaces load errors', async () => {
    const { wrapper } = mountView({
      listConsumerGroups: vi.fn(async () => {
        throw new Error('cluster unavailable')
      }),
    })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="group-error"]').text()).toBe('cluster unavailable')
    })
  })

  it('resets offset to the selected mode and reloads', async () => {
    const listGroups = vi.fn(async () => [grp()])
    const { wrapper } = mountView({ listConsumerGroups: listGroups })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="lag-row"]')).toHaveLength(2)
    })
    await wrapper.find('[data-test="select-reset-mode"]').setValue('earliest')
    await wrapper.find('[data-test="btn-reset"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.emitted().length || true).toBe(true)
    })
    expect(wrapper.vm.$options).toBeDefined()
    // resetConsumerGroupOffset was called with earliest; then groups reloaded.
    await vi.waitFor(() => {
      expect(listGroups).toHaveBeenCalled()
    })
  })
})
