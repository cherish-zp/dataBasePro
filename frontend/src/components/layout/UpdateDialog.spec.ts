import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import { APP_VERSION } from '@/version'
import UpdateDialog from './UpdateDialog.vue'

function fakeApi(overrides: Partial<Api> = {}): Api {
  return {
    listConnections: vi.fn(async () => []),
    createConnection: vi.fn(async (c: never) => c),
    updateConnection: vi.fn(async () => ({}) as never),
    deleteConnection: vi.fn(async () => {}),
    testConnection: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    getConnection: vi.fn(async () => ({}) as never),
    listTopics: vi.fn(async () => []),
    describeTopic: vi.fn(async () => ({ name: '', partitions: [], configs: [] })),
    alterTopicConfig: vi.fn(async () => {}),
    alterTopicPartitions: vi.fn(async () => {}),
    getTopicMessageCounts: vi.fn(async () => ({})),
    describeCluster: vi.fn(
      async () => ({ cluster_id: '', controller_id: -1, kafka_version: '', brokers: [], under_replicated_partitions: 0 }) as never,
    ),
    listConsumerGroups: vi.fn(async () => []),
    describeGroup: vi.fn(async () => ({ group: '', state: '', protocol_type: '', members: [] })),
    consumeMessages: vi.fn(async () => []),
    consumeMessagesByTimestamp: vi.fn(async () => []),
    getPartitionLag: vi.fn(async () => ({})),
    listActiveProducers: vi.fn(async () => []),
    listActiveConsumers: vi.fn(async () => []),
    resetConsumerGroupOffset: vi.fn(async () => {}),
    previewResetOffset: vi.fn(async () => ({})),
    listAudit: vi.fn(async () => []),
    saveTextFile: vi.fn(async () => ''),
    checkUpdate: vi.fn(async () => ({ has_update: false, latest_version: 'v1.0.0' })),
    downloadUpdate: vi.fn(async () => {}),
    applyUpdate: vi.fn(async () => {}),
    updateProgress: vi.fn(async () => ({ phase: 'idle' as const, percent: 0 })),
    openURL: vi.fn(async () => {}),
    redisHashSetField: vi.fn(async () => {}),
    redisHashDeleteField: vi.fn(async () => {}),
    redisListSetIndex: vi.fn(async () => {}),
    redisListPush: vi.fn(async () => {}),
    redisListDeleteIndex: vi.fn(async () => {}),
    redisSetAdd: vi.fn(async () => {}),
    redisSetRemove: vi.fn(async () => {}),
    redisZSetAdd: vi.fn(async () => {}),
    redisZSetRemove: vi.fn(async () => {}),
    testRedisConnection: vi.fn(async () => {}),
    listRedisDBs: vi.fn(async () => []),
    redisScan: vi.fn(async () => ({ cursor: 0, keys: [] })),
    redisGetKey: vi.fn(async () => ({ key: '', type: 'string', ttl_seconds: -1 })),
    redisRenameKey: vi.fn(async () => {}),
    redisDeleteKeys: vi.fn(async () => 0),
    redisSetTTL: vi.fn(async () => {}),
    redisSetString: vi.fn(async () => {}),
    redisFlushDB: vi.fn(async () => {}),
    redisFlushAll: vi.fn(async () => {}),
    redisServerInfo: vi.fn(async () => ({ mode: 'standalone' as const, used_memory_human: '', connected_clients: 0, total_keys: 0 })),
    createTopic: vi.fn(async () => {}),
    deleteTopic: vi.fn(async () => {}),
    deleteTopics: vi.fn(async () => []),
    deleteConsumerGroup: vi.fn(async () => {}),
    produceMessage: vi.fn(async () => {}),
    produceMessages: vi.fn(async () => []),
    ...overrides,
  }
}

