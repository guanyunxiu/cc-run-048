<script setup lang="ts">
import { ref } from 'vue'
import { useSceneStore } from '@/stores/scene'
import { useSimStore } from '@/stores/sim'
import { Environment } from '@/core/environment'
import {
  buildExperimentConfig,
  buildExperimentReport,
  reportToCsv,
  runsToCsv,
  runBatchExperiment
} from '@/core/experiment'
import { ALGO_LABELS } from '@/core/planners/registry'
import type {
  AlgoType,
  ExperimentConfig,
  ExperimentReport
} from '@/types'

const scene = useSceneStore()
const sim = useSimStore()

const selected = ref<Record<AlgoType, boolean>>({
  astar: true,
  dijkstra: false,
  rrt: true,
  rrtstar: true,
  hybridastar: true,
  aco: true,
  pso: true,
  ga: true
})
const runsPerAlgo = ref(8)
const baseSeed = ref(20260920)
const running = ref(false)
const progress = ref(0)
const report = ref<ExperimentReport | null>(null)
const configName = ref('批量实验-默认场景')
const fileInput = ref<HTMLInputElement | null>(null)

const allAlgos = Object.keys(ALGO_LABELS) as AlgoType[]

async function runBatch() {
  running.value = true
  progress.value = 0
  report.value = null
  await new Promise((r) => setTimeout(r, 30))
  const algos = allAlgos.filter((a) => selected.value[a])
  // 主线程批量运行（与 Worker 同一套 core），分批让出主线程以更新进度
  const env = new Environment(
    scene.terrain,
    scene.threats,
    scene.noflyZones,
    scene.obstacles
  )
  const { runs, aggregates } = runBatchExperiment(
    env,
    scene.waypoints,
    scene.planParams,
    scene.weights,
    sim.smoothing,
    algos,
    runsPerAlgo.value,
    baseSeed.value,
    {
      onProgress: (done, total) => {
        progress.value = done / total
        // 每完成一个算法让出一帧，避免长时间阻塞
      }
    }
  )
  const config = buildExperimentConfig(
    scene.terrain,
    scene.threats,
    scene.noflyZones,
    scene.obstacles,
    scene.dynamics,
    scene.waypoints,
    scene.planParams,
    scene.weights,
    sim.smoothing,
    algos,
    runsPerAlgo.value,
    baseSeed.value,
    configName.value
  )
  report.value = buildExperimentReport(config, runs, aggregates)
  running.value = false
}

function download(name: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

function exportReportJson() {
  if (!report.value) return
  download(
    `experiment-${Date.now()}.json`,
    JSON.stringify(report.value, null, 2),
    'application/json'
  )
}
function exportAggCsv() {
  if (!report.value) return
  download(`experiment-agg-${Date.now()}.csv`, reportToCsv(report.value), 'text/csv')
}
function exportRunsCsv() {
  if (!report.value) return
  download(`experiment-runs-${Date.now()}.csv`, runsToCsv(report.value), 'text/csv')
}

function saveConfig() {
  const config = buildExperimentConfig(
    scene.terrain,
    scene.threats,
    scene.noflyZones,
    scene.obstacles,
    scene.dynamics,
    scene.waypoints,
    scene.planParams,
    scene.weights,
    sim.smoothing,
    allAlgos.filter((a) => selected.value[a]),
    runsPerAlgo.value,
    baseSeed.value,
    configName.value
  )
  download(
    `experiment-config-${Date.now()}.json`,
    JSON.stringify(config, null, 2),
    'application/json'
  )
}

function triggerImport() {
  fileInput.value?.click()
}

function importConfig(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const cfg = JSON.parse(String(reader.result)) as ExperimentConfig
      if (!cfg.algos || !cfg.planParams) throw new Error('实验配置格式不正确')
      scene.loadScene({
        version: '3.0.0',
        exportedAt: cfg.createdAt,
        terrain: cfg.terrain,
        threats: cfg.threats,
        noflyZones: cfg.noflyZones,
        obstacles: cfg.obstacles,
        waypoints: cfg.waypoints,
        planParams: cfg.planParams,
        weights: cfg.weights,
        dynamics: cfg.dynamics,
        rawPath: null,
        smoothPath: null,
        trajectory: null,
        stats: null
      })
      sim.setSmoothing(cfg.smoothing)
      runsPerAlgo.value = cfg.runsPerAlgo
      baseSeed.value = cfg.baseSeed
      configName.value = cfg.name
      for (const a of allAlgos) selected.value[a] = cfg.algos.includes(a)
      sim.message = `已载入实验配置：${cfg.name}`
    } catch (e) {
      sim.message = `配置导入失败：${(e as Error).message}`
    }
  }
  reader.readAsText(file)
  input.value = ''
}

function fmt(v: number, digits = 1) {
  return v.toFixed(digits)
}

