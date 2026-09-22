<script setup lang="ts">
import { ref } from 'vue'
import { useSceneStore } from '@/stores/scene'
import { useSimStore } from '@/stores/sim'
import { Environment } from '@/core/environment'
import { compareAlgorithms, type AlgoCompareEntry } from '@/core/planning'
import { multiAlgoPareto } from '@/core/pareto'
import { ALGO_LABELS } from '@/core/planners/registry'
import ParetoChart from './ParetoChart.vue'
import ConvergenceChart from './ConvergenceChart.vue'
import type { AlgoType, ObjectiveKey, ParetoPoint } from '@/types'

const scene = useSceneStore()
const sim = useSimStore()

const selected = ref<Record<AlgoType, boolean>>({
  astar: true,
  dijkstra: true,
  rrt: true,
  rrtstar: true,
  hybridastar: true,
  aco: true,
  pso: true,
  ga: true
})
const running = ref(false)
const entries = ref<AlgoCompareEntry[] | null>(null)
const pareto = ref<ParetoPoint[]>([])
const chartMetric = ref<'distance' | 'planTimeMs' | 'threatExposure' | 'energyKJ' | 'smoothness' | 'satisfactionRate'>('distance')
const convAlgo = ref<AlgoType>('pso')

const allAlgos = Object.keys(ALGO_LABELS) as AlgoType[]

async function runCompare() {
  running.value = true
  entries.value = null
  await new Promise((r) => setTimeout(r, 30))
  const env = new Environment(
    scene.terrain,
    scene.threats,
    scene.noflyZones,
    scene.obstacles
  )
  const algos = allAlgos.filter((a) => selected.value[a])
  entries.value = compareAlgorithms(
    env,
    scene.waypoints,
    scene.planParams,
    scene.weights,
    algos,
    sim.smoothing
  )
  pareto.value = multiAlgoPareto(
    entries.value.map((e) => ({
      algo: e.algo,
      success: e.success,
      objectives: e.objectives,
      totalCost: e.totalCost,
      weights: scene.weights,
      path: e.path
    }))
  )
  running.value = false
}

function best(field: keyof AlgoCompareEntry, lower = true): string | number {
  if (!entries.value) return ''
  const ok = entries.value.filter((e) => e.success)
  if (ok.length === 0) return ''
  const vals = ok.map((e) => e[field] as number)
  return lower ? Math.min(...vals) : Math.max(...vals)
}

const metricOptions: { value: typeof chartMetric.value; label: string }[] = [
  { value: 'distance', label: '航程' },
  { value: 'planTimeMs', label: '耗时' },
  { value: 'threatExposure', label: '威胁暴露' },
  { value: 'energyKJ', label: '能耗' },
  { value: 'smoothness', label: '平滑度' },
  { value: 'satisfactionRate', label: '约束满足率' }
]

const algoColor: Record<string, string> = {
  astar: '#3aa0ff', dijkstra: '#5dade2', rrt: '#ffb020', rrtstar: '#f39c12',
  hybridastar: '#2ecc71', aco: '#e74c3c', pso: '#b046ff', ga: '#1abc9c'
}

function barStyle(e: AlgoCompareEntry) {
  if (!entries.value) return {}
  const ok = entries.value.filter((x) => x.success)
  const vals = ok.map((x) => x[chartMetric.value] as number)
  const max = Math.max(...vals, 1e-9)
  const v = e[chartMetric.value] as number
  return { width: Math.max(2, (v / max) * 100) + '%', background: algoColor[e.algo] }
}

const convEntry = () => entries.value?.find((e) => e.algo === convAlgo.value)
const xKey = ref<ObjectiveKey>('distance')
const yKey = ref<ObjectiveKey>('threat')
const zKey = ref<ObjectiveKey>('energy')
const mode3d = ref(false)
</script>

