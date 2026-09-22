<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue'
import type { ObjectiveKey, SensitivityPoint } from '@/types'

/**
 * 权重敏感性分析图（迭代三功能01）：
 * 横轴为被扫描权重值，多条折线展示各目标原始值随权重变化。
 */
const props = defineProps<{
  data: SensitivityPoint[]
  watchKeys?: ObjectiveKey[]
  height?: number
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const W = 560
const H = computed(() => props.height ?? 200)

const COLORS: Record<ObjectiveKey, string> = {
  distance: '#3aa0ff',
  threat: '#ff5263',
  altitude: '#ffb020',
  nofly: '#b046ff',
  smooth: '#1abc9c',
  energy: '#f39c12',
  dynamics: '#e84393'
}
const LABEL: Record<ObjectiveKey, string> = {
  distance: '航程',
  threat: '威胁',
  altitude: '高度',
  nofly: '禁飞',
  smooth: '平滑',
  energy: '能耗',
  dynamics: '动力学'
}

const shown = computed(
  () => props.watchKeys ?? (['distance', 'threat', 'energy', 'dynamics'] as ObjectiveKey[])
)

function draw() {
  const canvas = canvasRef.value
  if (!canvas || props.data.length < 2) return
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, W, H.value)
  const padL = 46
  const padR = 12
  const padT = 12
  const padB = 28
  const plotW = W - padL - padR
  const plotH = H.value - padT - padB

  const wMin = props.data[0].weight
  const wMax = props.data[props.data.length - 1].weight
  // 各目标独立归一化（量纲差异大），展示相对变化趋势
  for (const key of shown.value) {
    const vals = props.data.map((d) => d.objectives[key])
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    const span = Math.max(max - min, 1e-9)
    ctx.strokeStyle = COLORS[key]
    ctx.lineWidth = 2
    ctx.beginPath()
    props.data.forEach((d, i) => {
      const x = padL + ((d.weight - wMin) / Math.max(wMax - wMin, 1e-9)) * plotW
      const y = padT + (1 - (d.objectives[key] - min) / span) * plotH
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }
  ctx.fillStyle = '#8fa3bf'
  ctx.font = '10px sans-serif'
  ctx.fillText(`权重 ${wMin.toFixed(1)} → ${wMax.toFixed(1)}`, padL, H.value - 8)
  ctx.fillText('归一化目标值 ↑', 6, padT + 10)
}

onMounted(draw)
watch(() => props.data, draw, { deep: true })
</script>

<template>
  <div>
    <canvas v-if="data.length >= 2" ref="canvasRef" :width="W" :height="H" class="canvas"></canvas>
    <div v-else class="empty">选择目标维度并运行敏感性分析。</div>
    <div v-if="data.length >= 2" class="legend">
      <span v-for="k in shown" :key="k">
        <i :style="{ background: COLORS[k] }"></i>{{ LABEL[k] }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.canvas {
  width: 100%;
  height: auto;
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: 6px;
}
.empty {
  padding: 24px 10px;
  color: var(--text-2);
  font-size: 11px;
  text-align: center;
  background: var(--bg-2);
  border: 1px dashed var(--line);
  border-radius: 6px;
}
.legend {
  display: flex;
  gap: 12px;
  font-size: 10px;
  color: var(--text-1);
  margin-top: 4px;
  flex-wrap: wrap;
}
.legend i {
  display: inline-block;
  width: 10px;
  height: 3px;
  margin-right: 4px;
}
</style>
