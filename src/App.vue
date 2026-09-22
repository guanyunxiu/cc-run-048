<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue'
import ToolBar from '@/components/ToolBar.vue'
import Viewport from '@/components/Viewport.vue'
import RightPanel from '@/components/RightPanel.vue'
import PlaybackBar from '@/components/PlaybackBar.vue'
import { useSceneStore } from '@/stores/scene'
import { useSimStore } from '@/stores/sim'

const scene = useSceneStore()
const sim = useSimStore()

// 地形参数变化：去抖后重建网格（拖动滑块时避免逐帧重算 FBM）
let terrainDebounce = 0
watch(
  () => ({ ...scene.terrain }),
  () => {
    sim.markDirty()
    window.clearTimeout(terrainDebounce)
    terrainDebounce = window.setTimeout(() => {
      scene.terrainVersion++
    }, 250)
  }
)

// 实体几何变化即令规划失效；开启自动重规划时延迟去抖重算
let debounce = 0
watch(
  () => [
    JSON.stringify(scene.threats),
    JSON.stringify(scene.noflyZones),
    JSON.stringify(scene.obstacles),
    JSON.stringify(scene.waypoints),
    JSON.stringify(scene.planParams),
    JSON.stringify(scene.weights),
    sim.smoothing
  ],
  () => {
    sim.markDirty()
    if (sim.autoReplan && sim.status !== 'planning') {
      window.clearTimeout(debounce)
      debounce = window.setTimeout(() => void sim.plan(), 450)
    }
  },
  { deep: false }
)


onMounted(() => {
  // 首次自动规划，形成打开即演示的最小闭环
  void sim.plan()
})

onUnmounted(() => {
  window.clearTimeout(terrainDebounce)
  window.clearTimeout(debounce)
})
</script>

<template>
  <div class="app-shell">
    <ToolBar />
    <Viewport />
    <RightPanel />
    <PlaybackBar />
  </div>
</template>
