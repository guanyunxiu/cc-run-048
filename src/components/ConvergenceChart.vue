<script setup lang="ts">
import { computed, watch, ref, onMounted } from 'vue'
import type { ConvergencePoint } from '@/types'

/**
 * 收敛曲线（迭代三功能01）：每代最优 + 平均代价双线图，纯 Canvas 2D。
 */
const props = defineProps<{
  data: ConvergencePoint[]
  height?: number
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const W = 560
const h = computed(() => props.height ?? 160)

const hasData = computed(() => props.data.length >= 2)

function draw() {
  const canvas = canvasRef.value
  if (!canvas || !hasData.value) return
  const ctx = canvas.getContext('2d')!
  const H = h.value
  ctx.clearRect(0, 0, W, H)
  const d = props.data
  const maxX = d[d.length - 1].iteration || 1
  const bestVals = d.map((p) => p.bestSoFar || p.bestCost)
  const meanVals = d.map((p) => p.meanCost ?? p.bestCost)
  const maxY = Math.max(...meanVals, ...bestVals) * 1.05
  const minY = Math.min(...bestVals) * 0.95
  const span = Math.max(maxY - minY, 1e-6)
  const padL = 46
  const padR = 12
  const padT = 12
  const padB = 24
  const px = (it: number) => padL + (it / maxX) * (W - padL - padR)
  const py = (v: number) => padT + (1 - (v - minY) / span) * (H - padT - padB)

  // 背景网格 + 轴标签
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'
  ctx.fillStyle = '#8fa3bf'
  ctx.font = '10px sans-serif'
  ctx.lineWidth = 1
  for (let i = 0; i <= 4; i++) {
    const y = padT + (i / 4) * (H - padT - padB)
    ctx.beginPath()
    ctx.moveTo(padL, y)
    ctx.lineTo(W - padR, y)
    ctx.stroke()
    const val = maxY - (i / 4) * span
    ctx.fillText(val >= 1000 ? (val / 1000).toFixed(1) + 'k' : val.toFixed(0), 4, y + 3)
  }
  ctx.fillText('代数 →', W - 40, H - 6)

  const line = (vals: number[], color: string, width: number) => {
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.beginPath()
    vals.forEach((v, i) => {
      const x = px(d[i].iteration)
      const y = py(v)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }
  line(meanVals, '#3aa0ff', 1.2)
  line(bestVals, '#2ecc71', 2)
}

onMounted(draw)
watch(() => props.data, draw, { deep: true })
</script>

<template>
  <div class="conv">
    <canvas v-if="hasData" ref="canvasRef" :width="W" :height="h" class="canvas"></canvas>
    <div v-else class="empty">
      所选算法（A*/Dijkstra/Hybrid A*）无迭代过程；
      切换 RRT/ACO/PSO/GA 后规划可查看收敛曲线。
    </div>
    <div v-if="hasData" class="legend">
      <span><i class="best"></i>全局最优</span>
      <span><i class="mean"></i>当代平均</span>
    </div>
  </div>
</template>

<style scoped>
.conv { width: 100%; }
.canvas {
  width: 100%;
  height: auto;
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: 6px;
}
.empty {
  padding: 18px 10px;
  color: var(--text-2);
  font-size: 11px;
  text-align: center;
  background: var(--bg-2);
  border: 1px dashed var(--line);
  border-radius: 6px;
}
.legend {
  display: flex;
  gap: 14px;
  font-size: 11px;
  color: var(--text-1);
  margin-top: 4px;
}
.legend i {
  display: inline-block;
  width: 14px;
  height: 3px;
  margin-right: 4px;
  vertical-align: middle;
}
.legend .best { background: #2ecc71; }
.legend .mean { background: #3aa0ff; }
</style>
