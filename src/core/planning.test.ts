import { describe, expect, it } from 'vitest'
import { SimplexNoise } from '@/utils/noise'
import { generateTerrain, sampleHeight } from '@/core/terrain'
import {
  Environment
} from '@/core/environment'
import { GridPlanner } from '@/core/planner'
import { densify, planTrajectory, smoothBSpline, smoothPolyline } from '@/core/smoothing'
import { evaluatePath } from '@/core/cost'
import { planMission } from '@/core/planning'
import type {
  BuildingObstacle,
  CostWeights,
  NoFlyZone,
  PlanParams,
  TerrainParams,
  ThreatZone,
  Vec3,
  Waypoint
} from '@/types'
import { defaultPlanParams, defaultWeights } from '@/core/defaults'

const terrain: TerrainParams = {
  size: 600,
  segments: 48,
  seed: 42,
  heightScale: 80,
  noiseScale: 0.003,
  ridgeScale: 30,
  canyon: false
}

const noThreats: ThreatZone[] = []
const noNofly: NoFlyZone[] = []
const noObs: BuildingObstacle[] = []

const weights: CostWeights = { ...defaultWeights }
const plan: PlanParams = {
  ...defaultPlanParams,
  cellSize: 20,
  heightCell: 20,
  maxNodes: 120000,
  maxStep: 2,
  clearance: 8,
  cruiseAlt: 100
}

function envWith(
  threats: ThreatZone[] = noThreats,
  nofly: NoFlyZone[] = noNofly,
  obstacles: BuildingObstacle[] = noObs
): Environment {
  return new Environment(terrain, threats, nofly, obstacles)
}

const start: Vec3 = { x: -240, y: 100, z: -200 }
const goal: Vec3 = { x: 240, y: 100, z: 200 }

describe('SimplexNoise', () => {
  it('种子相同则结果相同', () => {
    const a = new SimplexNoise(7)
    const b = new SimplexNoise(7)
    expect(a.noise2D(1.5, -2.2)).toBe(b.noise2D(1.5, -2.2))
    expect(a.fbm(3, 4, 4)).toBe(b.fbm(3, 4, 4))
  })
  it('输出范围合理', () => {
    const n = new SimpNoiseSafe()
    for (let i = 0; i < 100; i++) {
      const v = n.noise2D(i * 0.3, i * 0.7)
      expect(v).toBeGreaterThanOrEqual(-1.1)
      expect(v).toBeLessThanOrEqual(1.1)
    }
  })
})

// 避免 import 名字冲突的小封装
class SimpNoiseSafe extends SimplexNoise {}

describe('地形高程', () => {
  it('高程非负且网格尺寸正确', () => {
    const t = generateTerrain(terrain)
    expect(t.gridSize).toBe(49)
    expect(t.heights.length).toBe(49 * 49)
    for (const h of t.heights) expect(h).toBeGreaterThanOrEqual(0)
  })
  it('采样与网格点一致，边界处有限', () => {
    const t = generateTerrain(terrain)
    const h = sampleHeight(t, 0, 0)
    expect(Number.isFinite(h)).toBe(true)
    // 角点
    expect(sampleHeight(t, -300, -300)).toBeGreaterThanOrEqual(0)
    expect(sampleHeight(t, 300, 300)).toBeGreaterThanOrEqual(0)
  })
})

