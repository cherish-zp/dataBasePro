import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles.css'

// 开发调试:?mock 在浏览器里注入假 API(无 Wails 环境),仅 dev 生效。
if (import.meta.env.DEV && new URLSearchParams(location.search).has('mock')) {
  const { installDevMock } = await import('./test/devMock')
  installDevMock()
}

createApp(App).use(createPinia()).mount('#app')
