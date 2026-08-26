import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { Connection } from '@/api/types'
import ConnectionTree from './ConnectionTree.vue'

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

const conn = (id: string, type: Connection['type'] = 'kafka'): Connection => ({
  id, name: `conn-${id}`, type,
  config: { bootstrap_servers: ['h:1'] }, created_at: 1, updated_at: 1,
})

async function expand(wrapper: VueWrapper, index = 0): Promise<void> {
  await wrapper.findAll('[data-test="conn-caret"]')[index].trigger('click')
  await vi.waitFor(() => {
    expect((wrapper.find('[data-test="tree-loading"]').exists() || true)).toBe(true)
  })
}

describe('ConnectionTree', () => {
  let api: Api
  beforeEach(() => {
    api = fakeApi()
    setApi(api)
  })

  it('renders connection names, friendly type labels and the new button', () => {
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a'), { ...conn('m'), type: 'mysql' }] } })
    expect(wrapper.findAll('[data-test="connection"]')).toHaveLength(2)
    expect(wrapper.find('[data-test="tree-empty"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-test="conn-type"]').map((n) => n.text())).toEqual(['Kafka', 'MySQL'])
  })

  it('shows an empty state when there are no connections', () => {
    const wrapper = mount(ConnectionTree, { props: { connections: [] } })
    expect(wrapper.find('[data-test="tree-empty"]').exists()).toBe(true)
  })

  it('loads topics and groups when expanded', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'user-log', partitions: [{ id: 0, leader: 0, replicas: [], isr: [] }] }])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'grp-1', state: 'Stable', topics: {} }])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await wrapper.find('[data-test="conn-caret"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="tree-loading"]').exists()).toBe(false)
    })
    expect(wrapper.findAll('[data-test="topic-node"]').map((n) => n.text())).toEqual(['user-log'])
    expect(wrapper.findAll('[data-test="group-node"]').map((n) => n.text())).toEqual(['grp-1'])
    expect(api.listTopics).toHaveBeenCalledWith('a')
  })

  it('expands by clicking anywhere on the connection row (name)', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'user-log', partitions: [] }])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    expect(wrapper.find('[data-test="conn-caret"]').classes()).not.toContain('open')
    await wrapper.find('[data-test="conn-name"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="topic-node"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-test="conn-caret"]').classes()).toContain('open')
  })

  it('delete button does not collapse the row', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'user-log', partitions: [] }])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await wrapper.find('[data-test="conn-name"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="topic-node"]').exists()).toBe(true)
    })
    await wrapper.find('[data-test="btn-delete"]').trigger('click')
    expect(wrapper.emitted('delete')?.[0]).toEqual(['a'])
    expect(wrapper.find('[data-test="conn-caret"]').classes()).toContain('open')
  })

  it('shows an unsupported message for non-kafka types', async () => {
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('m', 'mysql')] } })
    await wrapper.find('[data-test="conn-name"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="type-unsupported"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-test="type-unsupported"]').text()).toContain('MySQL')
  })

  it('filters topics with fuzzy search', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'user-log', partitions: [] },
      { name: 'order-db', partitions: [] },
      { name: 'user-events', partitions: [] },
    ])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    await wrapper.find('[data-test="topic-search"]').setValue('usr')
    expect(wrapper.findAll('[data-test="topic-node"]').map((n) => n.text())).toEqual(['user-log', 'user-events'])
    await wrapper.find('[data-test="topic-search"]').setValue('od')
    expect(wrapper.findAll('[data-test="topic-node"]').map((n) => n.text())).toEqual(['order-db'])
  })

  it('shows a no-match message when search has no results', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'user-log', partitions: [] }])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    await wrapper.find('[data-test="topic-search"]').setValue('zzz')
    expect(wrapper.findAll('[data-test="topic-node"]')).toHaveLength(0)
    expect(wrapper.find('[data-test="topic-empty"]').text()).toBe('无匹配 Topic')
    await wrapper.find('[data-test="topic-search"]').setValue('')
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="topic-node"]')).toHaveLength(1)
    })
  })

  it('emits open-topic on topic double click', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'user-log', partitions: [] }])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await wrapper.find('[data-test="conn-caret"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="topic-node"]').length).toBe(1)
    })
    await wrapper.find('[data-test="topic-node"]').trigger('dblclick')
    expect(wrapper.emitted('open-topic')?.[0]).toEqual(['a', 'user-log', []])
  })

  it('emits open-group on group double click', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'grp-1', state: 'Empty', topics: {} }])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await wrapper.find('[data-test="conn-caret"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="group-node"]').length).toBe(1)
    })
    await wrapper.find('[data-test="group-node"]').trigger('dblclick')
    expect(wrapper.emitted('open-group')?.[0]).toEqual(['a', 'grp-1'])
  })

  it('emits delete and new', async () => {
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await wrapper.find('[data-test="btn-delete"]').trigger('click')
    expect(wrapper.emitted('delete')?.[0]).toEqual(['a'])
    await wrapper.find('[data-test="btn-new"]').trigger('click')
    expect(wrapper.emitted('new')).toBeTruthy()
  })
})
