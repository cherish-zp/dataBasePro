import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { Connection } from '@/api/types'
import { CSV_MIME, downloadFile } from '@/utils/export'
import { useConnectionsStore } from '@/store/connections'
import ConnectionTree from './ConnectionTree.vue'

// Stub the DOM download trigger but keep the real CSV builders, so the
// assertions check exactly what the component passes to downloadFile.
vi.mock('@/utils/export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/export')>()
  return { ...actual, downloadFile: vi.fn() }
})

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
    describeTopic: vi.fn(async () => ({ name: "", partitions: [], configs: [] })),
    describeCluster: vi.fn(async () => ({ cluster_id: "", controller_id: -1, kafka_version: "", brokers: [], under_replicated_partitions: 0 })),
    alterTopicConfig: vi.fn(async () => {}),
    listConsumerGroups: vi.fn(async () => []),
    describeGroup: vi.fn(async () => ({ group: '', state: '', protocol_type: '', members: [] })),
    consumeMessages: vi.fn(async () => []),
    consumeMessagesByTimestamp: vi.fn(async () => []),
    getPartitionLag: vi.fn(async () => ({})),
    listActiveProducers: vi.fn(async () => []),
    listActiveConsumers: vi.fn(async () => []),
    resetConsumerGroupOffset: vi.fn(async () => {}),
    listAudit: vi.fn(async () => []),
    createTopic: vi.fn(async () => {}),
    deleteTopic: vi.fn(async () => {}),
    deleteTopics: vi.fn(async () => []),
    deleteConsumerGroup: vi.fn(async () => {}),
    produceMessage: vi.fn(async () => {}),
    produceMessages: vi.fn(async () => []),
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