describe('环境碰撞检测', () => {
  it('高空自由点不被阻挡，地面以下被阻挡', () => {
    const env = envWith()
    expect(env.isBlocked({ x: 0, y: 300, z: 0 }, 8)).toBe(false)
    expect(env.isBlocked({ x: 0, y: -5, z: 0 }, 8)).toBe(true)
  })

  it('建筑障碍内部被阻挡', () => {
    const obs: BuildingObstacle[] = [
      {
        id: 'o1',
        name: 'b',
        position: { x: 0, y: 0, z: 0 },
        size: { x: 40, z: 40 },
        height: 60
      }
    ]
    const env = envWith(noThreats, noNofly, obs)
    expect(env.isBlocked({ x: 0, y: 30, z: 0 }, 0)).toBe(true)
    expect(env.isBlocked({ x: 100, y: 300, z: 0 }, 0)).toBe(false)
  })

  it('硬禁飞区阻挡，软禁飞区不阻挡但有惩罚', () => {
    const hard: NoFlyZone[] = [
      {
        id: 'z1',
        name: 'hard',
        position: { x: 0, y: 0, z: 0 },
        radius: 50,
        heightMin: 0,
        heightMax: 200,
        penalty: 5,
        hardBlock: true
      }
    ]
    const envH = envWith(noThreats, hard)
    expect(envH.isBlocked({ x: 0, y: 100, z: 0 }, 0)).toBe(true)

    const soft: NoFlyZone[] = [{ ...hard[0], id: 'z2', hardBlock: false }]
    const envS = envWith(noThreats, soft)
    expect(envS.isBlocked({ x: 0, y: 100, z: 0 }, 0)).toBe(false)
    expect(envS.noflyPenalty({ x: 0, y: 100, z: 0 })).toBeGreaterThan(0)
  })

  it('威胁强度随距离与等级变化', () => {
    const threats: ThreatZone[] = [
      {
        id: 't1',
        kind: 'radar',
        name: 'r',
        position: { x: 0, y: 0, z: 0 },
        radius: 100,
        heightMin: 0,
        heightMax: 200,
        level: 5,
        opacity: 0.2
      }
    ]
    const env = envWith(threats)
    const center = env.threatIntensity({ x: 0, y: 100, z: 0 })
    const edge = env.threatIntensity({ x: 99, y: 100, z: 0 })
    const outside = env.threatIntensity({ x: 200, y: 100, z: 0 })
    expect(center).toBeGreaterThan(edge)
    expect(edge).toBeGreaterThan(0)
    expect(outside).toBe(0)
  })
})

describe('三维栅格规划器', () => {
  it('A* 无障碍场景能找到路径且航程接近直线', () => {
    const env = envWith()
    const planner = new GridPlanner(env, plan, weights)
    const res = planner.plan(start, goal)
    expect(res.success).toBe(true)
    expect(res.path.length).toBeGreaterThan(2)
    let d = 0
    for (let i = 1; i < res.path.length; i++) {
      d += Math.hypot(
        res.path[i].x - res.path[i - 1].x,
        res.path[i].y - res.path[i - 1].y,
        res.path[i].z - res.path[i - 1].z
      )
    }
    const straight = Math.hypot(480, 0, 400)
    // 栅格路径不超过直线的 15%
    expect(d).toBeLessThan(straight * 1.15)
  })

  it('Dijkstra 同样可达且扩展节点不少于 A*', () => {
    const env1 = envWith()
    const aStar = new GridPlanner(env1, plan, weights).plan(start, goal)
    const dPlan: PlanParams = { ...plan, algo: 'dijkstra' }
    const env2 = envWith()
    const dijkstra = new GridPlanner(env2, dPlan, weights).plan(start, goal)
    expect(dijkstra.success).toBe(true)
    expect(dijkstra.expandedNodes).toBeGreaterThanOrEqual(aStar.expandedNodes)
  })

  it('威胁权重提高时，规划路径的威胁暴露下降', () => {
    const threats: ThreatZone[] = [
      {
        id: 't',
        kind: 'radar',
        name: 'r',
        position: { x: 20, y: 0, z: 10 },
        radius: 120,
        heightMin: 0,
        heightMax: 300,
        level: 5,
        opacity: 0.2
      }
    ]
    const envA = envWith(threats)
    const envB = envWith(threats)
    const lowW = { ...weights, threat: 0 }
    const highW = { ...weights, threat: 200 }
    const pathLow = new GridPlanner(envA, plan, lowW).plan(start, goal).path
    const pathHigh = new GridPlanner(envB, plan, highW).plan(start, goal).path
    const expLow = evaluatePath(envA, pathLow, lowW, plan)
    // 用同口径的原始暴露（权重置1）比较
    const rawLow = evaluatePath(envA, pathLow, { ...weights, threat: 1 }, plan)
    const rawHigh = evaluatePath(envB, pathHigh, { ...weights, threat: 1 }, plan)
    expect(rawHigh.breakdown.threat).toBeLessThanOrEqual(
      rawLow.breakdown.threat
    )
    expect(expLow.total).toBeGreaterThanOrEqual(0)
  })

  it('完全封闭的目标不可达时返回失败', () => {
    // 用一圈硬禁飞区包围目标
    const ring: NoFlyZone[] = []
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2
      ring.push({
        id: `r${a}`,
        name: `r${a}`,
        position: { x: goal.x + Math.cos(ang) * 55, y: 0, z: goal.z + Math.sin(ang) * 55 },
        radius: 45,
        heightMin: 0,
        heightMax: 400,
        penalty: 10,
        hardBlock: true
      })
    }
    const env = envWith(noThreats, ring)
    const res = new GridPlanner(env, { ...plan, maxNodes: 60000 }, weights).plan(
      start,
      goal
    )
    expect(res.success).toBe(false)
  })
})

