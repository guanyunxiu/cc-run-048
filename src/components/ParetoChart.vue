<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { ObjectiveVector, ParetoPoint } from '@/types'
import {
  OBJECTIVE_KEYS,
  OBJECTIVE_LABELS,
  objectiveBounds
} from '@/core/multi-objective'

const props = withDefaults(
  defineProps<{
    points: ParetoPoint[]
    xAxis?: keyof ObjectiveVector
    yAxis?: keyof ObjectiveVector
    zAxis?: keyof ObjectiveVector
    /** 2D 或 3D 投影 */
    mode3d?: boolean
    height?: number
  }>(),
  {
    xAxis: 'distance',
    yAxis: 'threat',
    zAxis: 'energy',
    mode3d: false,
    height: 240
  }
)

const canvasRef = ref<HTMLCanvasElement | null>(null)
const hovered = ref<number | null>(null)
const mouse = ref({ x: 0, y: 0 })

const front = computed(() => props.points.filter((p) => !p.dominated))
const dominated = computed(() => props.points.filter((p) => p.dominated))
const bounds = computed(() => objectiveBounds(props.points))

const axisLabel = (k: keyof ObjectiveVector) => OBJECTIVE_LABELS[k]

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

  // 背景
  ctx.fillStyle = 'var(--bg-2)'
  ctx.fillStyle = '#101a2e'
  ctx.fillRect(0, 0, w, h)

  const padL = 46
  const padR = 16
  const padT = 18
  const padB = 34
  const pw = w - padL - padR
  const ph = h - padT - padB

  const b = bounds.value
  const range = (k: keyof ObjectiveVector) =>
    Math.max(b.max[k] - b.min[k], 1e-9)

  // 网格
  ctx.strokeStyle = 'rgba(120,150,200,0.18)'
  ctx.lineWidth = 1
  for (let i = 0; i <= 4; i++) {
    const y = padT + (ph / 4) * i
    ctx.beginPath()
    ctx.moveTo(padL, y)
    ctx.lineTo(w - padR, y)
    ctx.stroke()
  }

  if (props.points.length === 0) {
    ctx.fillStyle = '#7888a6'
    ctx.font = '12px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('运行 Pareto 扫描后展示前沿', w / 2, h / 2)
    return
  }

  // 坐标映射
  const xOf = (p: ParetoPoint) =>
    padL + ((p.objectives[props.xAxis] - b.min[props.xAxis]) / range(props.xAxis)) * pw
  const yOf = (p: ParetoPoint) =>
    padT + ph - ((p.objectives[props.yAxis] - b.min[props.yAxis]) / range(props.yAxis)) * ph
  // 3D 透视：z 轴向右上偏移
  const zScale = props.mode3d ? 0.28 : 0
  const zOff = (p: ParetoPoint) =>
    ((p.objectives[props.zAxis] - b.min[props.zAxis]) / range(props.zAxis)) * 40

  // 坐标轴标签
  ctx.fillStyle = '#9fb0d0'
  ctx.font = '10px sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(axisLabel(props.xAxis), padL + pw / 2, h - 8)
  ctx.save()
  ctx.translate(12, padT + ph / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.fillText(axisLabel(props.yAxis), 0, 0)
  ctx.restore()
  if (props.mode3d) {
    ctx.fillStyle = '#c98bff'
    ctx.textAlign = 'right'
    ctx.fillText(`● ${axisLabel(props.zAxis)}（深度）`, w - padR, padT - 4)
  }

  // Pareto 连线（2D 按 x 排序连前沿）
  if (!props.mode3d && front.value.length > 1) {
    const sorted = [...front.value].sort(
      (a, c) => a.objectives[props.xAxis] - c.objectives[props.xAxis]
    )
    ctx.strokeStyle = 'rgba(46,204,113,0.5)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    sorted.forEach((p, i) => {
      const x = xOf(p)
      const y = yOf(p)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }

  // 被支配点
  ctx.globalAlpha = 0.35
  for (const p of dominated.value) {
    const z = props.mode3d ? zOff(p) * zScale * 2 : 0
    ctx.fillStyle = '#7d8db0'
    ctx.beginPath()
    ctx.arc(xOf(p) + z, yOf(p) - z * 0.6, 3, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1

  // 前沿点
  front.value.forEach((p, i) => {
    const z = props.mode3d ? zOff(p) * zScale * 2 : 0
    const x = xOf(p) + z
    const y = yOf(p) - z * 0.6
    const isHover = hovered.value === props.points.indexOf(p)
    ctx.fillStyle = isHover ? '#ffe066' : '#2ecc71'
    ctx.beginPath()
    ctx.arc(x, y, isHover ? 6 : 4.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#0a1424'
    ctx.lineWidth = 1
    ctx.stroke()
    if (isHover) {
      drawTooltip(ctx, p, mouse.value.x, mouse.value.y, w)
    }
  })

  // 图例
  ctx.textAlign = 'left'
  ctx.font = '10px sans-serif'
  ctx.fillStyle = '#2ecc71'
  ctx.fillText(`● Pareto 前沿 (${front.value.length})`, padL, padT - 4)
  ctx.fillStyle = '#7d8db0'
  ctx.fillText(`● 被支配 (${dominated.value.length})`, padL + 120, padT - 4)
}

function drawTooltip(
  ctx: CanvasRenderingContext2D,
  p: ParetoPoint,
  mx: number,
  my: number,
  canvasW: number) {
  const lines = OBJECTIVE_KEYS.map(
    (k) => `${OBJECTIVE_LABELS[k]}: ${p.objectives[k].toFixed(2)}`
  )
  ctx.font = '10px sans-serif'
  const tw = 132
  const th = lines.length * 13 + 10
  let tx = mx + 12
  let ty = my - th - 6
  if (tx + tw > canvasW - 4) tx = mx - tw - 8
  if (ty < 4) ty = my + 12
  ctx.fillStyle = 'rgba(10,20,36,0.94)'
  ctx.strokeStyle = '#2ecc71'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.rect(tx, ty, tw, th)
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = '#d6e2f5'
  ctx.textAlign = 'left'
  lines.forEach((l, i) => ctx.fillText(l, tx + 7, ty + 14 + i * 13))
}

function onMove(e: MouseEvent) {
  const canvas = canvasRef.value
  if (!canvas || props.points.length === 0) return
  const rect = canvas.getBoundingClientRect()
  mouse.value = { x: e.clientX - rect.left, y: e.clientY - rect.top }
  // 命中检测：归一化坐标比较
  const b = bounds.value
  const padL = 46
  const padR = 16
  const padT = 18
  const padB = 34
  const pw = rect.width - padL - padR
  const ph = rect.height - padT - padB
  const range = (k: keyof ObjectiveVector) =>
    Math.max(b.max[k] - b.min[k], 1e-9)
  let best: number | null = null
  let bestD = 14
  props.points.forEach((p, i) => {
    if (p.dominated) return
    const x =
      padL +
      ((p.objectives[props.xAxis] - b.min[props.xAxis]) / range(props.xAxis)) *
        pw
    const y =
      padT +
      ph -
      ((p.objectives[props.yAxis] - b.min[props.yAxis]) / range(props.yAxis)) *
        ph
    const dd = Math.hypot(mouse.value.x - x, mouse.value.y - y)
    if (dd < bestD) {
      bestD = dd
      best = i
    }
  })
  hovered.value = best
}

function onLeave() {
  hovered.value = null
}

onMounted(draw)
watch(() => [props.points, props.xAxis, props.yAxis, props.zAxis, props.mode3d], draw, {
  deep: true
})
</script>

<template>
  <canvas
    ref="canvasRef"
    class="pareto-canvas"
    :style="{ height: height + 'px' }"
    @mousemove="onMove"
    @mouseleave="onLeave"
  ></canvas>
</template>

<style scoped>
.pareto-canvas {
  width: 100%;
  display: block;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #101a2e;
}
</style>
