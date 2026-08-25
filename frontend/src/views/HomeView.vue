<script setup lang="ts">
const emit = defineEmits<{ (e: 'new'): void }>()
</script>

<template>
  <div class="home" data-test="home-view">
    <div class="card">
      <div class="logo">🪐</div>
      <h1 class="title" data-test="home-title">Kafka 多数据源管理客户端</h1>
      <p class="desc">在左侧数据源树中展开连接，双击 Topic 浏览消息，双击 Consumer Group 查看 Lag 监控。</p>
      <button class="btn primary" type="button" data-test="home-new" @click="emit('new')">＋ 新建连接</button>
    </div>
  </div>
</template>

<style scoped>
.home {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0e141b;
  color: #d6dee8;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
.card { text-align: center; max-width: 460px; padding: 24px; }
.logo { font-size: 56px; margin-bottom: 12px; }
.title { font-size: 22px; margin: 0 0 10px; }
.desc { color: #9aa7b5; font-size: 14px; line-height: 1.6; margin: 0 0 20px; }
.btn { border-radius: 8px; padding: 10px 22px; font-size: 14px; cursor: pointer; border: 1px solid transparent; }
.btn.primary { background: #1f6feb; color: #fff; }
</style>
