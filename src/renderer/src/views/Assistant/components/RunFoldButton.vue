<template>
  <!-- 整轮收起后的那一行，和步骤组的摘要行一个样子 -->
  <button type="button" class="run-fold" :aria-expanded="expanded" @click="emit('toggle')">
    <PhCaretRight class="run-fold-caret" :class="{ open: expanded }" />
    <span>{{ label }}</span>
  </button>
</template>

<script setup lang="ts">
import { PhCaretRight } from '@phosphor-icons/vue'

defineProps<{ label: string; expanded: boolean }>()

const emit = defineEmits<{ (e: 'toggle'): void }>()
</script>

<style scoped lang="less">
.run-fold {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  max-width: 100%;
  margin: 0 0 var(--space-4) calc(-1 * var(--space-1));
  padding: 2px var(--space-1);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font: inherit;
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition:
    color var(--motion-fast) var(--easing-standard),
    background var(--motion-fast) var(--easing-standard);

  &:hover {
    color: var(--color-text-secondary);
    background: var(--color-bg-surface-hover);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 1px;
  }
}

.run-fold-caret {
  flex: none;
  font-size: 10px;
  transition: transform var(--motion-fast) var(--easing-standard);

  &.open {
    transform: rotate(90deg);
  }
}
</style>
