<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSceneStore } from '@/stores/scene'
import { useSimStore } from '@/stores/sim'
import PlannerWorker from '@/workers/planner.worker.ts?worker'
import type {
  AlgoType,
  ExperimentConfig
} from '@/types'
import type {
  WorkerRequest,
  WorkerResponse
} from '@/workers/planner.worker'
import {
  exportExperimentReport,
  exportRunsCsv,
  type BatchResult
} from '@/core/experiment'
import { ALGO_LABELS } from '@/core/planners/registry'
import MetricCompareChart, {
  type MetricSeries
} from './MetricCompareChart.vue'

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
const repetitions = ref(10)
const baseSeed = ref(20260920)
const running = ref(false)
const progress = ref({ done: 0, total: 0, label: '' })
const result = ref<BatchResult | null>(null)
const chartType = ref<'bar' | 'radar'>('bar')

const allAlgos = Object.keys(ALGO_LABELS) as AlgoType[]

const metricKeys = [
  '成功率',
  '航程',
  '耗时',
  '威胁',
  '暴露时间',
  '平滑度',
  '满足率',
  '能耗',
  '代价'
]

const series = computed<MetricSeries[]>(() => {
  if (!result.value) return []
  return result.value.summaries.map((s) => ({
    label: ALGO_LABELS[s.algo].split(' ')[0],
    algo: s.algo,
    // 越小越好：成功率/满足率取反（1-rate）使柱状/雷达“越长越优”一致
    values: [
      1 - s.successRate,
      s.distanceMean,
      s.planTimeMean,
      s.exposureMean,
      s.exposureTimeMean,
      s.smoothnessMean,
      100 - s.satisfactionMean,
      s.energyMean,
      s.costMean
    ]
  }))
})

function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function exportReport() {
  if (!result.value) return
  download(
    `uav-experiment-${Date.now()}.json`,
    exportExperimentReport(result.value),
    'application/json'
  )
}
function exportCsv() {
  if (!result.value) return
  download(`uav-runs-${Date.now()}.csv`, exportRunsCsv(result.value), 'text/csv')
}

/** 导出实验配置（可复现） */
function exportConfig() {
  if (!result.value) return
  download(
    `uav-experiment-config-${Date.now()}.json`,
    JSON.stringify(result.value.config, null, 2),
    'application/json'
  )
}

async function runBatch() {
  running.value = true
  result.value = null
  await new Promise((r) => setTimeout(r, 30))

  const config: ExperimentConfig = {
    name: `批量实验-${new Date().toISOString().slice(0, 19)}`,
    createdAt: new Date().toISOString(),
    terrain: JSON.parse(JSON.stringify(scene.terrain)),
    threats: JSON.parse(JSON.stringify(scene.threats)),
    noflyZones: JSON.parse(JSON.stringify(scene.noflyZones)),
    obstacles: JSON.parse(JSON.stringify(scene.obstacles)),
    dynamics: JSON.parse(JSON.stringify(scene.dynamics), (_k, v) =>
      v === Infinity ? 1e9 : v
    ),
    waypoints: JSON.parse(JSON.stringify(scene.waypoints)),
    planParams: JSON.parse(JSON.stringify(scene.planParams)),
    weights: JSON.parse(JSON.stringify(scene.weights)),
    smoothing: sim.smoothing,
    algos: allAlgos.filter((a) => selected.value[a]),
    repetitions: repetitions.value,
    baseSeed: baseSeed.value
  }
  progress.value = {
    done: 0,
    total: config.algos.length * config.repetitions,
    label: ''
  }

  const worker = new PlannerWorker()
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    if (ev.data.type === 'batch-done') {
      result.value = ev.data.result
      progress.value.done = progress.value.total
      running.value = false
      worker.terminate()
    }
  }
  worker.onerror = () => {
    running.value = false
    worker.terminate()
  }
  const req: WorkerRequest = { type: 'batch', config }
  worker.postMessage(req)
  // 进度模拟（Worker 批量为单次响应）
  const timer = window.setInterval(() => {
    if (!running.value) window.clearInterval(timer)
    else
      progress.value.done = Math.min(
        progress.value.total - 1,
        progress.value.done + 1
      )
  }, 120)
}

function pct(v: number) {
  return (v * 100).toFixed(0) + '%'
}
</script>

