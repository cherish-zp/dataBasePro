<script setup lang="ts">
const emit = defineEmits<{ (e: 'new'): void }>()
</script>

<template>
  <div class="home" data-test="home-view">
    <div class="card">
      <div class="logo">🪐</div>
      <h1 class="title" data-test="home-title">多数据源数据库管理客户端</h1>
      <p class="desc">在左侧数据源树中展开连接，双击对象即可浏览。当前支持 Kafka，后续将扩展 MySQL、Elasticsearch 等数据源。</p>
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
  color: var(--text);
  font-family: var(--font);
}
.card {
  text-align: center; max-width: 460px; padding: 36px 40px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
}
.logo { font-size: 54px; margin-bottom: 14px; }
.title { font-size: 24px; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 12px; }
.desc { color: var(--text-secondary); font-size: 14px; line-height: 1.65; margin: 0 0 24px; }
.btn { border-radius: 9px; padding: 10px 24px; font-size: 14px; cursor: pointer; border: 1px solid transparent; transition: background 0.15s ease; }
.btn.primary { background: var(--accent); color: #fff; box-shadow: 0 1px 2px rgba(0, 113, 227, 0.3); }
.btn.primary:hover { background: var(--accent-hover); }
</style>
