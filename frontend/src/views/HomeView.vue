<script setup lang="ts">
// 客户端首页(无激活 tab 时):展示已有能力。「新建连接」在左上角
// 连接树,此处不再重复提供入口。
interface Feature {
  icon: string
  title: string
  desc: string
}

// 支持的数据源(徽标条,与后端 builtinDrivers 保持一致)。
const SOURCES = [
  { icon: '⚡', name: 'Kafka' },
  { icon: '🐬', name: 'MySQL' },
  { icon: '🌿', name: 'TiDB' },
  { icon: '🐘', name: 'PostgreSQL' },
  { icon: '🐝', name: 'Hive' },
  { icon: '🗄️', name: 'ClickHouse' },
  { icon: '🔎', name: 'Elasticsearch' },
  { icon: '🧱', name: 'Redis' },
]

const FEATURES: Feature[] = [
  { icon: '🗂️', title: '八大数据源', desc: '统一连接管理与库表树,连接状态一目了然' },
  { icon: '💬', title: '六套 SQL 控制台', desc: '多语句执行、结果分页、查询文件保存与快捷键' },
  { icon: '✏️', title: '数据编辑', desc: '主键/整行定位的单元格编辑与行删除,预览确认防误操作' },
  { icon: '🛠️', title: '表管理', desc: '右键截断、删表、编辑表字段、导出表结构' },
  { icon: '⚡', title: 'Kafka 全家桶', desc: '消息浏览、批量生产、消费组 Lag 总览、集群健康' },
  { icon: '🧱', title: 'Redis 管理', desc: '五种类型读写、TTL 设置与内存占用查看' },
  { icon: '🎛️', title: '效率工具', desc: '⌘K 命令面板、tab 草稿、深浅色主题、操作审计' },
  { icon: '🔄', title: '自更新与文档', desc: '新版本红点提醒、原位无感升级、内置使用文档' },
]
</script>

<template>
  <div class="home" data-test="home-view">
    <div class="hero">
      <div class="logo">🪐</div>
      <h1 class="title" data-test="home-title">多数据源数据库管理客户端</h1>
      <p class="desc">一个客户端管理八类数据源：浏览、查询、编辑、导出一站式完成。</p>
      <div class="sources" data-test="home-sources">
        <span v-for="src in SOURCES" :key="src.name" class="source-badge" data-test="home-source-badge">
          <span class="source-icon">{{ src.icon }}</span>{{ src.name }}
        </span>
      </div>
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

.sources {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 14px;
}
.source-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 999px;
}
.source-icon { font-size: 13px; }

.features {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  width: min(1080px, 100%);
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
