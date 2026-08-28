import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import LagTrend from './LagTrend.vue'

// flush resolves the pending sampler microtasks under fake timers.
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe('LagTrend', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('samples once on mount and renders the polyline with stats', async () => {
    const sampler = vi.fn(async () => 42)
    const wrapper = mount(LagTrend, { props: { sampler } })
    expect(wrapper.find('[data-test="trend-empty"]').exists()).toBe(true)
    await flush()
    expect(sampler).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-test="trend-latest"]').text()).toBe('42')
    const coords = wrapper.find('[data-test="trend-polyline"]').attributes('points')
    expect(coords).toBeTruthy()
    expect((coords ?? '').split(' ')).toHaveLength(1)
    expect(wrapper.find('[data-test="trend-empty"]').exists()).toBe(false)
  })

  it('manual refresh appends a sample and updates min/max/latest', async () => {
    let value = 9
    const sampler = vi.fn(async () => value)
    const wrapper = mount(LagTrend, { props: { sampler } })
    await flush()
    value = 3
    await wrapper.find('[data-test="btn-trend-refresh"]').trigger('click')
    await flush()
    expect(sampler).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-test="trend-latest"]').text()).toBe('3')
    expect(wrapper.find('[data-test="trend-min"]').text()).toBe('3')
    expect(wrapper.find('[data-test="trend-max"]').text()).toBe('9')
    expect(((wrapper.find('[data-test="trend-polyline"]').attributes('points')) ?? '').split(' ')).toHaveLength(2)
  })

  it('caps the history at 60 points', async () => {
    const sampler = vi.fn(async () => 1)
    const wrapper = mount(LagTrend, { props: { sampler } })
    await flush()
    for (let i = 0; i < 70; i++) {
      await wrapper.find('[data-test="btn-trend-refresh"]').trigger('click')
      await flush()
    }
    const coords = (wrapper.find('[data-test="trend-polyline"]').attributes('points')) ?? ''
    expect(coords.split(' ')).toHaveLength(60)
  })

  it('polls on the selected auto-refresh interval', async () => {
    const sampler = vi.fn(async () => 3)
    const wrapper = mount(LagTrend, { props: { sampler } })
    await flush()
    expect(sampler).toHaveBeenCalledTimes(1)
    await wrapper.find('[data-test="select-trend-interval"]').setValue('5000')
    await vi.advanceTimersByTimeAsync(5000)
    expect(sampler).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(sampler).toHaveBeenCalledTimes(3)
  })

  it('switching the interval clears the previous timer', async () => {
    const sampler = vi.fn(async () => 3)
    const wrapper = mount(LagTrend, { props: { sampler } })
    await flush()
    await wrapper.find('[data-test="select-trend-interval"]').setValue('5000')
    await vi.advanceTimersByTimeAsync(5000)
    expect(sampler).toHaveBeenCalledTimes(2)
    // A pending 5s tick must not fire after the selector moves to 10s.
    await wrapper.find('[data-test="select-trend-interval"]').setValue('10000')
    await vi.advanceTimersByTimeAsync(5000)
    expect(sampler).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(sampler).toHaveBeenCalledTimes(3)
  })

  it('stops polling when the selector is switched off', async () => {
    const sampler = vi.fn(async () => 3)
    const wrapper = mount(LagTrend, { props: { sampler } })
    await flush()
    await wrapper.find('[data-test="select-trend-interval"]').setValue('5000')
    await vi.advanceTimersByTimeAsync(5000)
    expect(sampler).toHaveBeenCalledTimes(2)
    await wrapper.find('[data-test="select-trend-interval"]').setValue('0')
    await vi.advanceTimersByTimeAsync(30000)
    expect(sampler).toHaveBeenCalledTimes(2)
  })

  it('clears the timer on unmount', async () => {
    const sampler = vi.fn(async () => 3)
    const wrapper = mount(LagTrend, { props: { sampler } })
    await flush()
    await wrapper.find('[data-test="select-trend-interval"]').setValue('5000')
    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(30000)
    expect(sampler).toHaveBeenCalledTimes(1)
  })

  it('clears history and resamples when the sample key changes', async () => {
    const sampler = vi.fn(async () => 1)
    const wrapper = mount(LagTrend, { props: { sampler, sampleKey: 'g1/t1' } })
    await flush()
    await wrapper.find('[data-test="btn-trend-refresh"]').trigger('click')
    await flush()
    expect(((wrapper.find('[data-test="trend-polyline"]').attributes('points')) ?? '').split(' ')).toHaveLength(2)
    await wrapper.setProps({ sampleKey: 'g1/t2' })
    await flush()
    expect(sampler).toHaveBeenCalledTimes(3)
    expect(((wrapper.find('[data-test="trend-polyline"]').attributes('points')) ?? '').split(' ')).toHaveLength(1)
  })

  it('shows a sampling error and keeps previous points', async () => {
    const sampler = vi.fn(async () => 5)
    const wrapper = mount(LagTrend, { props: { sampler } })
    await flush()
    sampler.mockRejectedValueOnce(new Error('boom'))
    await wrapper.find('[data-test="btn-trend-refresh"]').trigger('click')
    await flush()
    expect(wrapper.find('[data-test="trend-error"]').text()).toBe('boom')
    expect(wrapper.find('[data-test="trend-latest"]').text()).toBe('5')
  })
})
