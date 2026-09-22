<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import type { ConvergencePoint } from '@/types'

/**
 * 收敛曲线（功能01）：最优代价 + 平均代价随迭代变化。
 */
const props = withDefaults(
  defineProps<{
    data: ConvergencePoint[]
    height?: number
    color?: string
  }>(),
  { height: 150, color: '#1abc9c' }
)

const canvasRef = ref<HTMLCanvasElement | null>(null)

function draw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')!
  const dpr = Math.min(window.devicePixelRatio, 2)
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  canvas.width = w * dpr
  canvas.height = h * dpr
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = '#101a2e'
  ctx.fillRect(0, 0, w, h)

  ctx.strokeStyle = 'rgba(120,150,200,0.18)'
  for (let i = 1; i < 4; i++) {
    const y = (h / 4) * i
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
  }

  if (props.data.length < 2) {
    ctx.fillStyle = '#7888a6'
    ctx.font = '12px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('迭代式算法（ACO/PSO/GA）规划后显示收敛曲线', w / 2, h / 2)
    return
  }

  const maxIter = props.data[props.data.length - 1].iteration
  const allCosts = props.data.flatMap((p) => [p.bestCost, p.avgCost]).filter(isFinite)
  const minC = Math.min(...allCosts)
  const maxC = Math.max(...allCosts)
  const span = Math.max(maxC - minC, 1e-9)

  const xOf = (it: number) => (it / maxIter) * (w - 40) + 34
  const yOf = (c: number) => h - 22 - ((c - minC) / span) * (h - 38)

  const plotLine = (key: 'bestCost' | 'avgCost', color: string, width: number) => {
    ctx.beginPath()
    props.data.forEach((p, i) => {
      const x = xOf(p.iteration)
      const y = yOf(p[key])
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.stroke()
  }

  plotLine('avgCost', 'rgba(232,67,147,0.55)', 1.2)
  plotLine('bestCost', props.color, 2)

  ctx.fillStyle = '#9fb0d0'
  ctx.font = '10px sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText(`迭代 ${maxIter}`, 36, 12)
  ctx.textAlign = 'right'
  ctx.fillText(`最优 ${minC.toFixed(1)}`, w - 6, 12)

  ctx.textAlign = 'right'
  ctx.fillStyle = props.color
  ctx.fillText('● 最优', w - 6, h - 7)
  ctx.fillStyle = 'rgba(232,67,147,0.9)'
  ctx.fillText('● 平均  ', w - 44, h - 7)
}

onMounted(draw)
watch(() => props.data, draw, { deep: true })
</script>

<template>
  <canvas
    ref="canvasRef"
    class="conv-canvas"
    :style="{ height: height + 'px' }"
  ></canvas>
</template>

<style scoped>
.conv-canvas {
  width: 100%;
  display: block;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #101a2e;
}
</style>
