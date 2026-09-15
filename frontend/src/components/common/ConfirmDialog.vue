<script setup lang="ts">
const props = withDefaults(
  defineProps<{ show: boolean; message: string; confirmText?: string; danger?: boolean }>(),
  { confirmText: '删除', danger: true },
)
const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>()

function close(): void {
  emit('cancel')
}
</script>

<template>
  <!-- Teleport to <body>: the sidebar uses backdrop-filter, which would
       otherwise become the containing block for position:fixed and confine
       the dialog to the scrolled sidebar box. Teleporting keeps the dialog
       viewport-centered no matter where the delete action was triggered. -->
  <Teleport to="body">
    <div v-if="show" class="modal-backdrop" data-test="confirm-dialog" @click.self="close">
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title">确认操作</span>
          <button class="modal-close" type="button" data-test="confirm-dialog-close" @click="close">✕</button>
        </div>
        <div class="modal-body">
          <p class="message" data-test="confirm-dialog-message">{{ message }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn ghost" type="button" data-test="confirm-dialog-cancel" @click="close">取消</button>
          <button
            class="btn primary"
            :class="{ danger }"
            type="button"
            data-test="confirm-dialog-ok"
            @click="emit('confirm')"
          >
            {{ confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-backdrop {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(0, 0, 0, 0.32);
  -webkit-backdrop-filter: blur(2px);
  backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center;
}
.modal {
  width: 380px; max-width: calc(100vw - 48px);
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: 14px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.18);
  overflow: hidden;
}
.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid var(--border);
}
.modal-title { font-size: 14px; font-weight: 600; }
.modal-close { background: none; border: none; color: var(--text-tertiary); cursor: pointer; font-size: 14px; padding: 2px 4px; border-radius: 6px; }
.modal-close:hover { color: var(--text); background: var(--bg-hover); }
.modal-body { padding: 18px; }
.message { font-size: 13px; color: var(--text); line-height: 1.6; margin: 0; white-space: pre-wrap; word-break: break-all; }
.modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 0 18px 16px; }
.btn { border-radius: 9px; padding: 8px 16px; font-size: 13px; font-weight: 500; cursor: pointer; border: 1px solid transparent; transition: background 0.15s ease, opacity 0.15s ease; }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--border-strong); }
.btn.ghost:hover { background: var(--bg-hover); }
.btn.primary { background: var(--accent); color: #fff; }
.btn.primary:hover { background: var(--accent-hover); }
.btn.primary.danger { background: var(--danger); }
.btn.primary.danger:hover { background: var(--danger-hover, var(--danger)); }
</style>