import { computed } from 'vue'
const aggRows = computed(() => {
  if (!report.value) return []
  return Object.entries(report.value.aggregates)
    .filter(([, agg]) => agg)
    .map(([algo, agg]) => ({ algo: algo as AlgoType, agg: agg! }))
})
</script>

<template>
  <div>
    <div class="section">
      <div class="section-title">批量实验与统计（功能02）</div>
      <p class="tip">
        多算法 × 多种子重复规划，统计成功率、航程、威胁暴露时间、规划耗时、
        平滑度、能耗、约束满足率的均值/标准差/极值。固定随机种子，结果可复现。
      </p>
      <div class="algo-pick">
        <label v-for="a in allAlgos" :key="a" class="pick">
          <input type="checkbox" v-model="selected[a]" />
          {{ ALGO_LABELS[a].split(' ')[0] }}
        </label>
      </div>
      <div class="field-row">
        <label>实验名</label>
        <input v-model="configName" style="flex: 1" />
      </div>
      <div class="field-row">
        <label>每算法运行</label>
        <input type="number" v-model.number="runsPerAlgo" min="1" max="50" style="width: 56px" />
        <label>基础种子</label>
        <input type="number" v-model.number="baseSeed" style="width: 100px" />
      </div>
      <button class="primary" style="width: 100%; margin-top: 8px" :disabled="running" @click="runBatch">
        {{ running ? `批量运行中 ${(progress * 100).toFixed(0)}%` : '🧪 运行批量实验' }}
      </button>
      <div v-if="running" class="progress-track">
        <div class="progress-fill" :style="{ width: progress * 100 + '%' }"></div>
      </div>
      <div class="field-row" style="margin-top: 8px">
        <button @click="saveConfig">保存配置</button>
        <button @click="triggerImport">载入配置复现</button>
        <input ref="fileInput" type="file" accept="application/json" style="display:none" @change="importConfig" />
      </div>
    </div>

    <div v-if="report" class="section">
      <div class="section-title">聚合统计（均值 ± 标准差）</div>
      <table class="agg-table">
        <thead>
          <tr>
            <th>算法</th>
            <th>成功率</th>
            <th>航程</th>
            <th>耗时 ms</th>
            <th>暴露量</th>
            <th>暴露 s</th>
            <th>平滑度</th>
            <th>能耗 kJ</th>
            <th>约束%</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in aggRows" :key="row.algo">
            <td class="algo-name">{{ ALGO_LABELS[row.algo as AlgoType].split(' ')[0] }}</td>
            <td :class="{ good: row.agg.successRate >= 90, bad: row.agg.successRate < 60 }">
              {{ fmt(row.agg.successRate) }}%
            </td>
            <td>{{ fmt(row.agg.distance.mean, 0) }}±{{ fmt(row.agg.distance.std, 0) }}</td>
            <td>{{ fmt(row.agg.planTimeMs.mean, 1) }}±{{ fmt(row.agg.planTimeMs.std, 1) }}</td>
            <td>{{ fmt(row.agg.threatExposure.mean, 1) }}</td>
            <td>{{ fmt(row.agg.exposureTime.mean, 1) }}</td>
            <td>{{ fmt(row.agg.smoothness.mean, 3) }}</td>
            <td>{{ fmt(row.agg.energyKJ.mean, 1) }}</td>
            <td>{{ fmt(row.agg.satisfactionRate.mean, 0) }}%</td>
          </tr>
        </tbody>
      </table>
      <div class="field-row" style="margin-top: 8px">
        <button @click="exportReportJson">导出报告 JSON</button>
        <button @click="exportAggCsv">聚合 CSV</button>
        <button @click="exportRunsCsv">明细 CSV</button>
      </div>
      <p class="tip">
        共 {{ report.runs.length }} 次运行；报告含完整场景配置，可用于论文/报告复现。
      </p>
    </div>
  </div>
</template>

<style scoped>
.tip { color: var(--text-2); font-size: 11px; line-height: 1.6; margin: 4px 0 8px; }
.algo-pick { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 8px; }
.pick { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--text-1); }
.field-row { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--text-1); margin-top: 6px; }
.field-row input, .field-row select { padding: 3px 4px; }
.progress-track {
  height: 6px;
  background: var(--bg-2);
  border-radius: 3px;
  overflow: hidden;
  margin-top: 8px;
}
.progress-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.2s;
}
.agg-table { width: 100%; border-collapse: collapse; font-size: 10px; }
.agg-table th, .agg-table td {
  border: 1px solid var(--line);
  padding: 4px 3px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.agg-table th { color: var(--text-2); font-weight: 500; }
.algo-name { text-align: left !important; color: var(--text-0); white-space: nowrap; }
.good { color: var(--ok); }
.bad { color: var(--danger); }
</style>