// The ConfirmDialog teleports to <body>, so it is queried on document.body
// rather than inside the tree wrapper.
function confirmDialog(): HTMLElement | null {
  return document.body.querySelector('[data-test="confirm-dialog"]')
}
function clickConfirmDialog(testId: string): void {
  document.body.querySelector(`[data-test="${testId}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

describe('ConnectionTree', () => {
  let api: Api
  beforeEach(() => {
    setActivePinia(createPinia())
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
    expect(wrapper.findAll('[data-test="group-node"] .leaf-name').map((n) => n.text())).toEqual(['grp-1'])
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
    expect(wrapper.findAll('[data-test="group-node"] .leaf-name').map((n) => n.text())).toEqual(['grp-1', 'group_forensics_document_wait'])
    await wrapper.find('[data-test="group-search"]').setValue('grp-1')
    expect(wrapper.findAll('[data-test="group-node"] .leaf-name').map((n) => n.text())).toEqual(['grp-1'])
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

  it('does not open the topic tab when double-clicking the multi-select checkbox', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'user-log', partitions: [] }])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    await wrapper.find('[data-test="select-mode-toggle"]').trigger('click')
    const check = wrapper.find('[data-test="topic-check-user-log"]')
    expect(check.exists()).toBe(true)
    await check.trigger('dblclick')
    expect(wrapper.emitted('open-topic')).toBeUndefined()
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

  it('shows a Lag 总览 entry for an expanded kafka connection and emits open-lag on click', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    expect(wrapper.find('[data-test="btn-open-lag"]').exists()).toBe(false)
    await expand(wrapper)
    const entry = wrapper.find('[data-test="btn-open-lag"]')
    expect(entry.exists()).toBe(true)
    expect(entry.text()).toContain('Lag 总览')
    await entry.trigger('click')
    expect(wrapper.emitted('open-lag')?.[0]).toEqual(['a'])
  })

  it('opens the topic detail drawer from the info button', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'user-log', partitions: [] }])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockResolvedValue({ name: 'user-log', partitions: [], configs: [] })
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    expect(wrapper.find('[data-test="btn-topic-info"]').exists()).toBe(true)
    await wrapper.find('[data-test="btn-topic-info"]').trigger('click')
    expect(api.describeTopic).toHaveBeenCalledWith('a', 'user-log')
    // The drawer closes again and stays closed.
    await wrapper.find('[data-test="drawer-close"]').trigger('click')
    await wrapper.find('[data-test="btn-topic-info"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.describeTopic).toHaveBeenCalledTimes(2)
    })
  })

  it('emits open-health from the connection row health entry and does not render a drawer itself', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'user-log', partitions: [] }])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    expect(wrapper.find('[data-test="btn-cluster-health"]').exists()).toBe(true)
    await wrapper.find('[data-test="btn-cluster-health"]').trigger('click')
    expect(wrapper.emitted('open-health')?.[0]).toEqual(['a'])
  })

  it('hides the cluster health entry for non-kafka connections', () => {
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('m', 'mysql')] } })
    expect(wrapper.find('[data-test="btn-cluster-health"]').exists()).toBe(false)
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
    ;(api.listTopics as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ name: 'user-log', partitions: [] }])
      .mockResolvedValueOnce([])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(api.deleteTopic as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    await wrapper.find('[data-test="btn-delete-topic"]').trigger('click')
    expect(confirmDialog()).not.toBeNull()
    expect(confirmDialog()?.textContent).toContain('user-log')
    clickConfirmDialog('confirm-dialog-ok')
    await vi.waitFor(() => {
      expect(api.deleteTopic).toHaveBeenCalledWith({ connection_id: 'a', topic: 'user-log' })
    })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="topic-node"]')).toHaveLength(0)
    })
  })

  it('teleports the delete confirmation to body so it escapes the sidebar', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'user-log', partitions: [] }])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    await wrapper.find('[data-test="btn-delete-topic"]').trigger('click')
    const inBody = document.body.querySelector('[data-test="confirm-dialog"]')
    expect(inBody).not.toBeNull()
    expect(inBody?.textContent).toContain('user-log')
  })

  it('skips deletion when confirmation is declined', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'user-log', partitions: [] }])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    await wrapper.find('[data-test="btn-delete-topic"]').trigger('click')
    expect(confirmDialog()).not.toBeNull()
    clickConfirmDialog('confirm-dialog-cancel')
    expect(api.deleteTopic).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(confirmDialog()).toBeNull()
    })
  })

  it('deletes a consumer group after confirmation and reloads', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ name: 'grp-1', state: 'Empty', topics: {} }])
      .mockResolvedValueOnce([])
    ;(api.deleteConsumerGroup as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    await switchSection(wrapper, 'consumers')
    expect(wrapper.find('[data-test="btn-delete-group"]').exists()).toBe(true)
    await wrapper.find('[data-test="btn-delete-group"]').trigger('click')
    expect(confirmDialog()?.textContent).toContain('grp-1')
    clickConfirmDialog('confirm-dialog-ok')
    await vi.waitFor(() => {
      expect(api.deleteConsumerGroup).toHaveBeenCalledWith({ connection_id: 'a', group: 'grp-1' })
    })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="group-node"]')).toHaveLength(0)
    })
  })

  it('shows a delete button for each consumer group', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'grp-1', state: 'Stable', topics: {} },
      { name: 'grp-2', state: 'Stable', topics: {} },
    ])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    await switchSection(wrapper, 'consumers')
    expect(wrapper.findAll('[data-test="btn-delete-group"]')).toHaveLength(2)
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

  it('renders a status dot and a connect button for each connection', () => {
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    expect(wrapper.findAll('[data-test="conn-status-dot"]')).toHaveLength(1)
    expect(wrapper.find('[data-test="btn-connect"]').exists()).toBe(true)
  })

  it('shows the type-specific color class on the dot when connected', () => {
    const store = useConnectionsStore()
    store.setStatus('a', 'connected')
    store.setStatus('m', 'connected')
    const wrapper = mount(ConnectionTree, {
      props: { connections: [conn('a'), { ...conn('m'), type: 'es' }] },
    })
    const dots = wrapper.findAll('[data-test="conn-status-dot"]')
    expect(dots[0].classes()).toContain('conn-status-kafka')
    expect(dots[1].classes()).toContain('conn-status-es')
    expect(dots[0].attributes('data-status')).toBe('connected')
  })

  it('marks the dot as error when the connection status is error', () => {
    const store = useConnectionsStore()
    store.setStatus('a', 'error')
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    const dot = wrapper.find('[data-test="conn-status-dot"]')
    expect(dot.attributes('data-status')).toBe('error')
    expect(dot.classes()).toContain('conn-status-error')
  })

  it('connects a disconnected connection via the connect button', async () => {
    const store = useConnectionsStore()
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    expect(wrapper.find('[data-test="btn-connect"]').text()).toContain('连接')
    await wrapper.find('[data-test="btn-connect"]').trigger('click')
    expect(api.connect).toHaveBeenCalledWith('a')
    await vi.waitFor(() => {
      expect(store.statusById['a']).toBe('connected')
    })
  })

  it('disconnects a connected connection via the connect button', async () => {
    const store = useConnectionsStore()
    store.setStatus('a', 'connected')
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    expect(wrapper.find('[data-test="btn-connect"]').text()).toContain('断开')
    await wrapper.find('[data-test="btn-connect"]').trigger('click')
    expect(api.disconnect).toHaveBeenCalledWith('a')
    expect(store.statusById['a']).toBe('disconnected')
  })

  it('does not expand the row when clicking the connect button', async () => {
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await wrapper.find('[data-test="btn-connect"]').trigger('click')
    expect(wrapper.find('[data-test="conn-caret"]').classes()).not.toContain('open')
  })

  it('marks a connection connected after a successful expand load', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'user-log', partitions: [] }])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const store = useConnectionsStore()
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await wrapper.find('[data-test="conn-caret"]').trigger('click')
    await vi.waitFor(() => {
      expect(store.statusById['a']).toBe('connected')
    })
  })

  it('marks a connection as error when the expand load fails', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const store = useConnectionsStore()
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await wrapper.find('[data-test="conn-caret"]').trigger('click')
    await vi.waitFor(() => {
      expect(store.statusById['a']).toBe('error')
    })
  })

  it('toggles multi-select mode showing checkboxes and batch controls', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 't1', partitions: [] },
      { name: 't2', partitions: [] },
    ])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    expect(wrapper.find('[data-test="topic-check-t1"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="select-all-topics"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="batch-delete-topics"]').exists()).toBe(false)

    await wrapper.find('[data-test="select-mode-toggle"]').trigger('click')
    expect(wrapper.find('[data-test="topic-check-t1"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="topic-check-t2"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="select-all-topics"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="batch-delete-topics"]').exists()).toBe(true)

    await wrapper.find('[data-test="select-mode-toggle"]').trigger('click')
    expect(wrapper.find('[data-test="topic-check-t1"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="select-all-topics"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="batch-delete-topics"]').exists()).toBe(false)
  })

  it('selects all topics and reflects the count on the delete button', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 't1', partitions: [] },
      { name: 't2', partitions: [] },
      { name: 't3', partitions: [] },
    ])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    await wrapper.find('[data-test="select-mode-toggle"]').trigger('click')

    const del = wrapper.find('[data-test="batch-delete-topics"]')
    expect((del.element as HTMLButtonElement).disabled).toBe(true)
    expect(del.text()).toContain('删除(0)')

    await wrapper.find('[data-test="select-all-topics"]').trigger('click')
    const delAll = wrapper.find('[data-test="batch-delete-topics"]')
    expect(delAll.text()).toContain('删除(3)')
    expect((delAll.element as HTMLButtonElement).disabled).toBe(false)

    await wrapper.find('[data-test="topic-check-t1"]').trigger('click')
    expect(wrapper.find('[data-test="batch-delete-topics"]').text()).toContain('删除(2)')
  })

  it('batch deletes after confirmation and shows per-topic feedback', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        { name: 't1', partitions: [] },
        { name: 't2', partitions: [] },
        { name: 't3', partitions: [] },
      ])
      .mockResolvedValue([{ name: 't3', partitions: [] }])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(api.deleteTopics as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 't1', error: '' },
      { name: 't2', error: 'UNKNOWN_TOPIC_OR_PARTITION' },
    ])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    await wrapper.find('[data-test="select-mode-toggle"]').trigger('click')
    await wrapper.find('[data-test="topic-check-t1"]').trigger('click')
    await wrapper.find('[data-test="topic-check-t2"]').trigger('click')
    await wrapper.find('[data-test="batch-delete-topics"]').trigger('click')

    expect(confirmDialog()).not.toBeNull()
    expect(confirmDialog()?.textContent).toContain('2 个 Topic')

    clickConfirmDialog('confirm-dialog-ok')
    await vi.waitFor(() => {
      expect(api.deleteTopics).toHaveBeenCalledWith({ connection_id: 'a', names: ['t1', 't2'] })
    })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="batch-delete-summary"]').text()).toContain('成功 1 / 失败 1')
    })
    const failures = wrapper.find('[data-test="batch-delete-failures"]')
    expect(failures.text()).toContain('t2')
    expect(failures.text()).toContain('UNKNOWN_TOPIC_OR_PARTITION')
    // The tree refreshed (only t3 remains) and the selection was cleared.
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="topic-name"]').map((n) => n.text())).toEqual(['t3'])
    })
    expect(wrapper.find('[data-test="batch-delete-topics"]').text()).toContain('删除(0)')
  })

  it('skips batch deletion when confirmation is declined', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 't1', partitions: [] },
      { name: 't2', partitions: [] },
    ])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    await wrapper.find('[data-test="select-mode-toggle"]').trigger('click')
    await wrapper.find('[data-test="select-all-topics"]').trigger('click')
    await wrapper.find('[data-test="batch-delete-topics"]').trigger('click')
    expect(confirmDialog()).not.toBeNull()
    clickConfirmDialog('confirm-dialog-cancel')
    expect(api.deleteTopics).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(confirmDialog()).toBeNull()
    })
    // The selection survives a declined confirmation.
    expect(wrapper.find('[data-test="batch-delete-topics"]').text()).toContain('删除(2)')
  })

  it('clears the selection when leaving multi-select mode', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 't1', partitions: [] },
      { name: 't2', partitions: [] },
    ])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    await wrapper.find('[data-test="select-mode-toggle"]').trigger('click')
    await wrapper.find('[data-test="select-all-topics"]').trigger('click')
    expect(wrapper.find('[data-test="batch-delete-topics"]').text()).toContain('删除(2)')
    await wrapper.find('[data-test="select-mode-toggle"]').trigger('click')
    await wrapper.find('[data-test="select-mode-toggle"]').trigger('click')
    expect(wrapper.find('[data-test="batch-delete-topics"]').text()).toContain('删除(0)')
  })

  it('select-all only picks the topics left visible by the search filter', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'user-log', partitions: [] },
      { name: 'user-events', partitions: [] },
      { name: 'order-db', partitions: [] },
    ])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    await wrapper.find('[data-test="topic-search"]').setValue('user')
    await wrapper.find('[data-test="select-mode-toggle"]').trigger('click')
    await wrapper.find('[data-test="select-all-topics"]').trigger('click')
    expect(wrapper.find('[data-test="batch-delete-topics"]').text()).toContain('删除(2)')
    expect(api.deleteTopics).not.toHaveBeenCalled()
  })

  it('exports the full topic list as CSV even when the search filter matches nothing', async () => {
    ;(api.listTopics as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 't1', partitions: [{ id: 0, leader: 0, replicas: [], isr: [] }] },
      { name: 't2', partitions: [{ id: 0, leader: 0, replicas: [], isr: [] }, { id: 1, leader: 0, replicas: [], isr: [] }, { id: 2, leader: 0, replicas: [], isr: [] }] },
    ])
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(ConnectionTree, { props: { connections: [conn('a')] } })
    await expand(wrapper)
    await wrapper.find('[data-test="topic-search"]').setValue('zzz')
    expect(wrapper.findAll('[data-test="topic-node"]')).toHaveLength(0)

    await wrapper.find('[data-test="export-topics"]').trigger('click')
    expect(vi.mocked(downloadFile)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(downloadFile)).toHaveBeenCalledWith(
      'topics-conn-a',
      expect.stringContaining('topic,partitions'),
      CSV_MIME,
    )
    const csv = vi.mocked(downloadFile).mock.calls[0][1]
    expect(csv).toContain('t1,1')
    expect(csv).toContain('t2,3')
  })
})
