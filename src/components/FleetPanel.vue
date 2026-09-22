<script setup lang="ts">
import { useSceneStore } from '@/stores/scene'
import { useSimStore } from '@/stores/sim'
import { useFleetStore } from '@/stores/fleet'
import { ALGO_LABELS } from '@/core/planners/registry'
import type { AlgoType } from '@/types'

const scene = useSceneStore()
const sim = useSimStore()
const fleet = useFleetStore()

const algos = Object.keys(ALGO_LABELS) as AlgoType[]

function toggle() {
  fleet.setEnabled(!fleet.enabled)
  if (fleet.enabled) void fleet.planAll(sim.smoothing)
}

async function replan() {
  await fleet.planAll(sim.smoothing)
}

function playFleet() {
  if (!fleet.activeTracks.length) return
  sim.seek(0)
  sim.play()
}
</script>

<template>
  <div>
    <div class="section">
      <div class="section-title">多无人机同时仿真（功能03）</div>
      <p class="tip">
        多架无人机独立任务/算法，<b>Worker 池并行规划</b>，统一时钟同时回放；
        自动检测机间冲突（安全间隔 30m）。
      </p>
      <button class="primary" style="width: 100%" @click="toggle">
        {{ fleet.enabled ? '关闭编队模式' : '🛩 启用多无人机编队（3 机）' }}
      </button>
      <div v-if="fleet.enabled" class="field-row" style="margin-top: 8px">
        <button @click="replan" :disabled="fleet.planning">
          {{ fleet.planning ? `并行规划 ${(fleet.progress * 100).toFixed(0)}%` : '↻ 并行重规划' }}
        </button>
        <button @click="fleet.addTrack">+ 增加无人机</button>
        <button @click="playFleet" :disabled="!fleet.activeTracks.length">▶ 同时播放</button>
      </div>
    </div>

    <div v-if="fleet.enabled" class="section">
      <div class="section-title">编队成员（{{ fleet.tracks.length }}）</div>
      <div v-for="t in fleet.tracks" :key="t.id" class="uav-row">
        <div class="uav-head">
          <i :style="{ background: t.color }"></i>
          <input v-model="t.name" class="uav-name" />
          <button class="x" @click="fleet.removeTrack(t.id)" title="删除">✕</button>
        </div>
        <div class="field-row">
          <label>算法</label>
          <select :value="t.algo" @change="fleet.setAlgo(t.id, ($event.target as HTMLSelectElement).value as AlgoType)">
            <option v-for="a in algos" :key="a" :value="a">{{ ALGO_LABELS[a].split(' ')[0] }}</option>
          </select>
        </div>
        <div class="uav-stat">
          <span :class="{ ok: t.success, fail: t.success === false }">
            {{ t.success === undefined ? '未规划' : t.success ? '✓ 可行' : '✗ 失败' }}
          </span>
          <span v-if="t.distance !== undefined">航程 {{ t.distance.toFixed(0) }}m</span>
          <span v-if="t.planTimeMs !== undefined">{{ t.planTimeMs.toFixed(0) }}ms</span>
        </div>
      </div>
    </div>

    <div v-if="fleet.enabled" class="section">
      <div class="section-title">传感器 / 探测 / 通信（功能03）</div>
      <label class="checkbox"><input type="checkbox" v-model="scene.sensor.showSensor" />显示传感器范围（球）</label>
      <label class="checkbox"><input type="checkbox" v-model="scene.sensor.showDetection" />显示探测范围（地面环）</label>
      <label class="checkbox"><input type="checkbox" v-model="scene.sensor.showComm" />显示机间通信链路</label>
      <div class="field-row"><label>传感器半径</label>
        <input type="number" v-model.number="scene.sensor.sensorRange" min="20" max="500" step="10" />
      </div>
      <div class="field-row"><label>探测半径</label>
        <input type="number" v-model.number="scene.sensor.detectionRange" min="50" max="800" step="10" />
      </div>
      <div class="field-row"><label>通信半径</label>
        <input type="number" v-model.number="scene.sensor.commRange" min="100" max="2000" step="20" />
      </div>
    </div>

    <div v-if="fleet.enabled && fleet.conflicts.length > 0" class="section">
      <div class="section-title">机间冲突告警（{{ fleet.conflicts.length }}）</div>
      <div v-for="(c, i) in fleet.conflicts" :key="i" class="conflict">
        回放 {{ (c.time * 100).toFixed(0) }}% ·
        {{ fleet.tracks.find((x) => x.id === c.a)?.name ?? c.a }} ↔
        {{ fleet.tracks.find((x) => x.id === c.b)?.name ?? c.b }} ·
        间距 {{ c.distance }}m
      </div>
    </div>
  </div>
</template>

<style scoped>
.tip { color: var(--text-2); font-size: 11px; line-height: 1.6; margin: 4px 0 8px; }
.field-row { display: flex; gap: 8px; align-items: center; font-size: 12px; margin-top: 6px; }
.checkbox { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--text-1); margin-bottom: 4px; }
.uav-row {
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 8px;
  margin-bottom: 6px;
}
.uav-head { display: flex; align-items: center; gap: 6px; }
.uav-head i { width: 10px; height: 10px; border-radius: 50%; }
.uav-name { flex: 1; background: transparent; border: none; color: var(--text-0); font-size: 12px; font-weight: 600; }
.x { background: none; border: none; color: var(--text-2); cursor: pointer; }
.uav-stat { display: flex; gap: 10px; font-size: 10px; color: var(--text-2); margin-top: 4px; }
.ok { color: var(--ok); }
.fail { color: var(--danger); }
.conflict {
  font-size: 11px;
  color: var(--danger);
  background: rgba(255,45,85,0.08);
  border-radius: 4px;
  padding: 3px 6px;
  margin-bottom: 3px;
}
</style>
