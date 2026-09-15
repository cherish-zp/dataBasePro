<script setup lang="ts">
// 客户端首页(无激活 tab 时):展示已有能力。「新建连接」在左上角
// 连接树,此处不再重复提供入口。
interface Feature {
  icon: string
  title: string
  desc: string
}

const FEATURES: Feature[] = [
  { icon: '⚡', title: 'Kafka 消息浏览', desc: 'Topic 消息检索、分区过滤、批量生产与导出' },
  { icon: '🗄️', title: 'ClickHouse 表浏览', desc: '分页 / 过滤 / 排序,双击单元格直接更新数据' },
  { icon: '🧵', title: 'Redis 键值管理', desc: '五种类型读写、TTL 设置与内存占用查看' },
  { icon: '💬', title: '双 SQL 控制台', desc: 'Kafka 消息 SQL 与 ClickHouse SQL,支持查询文件保存' },
  { icon: '👥', title: '消费组与 Lag 总览', desc: '消费状态 / 成员 / 堆积明细,重置消费位移' },
  { icon: '🫀', title: '集群健康与审计', desc: 'Broker 健康检查、操作审计日志、深浅色主题' },
  { icon: '🐬', title: 'MySQL / TiDB 管理', desc: '库表浏览、主键定位的数据编辑与 SQL 控制台' },
  { icon: '🔎', title: 'Elasticsearch 管理', desc: '索引浏览、文档编辑与 SQL 查询' },
]
</script>

<template>
  <div class="home" data-test="home-view">
    <div class="hero">
      <div class="logo">🪐</div>
      <h1 class="title" data-test="home-title">多数据源数据库管理客户端</h1>
      <p class="desc">在左侧数据源树新建或选择连接，双击对象即可开始浏览。</p>
    </div>

    <div class="features">
      <div v-for="f in FEATURES" :key="f.title" class="feature" data-test="feature-card">
        <div class="feature-icon">{{ f.icon }}</div>
        <div class="feature-body">
          <div class="feature-title" data-test="feature-title">{{ f.title }}</div>
          <div class="feature-desc" data-test="feature-desc">{{ f.desc }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.home {
  height: 100%;
  overflow: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 28px;
  padding: 32px;
  color: var(--text);
  font-family: var(--font);
}
.hero { text-align: center; max-width: 560px; }
.logo { font-size: 50px; margin-bottom: 10px; }
.title { font-size: 24px; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 10px; }
.desc { color: var(--text-secondary); font-size: 14px; line-height: 1.65; margin: 0; }

.features {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  width: min(860px, 100%);
}
.feature {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 14px 16px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  transition: border-color 0.15s ease, transform 0.15s ease;
}
.feature:hover { border-color: var(--accent-soft); transform: translateY(-1px); }
.feature-icon { font-size: 22px; line-height: 1.2; }
.feature-body { min-width: 0; }
.feature-title { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
.feature-desc { font-size: 12px; color: var(--text-secondary); line-height: 1.55; }

@media (max-width: 900px) {
  .features { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
