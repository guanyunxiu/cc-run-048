<script setup lang="ts">
import { ref } from 'vue'
import { useSceneStore } from '@/stores/scene'
import { useSimStore } from '@/stores/sim'
import EditPanel from './EditPanel.vue'
import PlanPanel from './PlanPanel.vue'
import StatsPanel from './StatsPanel.vue'
import ComparePanel from './ComparePanel.vue'
import ParetoPanel from './ParetoPanel.vue'
import ExperimentPanel from './ExperimentPanel.vue'
import FleetPanel from './FleetPanel.vue'
import PerfPanel from './PerfPanel.vue'
import type { SerializedScene } from '@/types'
import { Environment } from '@/core/environment'

const scene = useSceneStore()
const sim = useSimStore()
const tab = ref<'edit' | 'plan' | 'pareto' | 'compare' | 'experiment' | 'fleet' | 'stats' | 'perf'>('plan')
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

/** 导出航迹 CSV（编号,x,y,z），迭代三增加速度/时间/能耗列 */
function exportPathCsv() {
  if (sim.smoothPath.length === 0) return
  const rows = ['index,x,y,z']
  sim.smoothPath.forEach((p, i) => rows.push(`${i},${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`))
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'uav-path.csv'
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
  scene.resetScene()
}
</script>

<template>
  <div class="panel">
    <div class="action-bar">
      <button class="primary" :disabled="sim.status === 'planning'" @click="runPlan">
        {{ sim.status === 'planning' ? '规划中…' : '⚡ 执行规划' }}
      </button>
      <button @click="exportJson" title="导出场景配置 JSON（v3.0，含编队/传感器）">导出</button>
      <button @click="exportPathCsv" :disabled="sim.smoothPath.length === 0" title="导出航迹 CSV">CSV</button>
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
      <div class="tab" :class="{ active: tab === 'edit' }" @click="tab = 'edit'">环境编辑</div>
      <div class="tab" :class="{ active: tab === 'plan' }" @click="tab = 'plan'">规划/约束</div>
      <div class="tab accent" :class="{ active: tab === 'pareto' }" @click="tab = 'pareto'">多目标</div>
      <div class="tab" :class="{ active: tab === 'compare' }" @click="tab = 'compare'">算法对比</div>
      <div class="tab accent" :class="{ active: tab === 'experiment' }" @click="tab = 'experiment'">批量实验</div>
      <div class="tab accent" :class="{ active: tab === 'fleet' }" @click="tab = 'fleet'">多机编队</div>
      <div class="tab" :class="{ active: tab === 'stats' }" @click="tab = 'stats'">仿真评估</div>
      <div class="tab accent" :class="{ active: tab === 'perf' }" @click="tab = 'perf'">性能/工程</div>
    </div>

    <div class="panel-body">
      <EditPanel v-show="tab === 'edit'" />
      <PlanPanel v-show="tab === 'plan'" />
      <ParetoPanel v-show="tab === 'pareto'" />
      <ComparePanel v-show="tab === 'compare'" />
      <ExperimentPanel v-show="tab === 'experiment'" />
      <FleetPanel v-show="tab === 'fleet'" />
      <StatsPanel v-show="tab === 'stats'" />
      <PerfPanel v-show="tab === 'perf'" />
    </div>

    <div class="footer-bar">
      <label class="chk">
        <input type="checkbox" v-model="sim.showThreatHeatmap" />
        地形威胁热力
      </label>
      <span class="ver">UAV Path Sim v3.0 · WebGL2 / WebGPU</span>
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
.tabs-wrap {
  flex-wrap: wrap;
}
.tab.accent {
  color: var(--accent-2);
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
</style>
