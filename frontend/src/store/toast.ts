import { defineStore } from 'pinia'
import { ref } from 'vue'

// 轻量全局提示(Layout 底部居中浮层,约 2.5s 自动消失)。
// 用于「保存到 SQL文件」这类需要跨组件反馈的动作结果。
export const useToastStore = defineStore('toast', () => {
  const message = ref<string | null>(null)
  let timer: ReturnType<typeof setTimeout> | null = null

  function show(msg: string): void {
    message.value = msg
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      message.value = null
    }, 2500)
  }

  return { message, show }
})
