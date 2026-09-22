<script setup lang="ts">
import { computed } from 'vue'
import { useSimStore } from '@/stores/sim'
import { useSceneStore } from '@/stores/scene'

const sim = useSimStore()
const scene = useSceneStore()

const speedOptions = [0.5, 1, 2, 4, 8]

const progressPct = computed(() => sim.progress * 100)
const fmtTime = (t: number) => {
  const m = Math.floor(t / 60)
  const s = (t % 60).toFixed(1).padStart(4, '0')
  return `${m}:${s}`
}

const currentSpeed = computed(() => {
  const s = sim.sampleAt(sim.simTime)
  return s ? s.speed : 0
})

const coveredDist = computed(() => {
  const s = sim.sampleAt(sim.simTime)
  return s ? s.s : 0
})

async function replan() {
  await sim.plan()
}
</script>

<template>
  <div class="playback">
    <div class="left">
      <button
        class="primary"
        :disabled="sim.status === 'planning' || sim.trajectory.length < 2"
        @click="sim.togglePlay()"
        :title="'空格播放/暂停'"
      >
        {{ sim.playing ? '⏸ 暂停' : '▶ 播放' }}
      </button>
      <button :disabled="sim.trajectory.length < 2" @click="sim.seek(0)" title="回到起点">⏮</button>
      <button :disabled="sim.trajectory.length < 2" @click="sim.stepFrame(-1)" title="后退 1 秒">⏪</button>
      <button :disabled="sim.trajectory.length < 2" @click="sim.stepFrame(1)" title="前进 1 秒">⏩</button>
      <button
        :class="{ active: sim.loop }"
        title="循环回放"
        @click="sim.toggleLoop()"
      >
        🔁
      </button>
      <button
        v-for="v in speedOptions"
        :key="v"
        :class="{ active: sim.playbackSpeed === v }"
        @click="sim.setPlaybackSpeed(v)"
      >
        {{ v }}×
      </button>
      <button
        :disabled="sim.status === 'planning'"
        @click="replan"
        title="基于当前场景与参数重新执行全局规划"
      >
        ↻ 重新规划
      </button>
      <button
        :class="{ active: sim.onlineReplan }"
        title="回放过程中遇到移动障碍/突发威胁时自动局部重规划"
        @click="sim.onlineReplan = !sim.onlineReplan"
      >
        🛰 在线{{ sim.onlineReplan ? '开' : '关' }}
      </button>
    </div>

    <div class="center">
      <span class="t">{{ fmtTime(sim.simTime) }}</span>
      <input
        class="scrub"
        type="range"
        min="0"
        :max="Math.max(sim.duration, 0.01)"
        step="0.05"
        :value="sim.simTime"
        @input="sim.seek(Number(($event.target as HTMLInputElement).value))"
      />
      <span class="t">{{ fmtTime(sim.duration) }}</span>
    </div>

    <div class="right">
      <span class="mini">航程 {{ coveredDist.toFixed(0) }} m</span>
      <span class="mini">速度 {{ currentSpeed.toFixed(1) }} m/s</span>
      <span class="mini">巡航 {{ scene.planParams.speedMin }}~{{ scene.planParams.speedMax }} m/s</span>
    </div>
  </div>
</template>

<style scoped>
.playback {
  grid-column: 2 / 4;
  background: var(--bg-1);
  border-top: 1px solid var(--line);
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 14px;
  padding: 8px 14px;
}
.left,
.right {
  display: flex;
  gap: 6px;
  align-items: center;
}
.center {
  display: flex;
  align-items: center;
  gap: 10px;
}
.scrub {
  flex: 1;
}
.t {
  font-variant-numeric: tabular-nums;
  color: var(--text-1);
  font-size: 12px;
  min-width: 52px;
  text-align: center;
}
.mini {
  color: var(--text-2);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
</style>
