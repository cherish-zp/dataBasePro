import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import HomeView from './HomeView.vue'

describe('HomeView', () => {
  it('renders a welcome message', () => {
    const wrapper = mount(HomeView)
    expect(wrapper.find('[data-test="home-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="home-title"]').text()).toContain('Kafka')
  })

  it('emits new when the CTA is clicked', async () => {
    const wrapper = mount(HomeView)
    await wrapper.find('[data-test="home-new"]').trigger('click')
    expect(wrapper.emitted('new')).toBeTruthy()
  })
})
