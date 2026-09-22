<script setup lang="ts">
import { computed } from 'vue'
import { useFleetStore } from '@/stores/fleet'
import { useEngineStore } from '@/stores/engine'
import { useSceneStore } from '@/stores/scene'
import type { DroneSpec } from '@/types'

const fleet = useFleetStore()
const engine = useEngineStore()
const scene = useSceneStore()

const runtimes = computed(() => engine.fleetRuntimes)

function addDrone() {
  const n = fleet.spec.drones.length
  fleet.addDrone({
    waypoints: [
      {
        id: `d${n}-s`,
        role: 'start',
        position: { x: -400 - n * 20, y: 120 + n * 20, z: -200 + n * 60 },
        speed: 30
      },
      {
        id: `d${n}-e`,
        role: 'end',
        position: { x: 400, y: 120, z: 200 - n * 60 },
        speed: 30
      }
    ]
  })
}

function updateWaypoint(d: DroneSpec, idx: number, axis: 'x' | 'y' | 'z', v: number) {
  d.waypoints[idx].position[axis] = v
}

const separationWarn = computed(
  () => engine.fleetActive && isFinite(engine.fleetMinSeparation) && engine.fleetMinSeparation < 30
)
</script>

<template>
  <div>
    <div class="section">
      <div class="section-title">多无人机同时仿真（功能03）</div>
      <p class="tip">
        每架无人机独立任务/算法/起飞时刻，共享同一环境与威胁场，统一时间轴回放。
        实时显示机间安全间隔与通信链路。
      </p>
      <div class="fleet-actions">
        <button class="primary" :disabled="fleet.planning" @click="fleet.plan()">
          {{ fleet.planning ? '编队规划中…' : '🛩 编队规划' }}
        </button>
        <button @click="addDrone">＋ 加机</button>
        <button @click="fleet.resetFleet()">默认编队</button>
      </div>
      <div v-if="fleet.message" class="fleet-msg">{{ fleet.message }}</div>
    </div>

    <div class="section">
      <div class="section-title">图层与范围可视化</div>
      <label class="chk">
        <input type="checkbox" v-model="engine.layers.showSensorRange" />
        传感器探测范围
      </label>
      <label class="chk">
        <input type="checkbox" v-model="engine.layers.showCommRange" />
        通信范围
      </label>
      <label class="chk">
        <input type="checkbox" v-model="engine.layers.showCommLinks" />
        通信链路（范围内互联）
      </label>
      <label class="chk">
        <input type="checkbox" :checked="engine.fleetActive" @change="engine.clearFleet()" />
        隐藏编队航迹
      </label>
    </div>

    <div class="section" v-if="engine.fleetActive">
      <div class="section-title">编队状态</div>
      <div
        class="sep-card"
        :class="{ warn: separationWarn }"
      >
        最近机间间隔：
        <b>{{ isFinite(engine.fleetMinSeparation) ? engine.fleetMinSeparation.toFixed(1) + ' m' : '—' }}</b>
        <span v-if="separationWarn" class="warn-tag">⚠ 间隔过小</span>
      </div>
      <div v-for="(rt, i) in runtimes" :key="rt.spec.id" class="rt-row">
        <span class="dot" :style="{ background: rt.spec.color }"></span>
        <span class="rt-name">{{ rt.spec.name }}</span>
        <span :class="{ fail: rt.path.length < 2 }">
          {{ rt.path.length >= 2 ? `时长 ${rt.duration.toFixed(1)}s` : '规划失败' }}
        </span>
      </div>
    </div>

    <div class="section">
      <div class="section-title">机队配置（{{ fleet.spec.drones.length }} 架）</div>
      <div v-for="(d, di) in fleet.spec.drones" :key="d.id" class="drone-card">
        <div class="dc-head">
          <input type="color" v-model="d.color" class="color" />
          <input v-model="d.name" class="name" />
          <button class="del" @click="fleet.removeDrone(d.id)">✕</button>
        </div>
        <div class="dc-grid">
          <label>起飞延迟 {{ d.launchDelay.toFixed(0) }}s
            <input type="range" min="0" max="10" step="0.5" v-model.number="d.launchDelay" />
          </label>
          <label>探测 {{ d.sensorRange }}m
            <input type="range" min="40" max="300" step="10" v-model.number="d.sensorRange" />
          </label>
          <label>通信 {{ d.commRange }}m
            <input type="range" min="100" max="600" step="10" v-model.number="d.commRange" />
          </label>
        </div>
        <div v-for="(wp, wi) in d.waypoints" :key="wp.id" class="wp-row">
          <span class="wp-role">{{ wp.role === 'start' ? '起' : wp.role === 'end' ? '终' : '途' }}</span>
          <input
            type="number"
            :value="wp.position.x"
            @input="updateWaypoint(d, wi, 'x', Number(($event.target as HTMLInputElement).value))"
          />
          <input
            type="number"
            :value="wp.position.y"
            @input="updateWaypoint(d, wi, 'y', Number(($event.target as HTMLInputElement).value))"
          />
          <input
            type="number"
            :value="wp.position.z"
            @input="updateWaypoint(d, wi, 'z', Number(($event.target as HTMLInputElement).value))"
          />
        </div>
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
.fleet-actions {
  display: flex;
  gap: 6px;
}
.fleet-actions button {
  flex: 1;
  padding: 7px;
  font-size: 11px;
}
.fleet-msg {
  font-size: 11px;
  color: var(--text-2);
  margin-top: 6px;
}
.chk {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: var(--text-1);
  margin-bottom: 5px;
}
.sep-card {
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 8px;
  font-size: 12px;
  margin-bottom: 6px;
}
.sep-card.warn {
  border-color: var(--danger);
  color: var(--danger);
}
.warn-tag {
  margin-left: 8px;
}
.rt-row {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 11px;
  padding: 3px 0;
}
.rt-row .dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
}
.rt-name {
  flex: 1;
  color: var(--text-0);
}
.rt-row .fail {
  color: var(--danger);
}
.drone-card {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 7px;
  margin-bottom: 8px;
  background: var(--bg-2);
}
.dc-head {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 6px;
}
.dc-head .color {
  width: 28px;
  height: 22px;
  padding: 0;
  border: none;
  background: none;
}
.dc-head .name {
  flex: 1;
  min-width: 0;
}
.dc-head .del {
  width: 24px;
}
.dc-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 6px;
  font-size: 10px;
  color: var(--text-2);
  margin-bottom: 6px;
}
.dc-grid input {
  width: 100%;
}
.wp-row {
  display: grid;
  grid-template-columns: 24px 1fr 1fr 1fr;
  gap: 4px;
  align-items: center;
  margin-bottom: 3px;
}
.wp-role {
  font-size: 10px;
  color: var(--text-2);
  text-align: center;
}
.wp-row input {
  width: 100%;
  padding: 3px;
  font-size: 10px;
}
</style>