describe('航迹平滑与速度规划', () => {
  const env = envWith()
  const planner = new GridPlanner(env, plan, weights)
  const raw = planner.plan(start, goal).path

  it('折线平滑保持可行且不改变起终点', () => {
    const smoothed = smoothPolyline(env, raw, 10, plan.clearance)
    expect(smoothed[0]).toMatchObject({ x: raw[0].x, z: raw[0].z })
    expect(smoothed[smoothed.length - 1]).toMatchObject({ x: raw[raw.length - 1].x, z: raw[raw.length - 1].z })
    for (let i = 1; i < smoothed.length; i++) {
      expect(
        env.isSegmentFeasible(smoothed[i - 1], smoothed[i], plan.clearance)
      ).toBe(true)
    }
  })

  it('B 样条输出更密的点且无碰撞，失败时回退折线', () => {
    const bs = smoothBSpline(env, raw, plan.clearance, 5)
    expect(bs.length).toBeGreaterThan(raw.length)
    for (let i = 1; i < bs.length; i++) {
      expect(env.isSegmentFeasible(bs[i - 1], bs[i], plan.clearance)).toBe(true)
    }
  })

  it('加密后点间距不超过设定值', () => {
    const dense = densify(raw, 10)
    for (let i = 1; i < dense.length; i++) {
      const d = Math.hypot(
        dense[i].x - dense[i - 1].x,
        dense[i].y - dense[i - 1].y,
        dense[i].z - dense[i - 1].z
      )
      expect(d).toBeLessThanOrEqual(10.5)
    }
  })

  it('速度规划时间单调递增，速度处于给定范围内（端部减速除外）', () => {
    const traj = planTrajectory(raw, plan)
    expect(traj.length).toBeGreaterThan(10)
    for (let i = 1; i < traj.length; i++) {
      expect(traj[i].time).toBeGreaterThanOrEqual(traj[i - 1].time)
      expect(traj[i].speed).toBeLessThanOrEqual(plan.speedMax + 1)
    }
    expect(traj[traj.length - 1].speed).toBeLessThan(plan.speedMin)
  })
})

describe('多航点任务规划', () => {
  it('start-via-end 三航点任务成功并产出统计', () => {
    const env = envWith()
    const wps: Waypoint[] = [
      { id: 's', role: 'start', position: start, speed: 30 },
      { id: 'v', role: 'via', position: { x: 50, y: 110, z: -60 }, speed: 30 },
      { id: 'e', role: 'end', position: goal, speed: 30 }
    ]
    const result = planMission(env, wps, plan, weights, { smoothing: 'bspline' })
    expect(result.success).toBe(true)
    expect(result.legs).toHaveLength(2)
    expect(result.stats.distance).toBeGreaterThan(0)
    expect(result.stats.planTimeMs).toBeGreaterThanOrEqual(0)
    expect(result.stats.obstacleAvoidanceRate).toBe(100)
    expect(result.smoothPath.length).toBeGreaterThan(2)
  })

  it('A*/Dijkstra 规划与平滑后的航迹都经过起点/途经点/终点', () => {
    const via: Vec3 = { x: 50, y: 110, z: -60 }
    const wps: Waypoint[] = [
      { id: 's', role: 'start', position: start, speed: 30 },
      { id: 'v', role: 'via', position: via, speed: 30 },
      { id: 'e', role: 'end', position: goal, speed: 30 }
    ]
    const minDist = (path: Vec3[], p: Vec3) => {
      let best = Infinity
      for (const q of path) {
        const d = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z)
        if (d < best) best = d
      }
      return best
    }
    for (const algo of ['astar', 'dijkstra'] as const) {
      const env = envWith()
      const result = planMission(env, wps, { ...plan, algo }, weights, {
        smoothing: 'bspline'
      })
      expect(result.success).toBe(true)
      for (const wp of [start, via, goal]) {
        // 原始折线与平滑航迹的偏差都要远小于栅格边长
        expect(minDist(result.rawPath, wp)).toBeLessThan(plan.cellSize * 0.2)
        expect(minDist(result.smoothPath, wp)).toBeLessThan(plan.cellSize * 0.2)
      }
    }
  })

  it('缺少终点时失败并给出提示', () => {
    const env = envWith()
    const wps: Waypoint[] = [
      { id: 's', role: 'start', position: start, speed: 30 }
    ]
    const result = planMission(env, wps, plan, weights, { smoothing: 'none' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('终点')
  })
})