// 组件 teleport 到 body,断言都走 document.body。
function el(testId: string): HTMLElement | null {
  return document.body.querySelector(`[data-test="${testId}"]`)
}
function click(testId: string): void {
  el(testId)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

describe('UpdateDialog', () => {
  let api: Api
  beforeEach(() => {
    api = fakeApi()
    setApi(api)
  })

  it('renders nothing when hidden', () => {
    mount(UpdateDialog, { props: { show: false } })
    expect(el('update-dialog')).toBeNull()
  })

  it('does not close when the overlay backdrop is clicked', async () => {
    const wrapper = mount(UpdateDialog, { props: { show: true } })
    await vi.waitFor(() => {
      expect(el('update-dialog')).not.toBeNull()
    })
    // 遮罩是弹窗的直接父元素;在其上派发 click 时 target 即遮罩自身,
    // 等价于点击弹窗外的空白处。弹窗必须保持打开且不 emit close。
    const overlay = el('update-dialog')?.parentElement as HTMLElement
    expect(overlay).not.toBeNull()
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(el('update-dialog')).not.toBeNull()
  })

  it('probes on open and reports up-to-date', async () => {
    mount(UpdateDialog, { props: { show: true } })
    await vi.waitFor(() => {
      expect(el('update-status')?.textContent).toContain('已是最新版本')
    })
    expect(api.checkUpdate).toHaveBeenCalledWith({ current_version: APP_VERSION })
  })

  it('shows the new version and notes when an update is available', async () => {
    ;(api.checkUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      has_update: true,
      latest_version: 'v1.1.0',
      notes: '修复若干问题',
      download_url: 'http://x/mac.zip',
    })
    mount(UpdateDialog, { props: { show: true } })
    await vi.waitFor(() => {
      expect(el('update-status')?.textContent).toContain('v1.1.0')
    })
    expect(el('update-notes')?.textContent).toContain('修复若干问题')
    expect(el('btn-update-install')).not.toBeNull()
  })

  it('downloads with progress then applies the update', async () => {
    ;(api.checkUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      has_update: true,
      latest_version: 'v1.1.0',
      notes: '',
      download_url: 'http://x/mac.zip',
    })
    ;(api.updateProgress as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ phase: 'downloading', percent: 10 })
      .mockResolvedValueOnce({ phase: 'downloading', percent: 60 })
      .mockResolvedValue({ phase: 'done', percent: 100 })
    mount(UpdateDialog, { props: { show: true } })
    await vi.waitFor(() => {
      expect(el('btn-update-install')).not.toBeNull()
    })
    click('btn-update-install')
    await vi.waitFor(() => {
      expect(api.downloadUpdate).toHaveBeenCalledWith({ url: 'http://x/mac.zip' })
    })
    // 轮询进度应至少读到一次 downloading
    await vi.waitFor(() => {
      expect(el('update-status')?.textContent).toMatch(/下载中|安装中/)
    })
    await vi.waitFor(() => {
      expect(api.applyUpdate).toHaveBeenCalled()
    })
  })

  it('surfaces download errors with retry and open-download-page exits', async () => {
    ;(api.checkUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      has_update: true,
      latest_version: 'v1.1.0',
      notes: '',
      download_url: 'http://x/mac.zip',
    })
    ;(api.updateProgress as ReturnType<typeof vi.fn>).mockResolvedValue({
      phase: 'error',
      percent: 0,
      error: '下载失败: HTTP 500',
    })
    mount(UpdateDialog, { props: { show: true } })
    await vi.waitFor(() => {
      expect(el('btn-update-install')).not.toBeNull()
    })
    click('btn-update-install')
    await vi.waitFor(() => {
      expect(el('update-status')?.textContent).toContain('下载失败: HTTP 500')
    })
    expect(el('btn-update-retry')).not.toBeNull()
    click('btn-update-open-page')
    await vi.waitFor(() => {
      expect(api.openURL).toHaveBeenCalledWith('http://x/mac.zip')
    })
  })
})
