import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { ActiveProducer } from '@/api/types'
import ActiveProducersPanel from './ActiveProducersPanel.vue'

const producers: ActiveProducer[] = [
  { topic: 't1', partition: 0, producer_id: 101, producer_epoch: 3, last_sequence: 42, last_timestamp: 1700000000000, leader: 1 },
]

describe('ActiveProducersPanel', () => {
  it('renders producer rows with ids and partitions', () => {
    const wrapper = mount(ActiveProducersPanel, { props: { producers } })
    const rows = wrapper.findAll('[data-test="producer-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('0')
    expect(rows[0].text()).toContain('101')
    expect(rows[0].text()).toContain('3')
    expect(rows[0].text()).toContain('42')
  })

  it('shows an empty state when there are no producers', () => {
    const wrapper = mount(ActiveProducersPanel, { props: { producers: [] } })
    expect(wrapper.find('[data-test="producers-empty"]').text()).toBe('暂无活跃生产者')
  })

  it('shows a note when the broker does not support the query', () => {
    const wrapper = mount(ActiveProducersPanel, {
      props: { producers: [], note: '当前 Kafka 版本不支持活跃生产者查询' },
    })
    const note = wrapper.find('[data-test="producers-note"]')
    expect(note.exists()).toBe(true)
    expect(note.text()).toContain('不支持')
    expect(wrapper.find('[data-test="producers-empty"]').exists()).toBe(false)
  })
})
