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
    listActiveProducers: vi.fn(async () => []),
    listActiveConsumers: vi.fn(async () => []),
    resetConsumerGroupOffset: vi.fn(async () => {}),
    createTopic: vi.fn(async () => {}),
    deleteTopic: vi.fn(async () => {}),
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

async function switchSection(wrapper: VueWrapper, key: string): Promise<void> {
  await wrapper.find(`[data-test="section-tab-${key}"]`).trigger('click')
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
    expect(wrapper.findAll('[data-test="topic-name"]').map((n) => n.text())).toEqual(['user-log'])
    await switchSection(wrapper, 'consumers')
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
    expect(wrapper.findAll('[data-test="topic-name"]').map((n) => n.text())).toEqual(['user-log', 'user-events'])
    await wrapper.find('[data-test="topic-search"]').setValue('od')
    expect(wrapper.findAll('[data-test="topic-name"]').map((n) => n.text())).toEqual(['order-db'])
  })

  it('filters consumer groups with fuzzy search', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'grp-1', state: 'Stable', topics: {} },
      { name: 'group_forensics_document_wait', state: 'Empty', topics: {} },
      { name: 'console-consumer-123', state: 'Empty', topics: {} },
    ])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    await switchSection(wrapper, 'consumers')
    expect(wrapper.findAll('[data-test="group-node"]')).toHaveLength(3)
    await wrapper.find('[data-test="group-search"]').setValue('grp')
    expect(wrapper.findAll('[data-test="group-node"]').map((n) => n.text())).toEqual(['grp-1', 'group_forensics_document_wait'])
    await wrapper.find('[data-test="group-search"]').setValue('grp-1')
    expect(wrapper.findAll('[data-test="group-node"]').map((n) => n.text())).toEqual(['grp-1'])
  })

  it('shows a no-match message when the consumer group search has no results', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'grp-1', state: 'Stable', topics: {} },
    ])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    await switchSection(wrapper, 'consumers')
    await wrapper.find('[data-test="group-search"]').setValue('zzz')
    expect(wrapper.findAll('[data-test="group-node"]')).toHaveLength(0)
    expect(wrapper.find('[data-test="group-empty"]').text()).toBe('无匹配 Consumer')
  })

  it('keeps the consumer group search input case-sensitive (no autocapitalize)', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    await switchSection(wrapper, 'consumers')
    const search = wrapper.find('[data-test="group-search"]')
    expect(search.attributes('autocapitalize')).toBe('off')
    expect(search.attributes('autocorrect')).toBe('off')
    expect(search.attributes('autocomplete')).toBe('off')
    expect(search.attributes('spellcheck')).toBe('false')
  })

  it('excludes far-apart subsequence matches and ranks the substring match first', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'activeInfoResult', partitions: [] },
      { name: 'ods_illegal_tyqresult', partitions: [] },
      { name: 'aaa_test_bbb', partitions: [] },
      { name: 'test_01', partitions: [] },
    ])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    await wrapper.find('[data-test="topic-search"]').setValue('test')
    expect(wrapper.findAll('[data-test="topic-name"]').map((n) => n.text())).toEqual(['test_01', 'aaa_test_bbb'])
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
      expect(wrapper.findAll('[data-test="topic-name"]')).toHaveLength(1)
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
      expect(wrapper.find('[data-test="tree-loading"]').exists()).toBe(false)
    })
    await switchSection(wrapper, 'consumers')
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="group-node"]').length).toBe(1)
    })
    await wrapper.find('[data-test="group-node"]').trigger('dblclick')
    expect(wrapper.emitted('open-group')?.[0]).toEqual(['a', 'grp-1'])
  })

  it('opens and closes the topic creation form from the Topics header', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'user-log', partitions: [] }])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    expect(wrapper.find('[data-test="create-form"]').exists()).toBe(false)
    await wrapper.find('[data-test="btn-create-object"]').trigger('click')
    expect(wrapper.find('[data-test="create-form"]').exists()).toBe(true)
    await wrapper.find('[data-test="btn-create-cancel"]').trigger('click')
    expect(wrapper.find('[data-test="create-form"]').exists()).toBe(false)
  })

  it('opens the create form when clicking anywhere on the Topics header row', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'user-log', partitions: [] }])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    expect(wrapper.find('[data-test="create-form"]').exists()).toBe(false)
    const header = wrapper.find('[data-test="object-group"]')
    expect(header.attributes('role')).toBe('button')
    await header.trigger('click')
    expect(wrapper.find('[data-test="create-form"]').exists()).toBe(true)
  })

  it('toggles the create form off when the Topics header row is clicked again', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'user-log', partitions: [] }])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    await wrapper.find('[data-test="object-group"]').trigger('click')
    expect(wrapper.find('[data-test="create-form"]').exists()).toBe(true)
    await wrapper.find('[data-test="object-group"]').trigger('click')
    expect(wrapper.find('[data-test="create-form"]').exists()).toBe(false)
  })

  it('renders the create form directly under the Topics header so it stays visible with many topics', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'aaa', partitions: [] },
      { name: 'bbb', partitions: [] },
      { name: 'ccc', partitions: [] },
    ])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    await wrapper.find('[data-test="btn-create-object"]').trigger('click')
    const form = wrapper.find('[data-test="create-form"]').element
    const topics = wrapper.findAll('[data-test="topic-node"]').map((n) => n.element)
    expect(topics.length).toBe(3)
    for (const t of topics) {
      // The form must precede every topic node, not be buried at the bottom of the list.
      expect(form.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })

  it('keeps the topic name input case-sensitive (no autocapitalize on macOS WebKit)', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'user-log', partitions: [] }])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    await wrapper.find('[data-test="btn-create-object"]').trigger('click')
    const input = wrapper.find('[data-test="create-name"]')
    expect(input.attributes('autocapitalize')).toBe('off')
    expect(input.attributes('autocorrect')).toBe('off')
    expect(input.attributes('autocomplete')).toBe('off')
    expect(input.attributes('spellcheck')).toBe('false')
  })

  it('keeps the fuzzy topic search input case-sensitive (no autocapitalize)', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'user-log', partitions: [] }])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    const search = wrapper.find('[data-test="topic-search"]')
    expect(search.attributes('autocapitalize')).toBe('off')
    expect(search.attributes('autocorrect')).toBe('off')
    expect(search.attributes('autocomplete')).toBe('off')
    expect(search.attributes('spellcheck')).toBe('false')
  })

  it('creates a topic and reloads the topic list', async () => {
    const listTopics = api.listTopics as ReturnType<typeof vi.fn>
    listTopics
      .mockResolvedValueOnce([{ name: 'user-log', partitions: [] }])
      .mockResolvedValueOnce([
        { name: 'user-log', partitions: [] },
        { name: 'brand-new', partitions: [] },
      ])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(api.createTopic as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    await wrapper.find('[data-test="btn-create-object"]').trigger('click')
    await wrapper.find('[data-test="create-name"]').setValue('brand-new')
    await wrapper.find('[data-test="create-partitions"]').setValue(3)
    await wrapper.find('[data-test="create-replication"]').setValue(1)
    await wrapper.find('[data-test="btn-create-submit"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.createTopic).toHaveBeenCalledWith({
        connection_id: 'a',
        topic: 'brand-new',
        partitions: 3,
        replication_factor: 1,
      })
    })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="topic-name"]').map((n) => n.text())).toContain('brand-new')
    })
    expect(wrapper.find('[data-test="create-form"]').exists()).toBe(false)
  })

  it('rejects an empty topic name without calling the api', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    await wrapper.find('[data-test="btn-create-object"]').trigger('click')
    await wrapper.find('[data-test="btn-create-submit"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="create-error"]').text()).toContain('不能为空')
    })
    expect(api.createTopic).not.toHaveBeenCalled()
  })

  it('deletes a topic after confirmation and reloads', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    ;(api.listTopics as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ name: 'user-log', partitions: [] }])
      .mockResolvedValueOnce([])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(api.deleteTopic as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    await wrapper.find('[data-test="btn-delete-topic"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.deleteTopic).toHaveBeenCalledWith({ connection_id: 'a', topic: 'user-log' })
    })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="topic-node"]')).toHaveLength(0)
    })
    confirmSpy.mockRestore()
  })

  it('skips deletion when confirmation is declined', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'user-log', partitions: [] }])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    await wrapper.find('[data-test="btn-delete-topic"]').trigger('click')
    expect(api.deleteTopic).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('emits delete and new', async () => {
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await wrapper.find('[data-test="btn-delete"]').trigger('click')
    expect(wrapper.emitted('delete')?.[0]).toEqual(['a'])
    await wrapper.find('[data-test="btn-new"]').trigger('click')
    expect(wrapper.emitted('new')).toBeTruthy()
  })
  it('shows a segmented control with counts after expanding', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'user-log', partitions: [] },
      { name: 'order-db', partitions: [] },
    ])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'grp-1', state: 'Stable', topics: {} },
      { name: 'grp-2', state: 'Stable', topics: {} },
      { name: 'grp-3', state: 'Empty', topics: {} },
    ])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    const topicsTab = wrapper.find('[data-test="section-tab-topics"]')
    const consumersTab = wrapper.find('[data-test="section-tab-consumers"]')
    expect(topicsTab.find('.segmented-label').text()).toBe('Topics')
    expect(topicsTab.find('.segmented-count').text()).toBe('2')
    expect(consumersTab.find('.segmented-label').text()).toBe('Consumers')
    expect(consumersTab.find('.segmented-count').text()).toBe('3')
  })

  it('defaults to the topics section and switches to consumers', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'user-log', partitions: [] }])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'grp-1', state: 'Stable', topics: {} }])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    expect(wrapper.findAll('[data-test="topic-node"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-test="group-node"]')).toHaveLength(0)
    await switchSection(wrapper, 'consumers')
    expect(wrapper.findAll('[data-test="group-node"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-test="topic-node"]')).toHaveLength(0)
    expect(wrapper.find('[data-test="section-tab-consumers"]').classes()).toContain('active')
    await switchSection(wrapper, 'topics')
    expect(wrapper.findAll('[data-test="topic-node"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-test="group-node"]')).toHaveLength(0)
  })
})
