<script setup lang="ts">
import { ref } from 'vue'
import { useSceneStore } from '@/stores/scene'
import { useSimStore } from '@/stores/sim'
import { useEngineStore } from '@/stores/engine'
import { useFleetStore } from '@/stores/fleet'
import EditPanel from './EditPanel.vue'
import PlanPanel from './PlanPanel.vue'
import StatsPanel from './StatsPanel.vue'
import ComparePanel from './ComparePanel.vue'
import MultiObjectivePanel from './MultiObjectivePanel.vue'
import ExperimentPanel from './ExperimentPanel.vue'
import FleetPanel from './FleetPanel.vue'
import PerformancePanel from './PerformancePanel.vue'
import type { SerializedScene } from '@/types'
import { Environment } from '@/core/environment'

const scene = useSceneStore()
const sim = useSimStore()
const engine = useEngineStore()
const fleet = useFleetStore()
type Tab =
  | 'edit'
  | 'plan'
  | 'multi'
  | 'compare'
  | 'experiment'
  | 'fleet'
  | 'stats'
  | 'perf'
const tab = ref<Tab>('plan')
const fileInput = ref<HTMLInputElement | null>(null)

async function runPlan() {
  await sim.plan()
  tab.value = 'stats'
}

function exportJson() {
  const data = sim.exportScene()
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json'
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `uav-scene-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
  a.click()
  URL.revokeObjectURL(url)
}

/** 导出航迹 CSV（编号,x,y,z） */
function exportPathCsv() {
  if (sim.smoothPath.length === 0) return
  const rows = ['index,x,y,z']
  sim.smoothPath.forEach((p, i) => rows.push(`${i},${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`))
  const blob = new Blob([rows.join('\n'), ], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'uav-path.csv'
  a.click()
  URL.revokeObjectURL(url)
}

/** 导出规划日志（指标/代价/重规划事件，文本） */
function exportLog() {
  const lines: string[] = []
  lines.push(`# 规划日志 ${new Date().toISOString()}`)
  lines.push(`算法: ${sim.stats?.algo} 平滑: ${sim.stats?.smoothing}`)
  lines.push(
    `成功: ${sim.stats?.success} 航程: ${sim.stats?.distance} 耗时: ${sim.stats?.planTimeMs}ms`
  )
  lines.push(`威胁暴露: ${sim.stats?.threatExposure} 暴露时间: ${sim.stats?.exposureTime}s`)
  lines.push(`总代价: ${sim.stats?.totalCost}`)
  if (sim.stats?.objectives) {
    lines.push('七维目标: ' + JSON.stringify(sim.stats.objectives))
  }
  if (sim.stats?.costBreakdown) {
    lines.push('代价分量: ' + JSON.stringify(sim.stats.costBreakdown))
  }
  lines.push(`在线重规划次数: ${sim.replanEvents.length}`)
  sim.replanEvents.forEach((e, i) => {
    lines.push(
      `[${i + 1}] t=${e.time.toFixed(2)}s ${e.reason} ${e.detail} 代价 ${e.costBefore}->${e.costAfter} ${e.planMs.toFixed(1)}ms`
    )
  })
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'uav-plan-log.txt'
  a.click()
  URL.revokeObjectURL(url)
}

function triggerImport() {
  fileInput.value?.click()
}

function importJson(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = async () => {
    try {
      const data = JSON.parse(String(reader.result)) as SerializedScene
      if (!data.terrain || !Array.isArray(data.waypoints)) {
        throw new Error('配置格式不正确')
      }
      sim.clearPlan()
      scene.loadScene(data)
      // 迭代三：恢复编队与图层
      if (data.fleet) fleet.spec = data.fleet
      else fleet.resetFleet()
      if (data.viewLayers) engine.layers = data.viewLayers
      sim.message = `已导入场景：${data.exportedAt ?? file.name}`
      if (data.smoothPath && data.smoothPath.length >= 2 && data.stats) {
        const env = new Environment(
          scene.terrain,
          scene.threats,
          scene.noflyZones,
          scene.obstacles
        )
        sim.applyPlanResult(
          {
            success: data.stats.success,
            rawPath: data.rawPath ?? data.smoothPath,
            smoothPath: data.smoothPath,
            stats: data.stats,
            legs: [],
            message: '导入航迹'
          },
          scene.planParams,
          scene.weights,
          env
        )
      }
    } catch (e) {
      sim.message = `导入失败：${(e as Error).message}`
    }
  }
  reader.readAsText(file)
  input.value = ''
}

function resetAll() {
  if (!confirm('确定恢复默认场景？当前编辑将丢失。')) return
  sim.clearPlan()
  engine.clearFleet()
  fleet.resetFleet()
  scene.resetScene()
}
</script>

<template>
  <div class="panel">
    <div class="action-bar">
      <button class="primary" :disabled="sim.status === 'planning'" @click="runPlan">
        {{ sim.status === 'planning' ? '规划中…' : '⚡ 执行规划' }}
      </button>
      <button @click="exportJson" title="导出场景配置 JSON（v3.0）">导出</button>
      <button @click="exportPathCsv" :disabled="sim.smoothPath.length === 0" title="导出航迹 CSV">CSV</button>
      <button @click="exportLog" title="导出规划日志">日志</button>
      <button @click="triggerImport">导入</button>
      <button class="danger" @click="resetAll">重置</button>
      <input
        ref="fileInput"
        type="file"
        accept="application/json,.json"
        style="display: none"
        @change="importJson"
      />
    </div>

    <div class="tabs tabs-wrap">
      <div class="tab" :class="{ active: tab === 'edit' }" @click="tab = 'edit'">环境</div>
      <div class="tab" :class="{ active: tab === 'plan' }" @click="tab = 'plan'">规划</div>
      <div class="tab" :class="{ active: tab === 'multi' }" @click="tab = 'multi'">多目标</div>
      <div class="tab" :class="{ active: tab === 'compare' }" @click="tab = 'compare'">对比</div>
      <div class="tab" :class="{ active: tab === 'experiment' }" @click="tab = 'experiment'">批量实验</div>
      <div class="tab" :class="{ active: tab === 'fleet' }" @click="tab = 'fleet'">多机</div>
      <div class="tab" :class="{ active: tab === 'stats' }" @click="tab = 'stats'">评估</div>
      <div class="tab" :class="{ active: tab === 'perf' }" @click="tab = 'perf'">性能</div>
    </div>

    <div class="panel-body">
      <EditPanel v-show="tab === 'edit'" />
      <PlanPanel v-show="tab === 'plan'" />
      <MultiObjectivePanel v-show="tab === 'multi'" />
      <ComparePanel v-show="tab === 'compare'" />
      <ExperimentPanel v-show="tab === 'experiment'" />
      <FleetPanel v-show="tab === 'fleet'" />
      <StatsPanel v-show="tab === 'stats'" />
      <PerformancePanel v-show="tab === 'perf'" />
    </div>

    <div class="footer-bar">
      <label class="chk">
        <input type="checkbox" v-model="sim.showThreatHeatmap" />
        地形威胁热力
      </label>
      <span class="ver">UAV Path Sim v3.0 · {{ engine.backend.toUpperCase() }} · Web Worker</span>
    </div>
  </div>
</template>

<style scoped>
.action-bar {
  display: flex;
  gap: 5px;
  padding: 9px 10px;
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
}
.footer-bar {
  border-top: 1px solid var(--line);
  padding: 8px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.chk {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-1);
  font-size: 12px;
}
.ver {
  color: var(--text-2);
  font-size: 10px;
}
.tabs-wrap {
  flex-wrap: wrap;
}
</style>
