<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import type { CostCurvePoint } from '@/stores/sim'

const props = defineProps<{
  curve: CostCurvePoint[]
  color?: string
}>()

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

  // 背景网格
  ctx.strokeStyle = 'rgba(80,100,140,0.25)'
  ctx.lineWidth = 1
  for (let i = 1; i < 4; i++) {
    const y = (h / 4) * i
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
  }

  if (props.curve.length < 2) {
    ctx.fillStyle = '#7888a6'
    ctx.font = '12px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('完成规划后显示代价曲线', w / 2, h / 2)
    return
  }

  const maxD = props.curve[props.curve.length - 1].distance || 1
  const maxC = props.curve[props.curve.length - 1].cumulative || 1

  // 填充面积
  const grad = ctx.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, 'rgba(58,160,255,0.35)')
  grad.addColorStop(1, 'rgba(58,160,255,0.02)')
  ctx.beginPath()
  ctx.moveTo(0, h)
  for (const p of props.curve) {
    ctx.lineTo((p.distance / maxD) * w, h - (p.cumulative / maxC) * (h - 6) - 3)
  }
  ctx.lineTo(w, h)
  ctx.closePath()
  ctx.fillStyle = grad
  ctx.fill()

  // 曲线
  ctx.beginPath()
  props.curve.forEach((p, i) => {
    const x = (p.distance / maxD) * w
    const y = h - (p.cumulative / maxC) * (h - 6) - 3
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.strokeStyle = props.color ?? '#3aa0ff'
  ctx.lineWidth = 2
  ctx.stroke()

  ctx.fillStyle = '#7888a6'
  ctx.font = '10px sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText(`航程 ${Math.round(maxD)} m`, 6, 12)
  ctx.textAlign = 'right'
  ctx.fillText(`总代价 ${maxC.toFixed(1)}`, w - 6, 12)
}

onMounted(draw)
watch(() => props.curve, draw, { deep: true })
</script>

<template>
  <canvas ref="canvasRef" class="cost-chart"></canvas>
</template>

<style scoped>
.cost-chart {
  width: 100%;
  height: 130px;
  display: block;
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: 6px;
}
</style>