<template>
  <div>
    <div class="section">
      <div class="section-title">批量实验与指标统计（功能02）</div>
      <p class="tip">
        对勾选算法各用不同随机种子重复规划 N 次，统计
        <b>成功率 / 航程 / 威胁暴露 / 暴露时间 / 规划耗时 / 平滑度 /
        约束满足率 / 能耗</b> 的均值与标准差。固定种子，结果可复现。
      </p>
      <div class="algo-pick">
        <label v-for="a in allAlgos" :key="a" class="pick">
          <input type="checkbox" v-model="selected[a]" />
          {{ ALGO_LABELS[a].split(' ')[0] }}
        </label>
      </div>
      <div class="field" style="grid-template-columns: 88px 1fr">
        <label>重复次数</label>
        <input type="number" min="1" max="50" v-model.number="repetitions" />
      </div>
      <div class="field" style="grid-template-columns: 88px 1fr">
        <label>基础种子</label>
        <input type="number" v-model.number="baseSeed" />
      </div>
      <button class="primary" style="width: 100%; margin-top: 8px" :disabled="running" @click="runBatch">
        {{ running ? `批量运行中 ${progress.done}/${progress.total}` : '🧪 运行批量实验' }}
      </button>
      <div v-if="running" class="progress">
        <div
          class="bar"
          :style="{ width: (progress.total ? progress.done / progress.total : 0) * 100 + '%' }"
        ></div>
      </div>
    </div>

    <div v-if="result" class="section">
      <div class="section-title">
        统计汇总（{{ result.summaries.reduce((a, s) => a + s.runs, 0) }} 次运行，
        总耗时 {{ result.totalWallMs.toFixed(0) }} ms）
      </div>
      <div class="chart-toggle">
        <button :class="{ active: chartType === 'bar' }" @click="chartType = 'bar'">柱状图</button>
        <button :class="{ active: chartType === 'radar' }" @click="chartType = 'radar'">雷达图</button>
      </div>
      <MetricCompareChart
        :metrics="metricKeys"
        :series="series"
        :type="chartType"
        :height="240"
      />
      <p class="tip">柱越长/雷达越靠外表示该指标越优（已统一为“越大越好”口径）。</p>

      <div class="table-wrap">
        <table class="exp-table">
          <thead>
            <tr>
              <th>算法</th>
              <th>成功率</th>
              <th>航程 μ±σ</th>
              <th>耗时 μ±σ</th>
              <th>暴露量</th>
              <th>暴露(s)</th>
              <th>平滑°</th>
              <th>满足率</th>
              <th>能耗</th>
              <th>代价 μ±σ</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in result.summaries" :key="s.algo">
              <td class="algo-name">{{ ALGO_LABELS[s.algo].split(' ')[0] }}</td>
              <td :class="{ good: s.successRate >= 0.9, bad: s.successRate < 0.6 }">
                {{ pct(s.successRate) }}
              </td>
              <td>{{ s.distanceMean.toFixed(0) }}±{{ s.distanceStd.toFixed(0) }}</td>
              <td>{{ s.planTimeMean.toFixed(1) }}±{{ s.planTimeStd.toFixed(1) }}</td>
              <td>{{ s.exposureMean.toFixed(1) }}</td>
              <td>{{ s.exposureTimeMean.toFixed(1) }}</td>
              <td>{{ s.smoothnessMean.toFixed(1) }}</td>
              <td>{{ s.satisfactionMean.toFixed(0) }}%</td>
              <td>{{ s.energyMean.toFixed(2) }}</td>
              <td>{{ s.costMean.toFixed(0) }}±{{ s.costStd.toFixed(0) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="exp-actions">
        <button @click="exportReport">导出指标报告 JSON</button>
        <button @click="exportCsv">导出全部运行 CSV</button>
        <button @click="exportConfig">导出场景/实验配置（复现）</button>
      </div>
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
.algo-pick {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 8px;
  margin-bottom: 8px;
}
.pick {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: var(--text-1);
}
.progress {
  height: 5px;
  background: var(--bg-3);
  border-radius: 3px;
  overflow: hidden;
  margin-top: 8px;
}
.progress .bar {
  height: 100%;
  background: var(--accent);
  transition: width 0.15s;
}
.chart-toggle {
  display: flex;
  gap: 4px;
  margin-bottom: 6px;
}
.chart-toggle button {
  flex: 1;
  padding: 5px;
  font-size: 11px;
}
.chart-toggle button.active {
  background: var(--accent);
  color: #06101f;
}
.table-wrap {
  overflow-x: auto;
  margin-top: 8px;
}
.exp-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 10px;
}
.exp-table th,
.exp-table td {
  border: 1px solid var(--line);
  padding: 4px 5px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.exp-table th {
  color: var(--text-2);
  font-weight: 500;
}
.algo-name {
  text-align: left !important;
  color: var(--text-0);
}
.good {
  color: var(--ok);
  font-weight: 700;
}
.bad {
  color: var(--danger);
  font-weight: 700;
}
.exp-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.exp-actions button {
  flex: 1;
  min-width: 120px;
  padding: 6px;
  font-size: 11px;
}
</style>
