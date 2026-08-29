import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { AuditEntry } from '@/api/types'
import SettingsPanel from './SettingsPanel.vue'

const KEY = 'dbclient-theme'

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
    describeTopic: vi.fn(async () => ({ name: '', partitions: [], configs: [] })),
    describeCluster: vi.fn(async () => ({ cluster_id: '', controller_id: -1, kafka_version: '', brokers: [], under_replicated_partitions: 0 })),
    alterTopicConfig: vi.fn(async () => {}),
    listConsumerGroups: vi.fn(async () => []),
    describeGroup: vi.fn(async () => ({ group: '', state: '', protocol_type: '', members: [] })),
    consumeMessages: vi.fn(async () => []),
    consumeMessagesByTimestamp: vi.fn(async () => []),
    getPartitionLag: vi.fn(async () => ({})),
    listActiveProducers: vi.fn(async () => []),
    listActiveConsumers: vi.fn(async () => []),
    resetConsumerGroupOffset: vi.fn(async () => {}),
    createTopic: vi.fn(async () => {}),
    deleteTopic: vi.fn(async () => {}),
    deleteTopics: vi.fn(async () => []),
    deleteConsumerGroup: vi.fn(async () => {}),
    produceMessage: vi.fn(async () => {}),
    produceMessages: vi.fn(async () => []),
    listAudit: vi.fn(async () => []),
    ...overrides,
  }
}

const entry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  id: 1,
  connection_id: 'c1',
  action: 'create_topic',
  target: 'orders',
  result: 'ok',
  detail: '',
  timestamp: 1700000000000,
  ...overrides,
})

function mountPanel(show = true) {
  const wrapper = mount(SettingsPanel, { props: { show } })
  return wrapper
}

describe('SettingsPanel', () => {
  let api: Api
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    api = fakeApi()
    setApi(api)
  })

  it('renders nothing when hidden', () => {
    const wrapper = mountPanel(false)
    expect(wrapper.find('[data-test="settings-panel"]').exists()).toBe(false)
  })

  it('defaults to light theme and applies it on mount', () => {
    mountPanel()
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(localStorage.getItem(KEY)).toBe('light')
  })

  it('switching to light persists and applies the theme', async () => {
    const wrapper = mountPanel()
    await wrapper.find('[data-test="select-theme"]').setValue('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(localStorage.getItem(KEY)).toBe('light')
  })

  it('reads a previously stored theme', () => {
    localStorage.setItem(KEY, 'light')
    const wrapper = mountPanel()
    expect((wrapper.find('[data-test="select-theme"]').element as HTMLSelectElement).value).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('emits close', async () => {
    const wrapper = mountPanel()
    await wrapper.find('[data-test="modal-close"]').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('loads the audit list on mount and renders one row per entry', async () => {
    ;(api.listAudit as ReturnType<typeof vi.fn>).mockResolvedValue([
      entry({ action: 'create_connection', target: 'local', result: 'ok' }),
      entry({ id: 2, action: 'delete_topic', target: 'orders', result: 'error', detail: 'unknown topic', timestamp: 1700000001000 }),
    ])
    const wrapper = mountPanel()
    await vi.waitFor(() => {
      expect(api.listAudit).toHaveBeenCalledWith(200)
    })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="audit-row"]')).toHaveLength(2)
    })
    const rows = wrapper.findAll('[data-test="audit-row"]')
    // Action labels are localized.
    expect(rows[0].text()).toContain('新建连接')
    expect(rows[1].text()).toContain('删除 Topic')
    // Targets and results render.
    expect(rows[0].text()).toContain('local')
    expect(rows[0].text()).toContain('成功')
    expect(rows[1].text()).toContain('失败')
    expect(rows[1].text()).toContain('unknown topic')
    // Timestamps are formatted (not the raw epoch).
    expect(rows[0].find('[data-test="audit-time"]').text()).not.toBe('1700000000000')
  })

  it('renders the audit table with localized action labels and unknown fallback', async () => {
    ;(api.listAudit as ReturnType<typeof vi.fn>).mockResolvedValue([
      entry({ action: 'reset_group_offset', target: 'grp/t', detail: 'earliest' }),
      entry({ id: 2, action: 'mystery_op', target: 'x', result: 'error' }),
    ])
    const wrapper = mountPanel()
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="audit-row"]')).toHaveLength(2)
    })
    const rows = wrapper.findAll('[data-test="audit-row"]')
    expect(rows[0].text()).toContain('重置消费组位移')
    // Unknown actions fall back to the raw action string.
    expect(rows[1].text()).toContain('mystery_op')
  })

  it('shows an empty state when no audit entries exist', async () => {
    ;(api.listAudit as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mountPanel()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="audit-empty"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-test="audit-table"]').exists()).toBe(false)
  })

  it('re-fetches the audit list when the refresh button is clicked', async () => {
    ;(api.listAudit as ReturnType<typeof vi.fn>).mockResolvedValue([entry()])
    const wrapper = mountPanel()
    await vi.waitFor(() => {
      expect(api.listAudit).toHaveBeenCalledTimes(1)
    })
    await wrapper.find('[data-test="audit-refresh"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.listAudit).toHaveBeenCalledTimes(2)
    })
  })

  it('surfaces audit load errors in a banner', async () => {
    ;(api.listAudit as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk full'))
    const wrapper = mountPanel()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="audit-error"]').text()).toContain('disk full')
    })
  })
})
