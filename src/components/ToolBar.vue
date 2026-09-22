<script setup lang="ts">
import { useSceneStore } from '@/stores/scene'
import { useSimStore } from '@/stores/sim'
import type { CameraMode, EditMode } from '@/types'

const scene = useSceneStore()
const sim = useSimStore()

const editButtons: { mode: EditMode; icon: string; title: string }[] = [
  { mode: 'select', icon: '▣', title: '选择/拖拽（Esc）' },
  { mode: 'add-threat', icon: '◎', title: '添加威胁区：在地形上点击' },
  { mode: 'add-nofly', icon: '⊘', title: '添加禁飞区：在地形上点击' },
  { mode: 'add-obstacle', icon: '■', title: '添加建筑障碍' },
  { mode: 'add-dynamic', icon: '➰', title: '添加移动障碍物（在线重规划演示）' },
  { mode: 'add-waypoint', icon: '⚑', title: '添加途经航点' }
]

const cameraButtons: { mode: CameraMode; icon: string; title: string }[] = [
  { mode: 'orbit', icon: '✥', title: '旋转/缩放/平移（左键旋转，右键平移，滚轮缩放）' },
  { mode: 'top', icon: '▦', title: '俯视视角' },
  { mode: 'follow', icon: '➤', title: '跟随无人机视角' }
]

function setEdit(mode: EditMode) {
  scene.setEditMode(scene.editMode === mode && mode !== 'select' ? 'select' : mode)
}

/** 在无人机前方放置一个立即激活的突发威胁（功能02 演示） */
function spawnSuddenThreat() {
  const s = sim.sampleAt(sim.simTime)
  const base = s?.position ?? scene.startPoint?.position ?? { x: 0, y: 100, z: 0 }
  // 前方 120m
  const yaw = sim.droneHeading
  const p = {
    x: base.x + Math.sin(yaw + 0.3) * 120,
    y: 0,
    z: base.z + Math.cos(yaw + 0.3) * 120
  }
  const id = scene.addSuddenThreatAt(p)
  scene.updateDynamic(id, { enableAt: sim.simTime, active: true, name: '突发威胁-即时' })
  if (!sim.playing) sim.play()
}
</script>

<template>
  <div class="toolbar">
    <div class="logo">UAV2</div>
    <div
      v-for="b in editButtons"
      :key="b.mode"
      class="tool"
      :class="{ active: scene.editMode === b.mode }"
      :title="b.title"
      @click="setEdit(b.mode)"
    >
      {{ b.icon }}
    </div>
    <div class="tool" title="在无人机前方投放即时突发威胁（回放时触发在线重规划）" @click="spawnSuddenThreat">
      💥
    </div>
    <div class="sep"></div>
    <div
      v-for="b in cameraButtons"
      :key="b.mode"
      class="tool"
      :class="{ active: sim.cameraMode === b.mode }"
      :title="b.title"
      @click="sim.setCameraMode(b.mode)"
    >
      {{ b.icon }}
    </div>
  </div>
</template>

<style scoped>
.toolbar {
  background: var(--bg-1);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 0;
}
.logo {
  font-weight: 800;
  font-size: 11px;
  color: var(--accent);
  margin-bottom: 10px;
  letter-spacing: 1px;
}
.tool {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  border-radius: 8px;
  color: var(--text-1);
  cursor: pointer;
  user-select: none;
}
.tool:hover {
  background: var(--bg-3);
  color: var(--text-0);
}
.tool.active {
  background: var(--accent);
  color: #06101f;
}
.sep {
  width: 26px;
  height: 1px;
  background: var(--line);
  margin: 6px 0;
}
</style>