<template>
  <div>
    <div class="section">
      <div class="section-title">多算法规划对比（功能01/03）</div>
      <p class="tip">
        勾选参与对比的算法，使用<b>同一环境、任务与代价权重</b>批量规划，
        对比航程/耗时/节点/代价/暴露/约束/曲率，并新增<b>能耗与平滑度</b>指标。
      </p>
      <div class="algo-pick">
        <label v-for="a in allAlgos" :key="a" class="pick">
          <input type="checkbox" v-model="selected[a]" />
          {{ ALGO_LABELS[a].split(' ')[0] }}
        </label>
      </div>
      <button class="primary" style="width: 100%; margin-top: 8px" :disabled="running" @click="runCompare">
        {{ running ? '对比计算中…' : '⚖ 运行算法对比' }}
      </button>
    </div>

    <div v-if="entries" class="section">
      <div class="section-title">指标柱状对比图</div>
      <div class="metric-pick">
        <button
          v-for="m in metricOptions"
          :key="m.value"
          :class="{ active: chartMetric === m.value }"
          @click="chartMetric = m.value"
        >
          {{ m.label }}
        </button>
      </div>
      <div class="bars">
        <div v-for="e in entries" :key="e.algo" class="bar-row2">
          <span class="lbl">{{ ALGO_LABELS[e.algo].split(' ')[0] }}</span>
          <div class="track">
            <div class="fill" :style="barStyle(e)"></div>
          </div>
          <span class="val">{{ (e[chartMetric] as number).toFixed(chartMetric === 'smoothness' ? 3 : 1) }}</span>
        </div>
      </div>
    </div>

    <div v-if="entries" class="section">
      <div class="section-title">对比结果（最优值高亮）</div>
      <table class="cmp-table">
        <thead>
          <tr>
            <th>算法</th><th>状态</th><th>航程</th><th>耗时</th><th>节点</th>
            <th>代价</th><th>暴露</th><th>能耗</th><th>平滑</th><th>约束</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in entries" :key="e.algo" :class="{ fail: !e.success }">
            <td class="algo-name">{{ ALGO_LABELS[e.algo].split(' ')[0] }}</td>
            <td :style="{ color: e.success ? 'var(--ok)' : 'var(--danger)' }">{{ e.success ? '✓' : '✗' }}</td>
            <td :class="{ best: best('distance') === e.distance }">{{ e.distance.toFixed(0) }}</td>
            <td :class="{ best: best('planTimeMs') === e.planTimeMs }">{{ e.planTimeMs.toFixed(1) }}</td>
            <td :class="{ best: best('expandedNodes') === e.expandedNodes }">{{ e.expandedNodes }}</td>
            <td :class="{ best: best('totalCost') === e.totalCost }">{{ e.totalCost.toFixed(0) }}</td>
            <td :class="{ best: best('threatExposure') === e.threatExposure }">{{ e.threatExposure.toFixed(1) }}</td>
            <td :class="{ best: best('energyKJ') === e.energyKJ }">{{ e.energyKJ.toFixed(1) }}</td>
            <td :class="{ best: best('smoothness') === e.smoothness }">{{ e.smoothness.toFixed(3) }}</td>
            <td :class="{ best: best('satisfactionRate', false) === e.satisfactionRate }">{{ e.satisfactionRate.toFixed(0) }}%</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="pareto.length > 0" class="section">
      <div class="section-title">多算法 Pareto 前沿（功能03）</div>
      <div class="field-row">
        <label>X</label>
        <select v-model="xKey">
          <option value="distance">航程</option><option value="threat">威胁</option>
          <option value="energy">能耗</option><option value="smooth">平滑</option>
          <option value="dynamics">动力学</option>
        </select>
        <label>Y</label>
        <select v-model="yKey">
          <option value="threat">威胁</option><option value="distance">航程</option>
          <option value="energy">能耗</option><option value="smooth">平滑</option>
        </select>
        <label class="chk"><input type="checkbox" v-model="mode3d" />3D</label>
        <select v-if="mode3d" v-model="zKey">
          <option value="energy">能耗</option><option value="threat">威胁</option>
          <option value="smooth">平滑</option><option value="dynamics">动力学</option>
        </select>
      </div>
      <ParetoChart :points="pareto" :front="pareto.filter((p) => p.rank === 0)"
        :x-key="xKey" :y-key="yKey" :z-key="zKey" :mode3d="mode3d" />
    </div>

    <div v-if="entries" class="section">
      <div class="section-title">迭代收敛曲线（功能01）</div>
      <div class="field-row">
        <label>算法</label>
        <select v-model="convAlgo">
          <option v-for="a in allAlgos.filter((x) => ['rrt','rrtstar','aco','pso','ga'].includes(x))" :key="a" :value="a">
            {{ ALGO_LABELS[a as AlgoType].split(' ')[0] }}
          </option>
        </select>
      </div>
      <ConvergenceChart :data="convEntry()?.convergence ?? []" />
    </div>
  </div>
</template>

<style scoped>
.tip { color: var(--text-2); font-size: 11px; line-height: 1.6; margin: 4px 0 8px; }
.algo-pick { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 8px; }
.pick { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--text-1); }
.cmp-table { width: 100%; border-collapse: collapse; font-size: 10px; }
.cmp-table th, .cmp-table td { border: 1px solid var(--line); padding: 4px 3px; text-align: center; font-variant-numeric: tabular-nums; }
.cmp-table th { color: var(--text-2); font-weight: 500; }
.algo-name { text-align: left !important; color: var(--text-0); white-space: nowrap; }
td.best { color: var(--ok); font-weight: 700; background: rgba(46, 204, 113, 0.08); }
tr.fail { opacity: 0.55; }
.metric-pick { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 8px; }
.metric-pick button { padding: 4px 8px; font-size: 11px; }
.metric-pick button.active { background: var(--accent); color: #06101f; }
.bars { display: flex; flex-direction: column; gap: 4px; }
.bar-row2 { display: grid; grid-template-columns: 64px 1fr 60px; align-items: center; gap: 6px; font-size: 10px; }
.lbl { color: var(--text-1); white-space: nowrap; }
.track { height: 12px; background: var(--bg-2); border-radius: 3px; overflow: hidden; }
.fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
.val { text-align: right; color: var(--text-1); font-variant-numeric: tabular-nums; }
.field-row { display: flex; gap: 6px; align-items: center; font-size: 11px; margin-bottom: 6px; }
.field-row select { padding: 2px; }
.chk { display: flex; gap: 3px; align-items: center; }
</style>
