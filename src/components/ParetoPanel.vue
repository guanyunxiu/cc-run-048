<script setup lang="ts">
import { ref } from 'vue'
import { useSceneStore } from '@/stores/scene'
import { useSimStore } from '@/stores/sim'
import { Environment } from '@/core/environment'
import {
  scanWeightedPareto,
  weightSensitivity,
  PARETO_WEIGHT_PRESETS
} from '@/core/pareto'
import ParetoChart from './ParetoChart.vue'
import SensitivityChart from './SensitivityChart.vue'
import type {
  AlgoType,
  ObjectiveKey,
  ParetoPoint,
  SensitivityPoint
} from '@/types'
import { ALGO_LABELS } from '@/core/planners/registry'

const scene = useSceneStore()
const sim = useSimStore()

const running = ref(false)
const front = ref<ParetoPoint[]>([])
const all = ref<ParetoPoint[]>([])
const selected = ref<ParetoPoint | null>(null)
const mode3d = ref(false)
const samples = ref(24)
const xKey = ref<ObjectiveKey>('distance')
const yKey = ref<ObjectiveKey>('threat')
const zKey = ref<ObjectiveKey>('energy')

// 敏感性
const sensKey = ref<ObjectiveKey>('threat')
const sensData = ref<SensitivityPoint[]>([])
const sensRunning = ref(false)

const keyOptions: { value: ObjectiveKey; label: string }[] = [
  { value: 'distance', label: '航程' },
  { value: 'threat', label: '威胁' },
  { value: 'altitude', label: '高度' },
  { value: 'nofly', label: '禁飞' },
  { value: 'smooth', label: '平滑' },
  { value: 'energy', label: '能耗' },
  { value: 'dynamics', label: '动力学' }
]

async function runScan() {
  running.value = true
  front.value = []
  all.value = []
  await new Promise((r) => setTimeout(r, 30))
  const env = new Environment(
    scene.terrain,
    scene.threats,
    scene.noflyZones,
    scene.obstacles
  )
  const algo = scene.planParams.algo
  const res = scanWeightedPareto(
    env,
    scene.waypoints,
    scene.planParams,
    scene.weights,
    algo,
    sim.smoothing,
    { samples: samples.value, keepPath: false }
  )
  front.value = res.front
  all.value = res.all
  running.value = false
}

async function runSensitivity() {
  sensRunning.value = true
  sensData.value = []
  await new Promise((r) => setTimeout(r, 30))
  const env = new Environment(
    scene.terrain,
    scene.threats,
    scene.noflyZones,
    scene.obstacles
  )
  sensData.value = weightSensitivity(
    env,
    scene.waypoints,
    scene.planParams,
    scene.weights,
    scene.planParams.algo,
    sim.smoothing,
    sensKey.value,
    9,
    0,
    4
  )
  sensRunning.value = false
}

function onSelect(p: ParetoPoint) {
  selected.value = p
}

function applyWeights() {
  if (!selected.value) return
  Object.assign(scene.weights, selected.value.weights)
  sim.message = '已应用所选 Pareto 点的权重组合'
}
</script>

<template>
  <div>
    <div class="section">
      <div class="section-title">Pareto 多目标前沿（功能01）</div>
      <p class="tip">
        在<b>权重单纯形</b>上扫描多组偏好（{{ PARETO_WEIGHT_PRESETS.length }} 组预设 +
        随机权重组合），对同一任务重新规划，经非支配排序得到 Pareto 前沿。
        目标维：航程 / 威胁 / 高度 / 禁飞 / 平滑 / 能耗 / 动力学。
      </p>
      <div class="field-row">
        <label>采样数</label>
        <input type="number" v-model.number="samples" min="8" max="60" style="width: 64px" />
        <button class="primary" :disabled="running" @click="runScan">
          {{ running ? '扫描中…' : '📊 扫描 Pareto 前沿' }}
        </button>
      </div>
      <div class="field-row" style="margin-top: 6px">
        <label>X 轴</label>
        <select v-model="xKey">
          <option v-for="o in keyOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <label>Y 轴</label>
        <select v-model="yKey">
          <option v-for="o in keyOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </div>
      <div class="field-row" style="margin-top: 6px">
        <label class="checkbox">
          <input type="checkbox" v-model="mode3d" />
          三维（Z 轴）
        </label>
        <select v-if="mode3d" v-model="zKey">
          <option v-for="o in keyOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </div>

      <ParetoChart
        :points="all"
        :front="front"
        :x-key="xKey"
        :y-key="yKey"
        :z-key="zKey"
        :mode3d="mode3d"
        @select="onSelect"
      />

      <div v-if="front.length > 0" class="pareto-info">
        <div>前沿点数 <b>{{ front.length }}</b> / 总解 {{ all.length }}</div>
        <div v-if="selected">
          已选：{{ ALGO_LABELS[selected.algo].split(' ')[0] }} ·
          航程 {{ selected.objectives.distance.toFixed(0) }} ·
          威胁 {{ selected.objectives.threat.toFixed(1) }} ·
          能耗 {{ selected.objectives.energy.toFixed(1) }}kJ
          <button @click="applyWeights" style="margin-left: 6px">应用此权重</button>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">权重敏感性分析（功能01）</div>
      <p class="tip">
        固定其余权重，扫描单一权重从 0 到基准值 4 倍，观察各目标（归一化）如何随权重转移。
      </p>
      <div class="field-row">
        <label>扫描权重</label>
        <select v-model="sensKey">
          <option v-for="o in keyOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <button :disabled="sensRunning" @click="runSensitivity">
          {{ sensRunning ? '分析中…' : '运行敏感性分析' }}
        </button>
      </div>
      <SensitivityChart :data="sensData" />
    </div>
  </div>
</template>

<style scoped>
.tip {
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.6;
  margin: 4px 0 8px;
}
.field-row {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  color: var(--text-1);
}
.field-row select {
  padding: 3px 4px;
}
.pareto-info {
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-1);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.checkbox {
  display: flex;
  gap: 4px;
  align-items: center;
}
</style>
