<template>
  <div v-if="shown.length > 0 || videos.length > 0" class="step-media-strip">
    <div v-if="shown.length > 0" class="step-media-row">
      <button
        v-for="(image, index) in shown"
        :key="image"
        type="button"
        class="step-thumb"
        :class="{ small }"
        @click="open(index)"
      >
        <img
          :src="image"
          :alt="t('assistant.agentProcess.resultImageAlt')"
          loading="lazy"
          @error="markBroken(image)"
        />
        <span v-if="index === shown.length - 1 && hiddenCount > 0" class="step-more"
          >+{{ hiddenCount }}</span
        >
      </button>
    </div>
    <!-- 不自动播放：时间线一路往下滚，突然出声很唐突；只预载首帧和时长 -->
    <video
      v-for="video in videos"
      :key="video"
      class="step-video"
      :src="video"
      controls
      preload="metadata"
      playsinline
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 一排缩略图 + 视频。步骤组的产出、整轮收起后的「这轮产出」都用它。
 *
 * 图多了不铺满：最多 `max` 张，最后一张叠一个 +N，点开在大图里左右翻全部。
 * 加载不出来的图（文件被挪走了）直接不占位，不留碎图图标。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { openImageViewer } from '@renderer/services/imageViewer'

const props = withDefaults(
  defineProps<{
    images: string[]
    videos?: string[]
    /** 最多铺几张。0 = 不限 */
    max?: number
    /** 小号缩略图：收在展开区里的「它看过的图」 */
    small?: boolean
  }>(),
  { videos: () => [], max: 4, small: false }
)

const { t } = useI18n()

const broken = ref(new Set<string>())

function markBroken(src: string): void {
  broken.value = new Set(broken.value).add(src)
}

const available = computed(() => props.images.filter((image) => !broken.value.has(image)))

const shown = computed(() =>
  props.max > 0 ? available.value.slice(0, props.max) : available.value
)

const hiddenCount = computed(() => available.value.length - shown.value.length)

function open(index: number): void {
  void openImageViewer({
    items: available.value.map((src) => ({ src, alt: t('assistant.agentProcess.resultImageAlt') })),
    index
  })
}
</script>

<style scoped lang="less">
.step-media-strip {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.step-media-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

// 图本身就够显眼，不再套框：统一圆角、统一高度，悬停才描一圈
.step-thumb {
  position: relative;
  height: 96px;
  aspect-ratio: 16 / 10;
  padding: 0;
  overflow: hidden;
  border: 0;
  border-radius: var(--radius-md);
  background: var(--color-bg-sunken);
  outline: 1px solid transparent;
  outline-offset: 2px;
  cursor: zoom-in;
  transition: outline-color var(--motion-fast) var(--easing-standard);

  &:hover,
  &:focus-visible {
    outline-color: var(--color-border-strong);
  }

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  &.small {
    height: 52px;
  }
}

.step-more {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: var(--color-bg-overlay);
  color: var(--color-text-on-solid);
  font-family: var(--font-family-numeric);
  font-size: var(--font-size-md);
}

.step-video {
  display: block;
  width: 360px;
  max-width: 100%;
  border-radius: var(--radius-md);
  background: var(--color-bg-sunken);
}
</style>
