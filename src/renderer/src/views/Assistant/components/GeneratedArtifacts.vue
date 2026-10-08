<template>
  <ChatAudioPlayer
    v-for="track in music"
    :key="track.path"
    :file-path="track.path"
    :title="track.title"
  />
  <!-- 3D模型预览：一个模型一个框 -->
  <ChatModelViewer
    v-for="path in models"
    :key="path"
    :file-path="path"
    :default-collapsed="path !== latestModel"
    class="model-preview"
    @resize="emit('resize')"
  />
</template>

<script setup lang="ts">
/**
 * 一段过程里生成的音乐和 3D 模型，挂在它生成的位置。
 *
 * 以前统一摆在整条消息最底下：一轮跑了两小时、中途出的配乐，最后挂在
 * 交付后面，看着像是最后才做的。图和视频早就跟着步骤组走了（`StepMediaStrip`），
 * 这两样补齐。
 */
import ChatAudioPlayer from './ChatAudioPlayer.vue'
import ChatModelViewer from './ChatModelViewer.vue'
import type { GeneratedMusicTrack } from '../composables/agentGeneratedMedia'

defineProps<{
  music: GeneratedMusicTrack[]
  models: string[]
  /** 整条消息里最新的那个模型：只有它默认展开，其余收起把 WebGL 上下文还回去 */
  latestModel?: string
}>()

const emit = defineEmits<{ (e: 'resize'): void }>()
</script>

<style scoped>
.model-preview {
  margin-top: 12px;
  width: 100%;
}
</style>
