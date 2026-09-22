import { describe, expect, it } from 'vitest'
import {
  DynamicEnvironment,
  entityPosition,
  predictPath
} from '@/core/dynamic-environment'
import { checkReplanTriggers, localReplan } from '@/core/replanning'
import { planMission } from '@/core/planning'
import { planTrajectory } from '@/core/smoothing'
import { Random } from '@/core/rng'
import { compareAlgorithms } from '@/core/planning'
import {
  checkPathConstraints,
  extensionAllowed,
  repairPathDynamics,
  turnAngleRad,
  climbAngleRad,
  horizontalCurvature
} from '@/core/dynamics'
import { evaluateMetrics } from '@/core/metrics'
import { simulateTracking } from '@/core/tracking'
import {
  smoothBezier,
  smoothBSpline,
  smoothClothoid,
  smoothDubins,
  smoothPolynomial
} from '@/core/smoothing'
import type {
  BuildingObstacle,
  DynamicEntity,
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

const plan: PlanParams = { ...defaultPlanParams, cellSize: 20, heightCell: 20, maxNodes: 120000, clearance: 8, cruiseAlt: 100 }
const start: Vec3 = { x: -240, y: 100, z: -200 }
const goal: Vec3 = { x: 240, y: 100, z: 200 }

const terrainBig: TerrainParams = {
  size: 1000,
  segments: 64,
  seed: 20260920,
  heightScale: 140,
  noiseScale: 0.0022,
  ridgeScale: 70,
  canyon: true
}

function makeObstacle(over: Partial<DynamicEntity> = {}): DynamicEntity {
  return {
    id: 'd1',
    name: 'moving',
    kind: 'obstacle',
    motion: 'linear',
    position: { x: 0, y: 100, z: 0 },
    target: { x: 100, y: 100, z: 0 },
    patrolPoints: [],
    speed: 20,
    radius: 15,
    threatRadius: 50,
    heightMin: 0,
    heightMax: 200,
    level: 4,
    predictHorizon: 5,
    enableAt: 0,
    disableAt: Infinity,
    active: true,
    color: '#ff8f1f',
    ...over
  }
}

describe('确定性随机数', () => {
  it('同种子序列一致，权重抽取合法，高斯分布有限', () => {
    const a = new Random(123)
    const b = new Random(123)
    for (let i = 0; i < 50; i++) expect(a.next()).toBe(b.next())
    const r = new Random(7)
    for (let i = 0; i < 100; i++) {
      const idx = r.weightedIndex([1, 2, 3, 0])
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThanOrEqual(2)
      expect(Number.isFinite(r.gaussian())).toBe(true)
    }
  })
})

describe('动力学约束', () => {
  it('转弯角/爬升角/步长扩展判定', () => {
    const dyn = plan.dynamics
    const a: Vec3 = { x: 0, y: 100, z: 0 }
    const b: Vec3 = { x: 0, y: 100, z: 40 }
    // 急转 120°，超过最大转弯角 60
    const sharp: Vec3 = { x: Math.sin((120 * Math.PI) / 180) * 40, y: 100, z: 40 }
    expect(extensionAllowed(dyn, a, b, sharp)).toBe(false)
    // 小转角通过
    const gentle: Vec3 = { x: 10, y: 100, z: 78 }
    expect(extensionAllowed(dyn, a, b, gentle)).toBe(true)
    // 步长过短拒绝
    const tiny: Vec3 = { x: 0, y: 100, z: 42 }
    expect(extensionAllowed(dyn, a, b, tiny)).toBe(false)
    // 爬升角超限拒绝
    const climb: Vec3 = { x: 0, y: 160, z: 50 }
    expect(extensionAllowed(dyn, a, b, climb)).toBe(false)
  })

  it('几何角度函数正确', () => {
    const a: Vec3 = { x: 0, y: 0, z: 0 }
    const b: Vec3 = { x: 0, y: 0, z: 10 }
    const c: Vec3 = { x: 10, y: 0, z: 10 }
    expect((turnAngleRad(a, b, c) * 180) / Math.PI).toBeCloseTo(90, 5)
    expect((climbAngleRad(a, { x: 0, y: 10, z: 10 }) * 180) / Math.PI).toBeCloseTo(45, 5)
    expect(horizontalCurvature(a, b, c)).toBeGreaterThan(0)
  })

  it('约束报告统计违反点，自动修正不产生碰撞', () => {
    const env = new DynamicEnvironment(terrain, noThreats, noNofly, noObs)
    // 带两个尖角的折线路径
    const raw: Vec3[] = [
      { x: -240, y: 100, z: -200 },
      { x: -200, y: 100, z: -40 },
      { x: 200, y: 100, z: 20 },
      { x: 240, y: 100, z: 200 }
    ]
    const dense: Vec3[] = []
    for (let i = 1; i < raw.length; i++) {
      const n = 20
      for (let k = 0; k < n; k++) {
        const t = k / n
        dense.push({
          x: raw[i - 1].x + (raw[i].x - raw[i - 1].x) * t,
          y: 100,
          z: raw[i - 1].z + (raw[i].z - raw[i - 1].z) * t
        })
      }
    }
    dense.push(raw[raw.length - 1])
    const report = checkPathConstraints(dense, plan.dynamics)
    expect(report.turnViolations).toBeGreaterThan(0)
    expect(report.satisfactionRate).toBeLessThan(100)
    const repaired = repairPathDynamics(env, raw, plan)
    for (let i = 1; i < repaired.length; i++) {
      expect(env.isSegmentFeasible(repaired[i - 1], repaired[i], plan.clearance)).toBe(true)
    }
  })
})

describe('动态环境', () => {
  it('线性移动位置随时间前进并往返', () => {
    const e = makeObstacle({ speed: 10, target: { x: 110, y: 100, z: 0 } })
    const p0 = entityPosition(e, 0)
    const p5 = entityPosition(e, 5)
    expect(p5.x).toBeGreaterThan(p0.x)
    // 单程 120m，t=5 时由 x=0 前进到 x=50
    expect(p5.x).toBeCloseTo(50, 0)
    // 越过远端后反向（cycle=240，t=15 时回程到 x=90）
    const p15 = entityPosition(e, 15)
    expect(p15.x).toBeCloseTo(70, 0)
    expect(p15.x).toBeLessThan(110)
  })

  it('巡逻模式沿折线运动', () => {
    const e = makeObstacle({
      motion: 'patrol',
      speed: 10,
      patrolPoints: [
        { x: 0, y: 100, z: 0 },
        { x: 100, y: 100, z: 0 }
      ]
    })
    expect(entityPosition(e, 0).x).toBeCloseTo(0, 0)
    expect(entityPosition(e, 5).x).toBeCloseTo(50, 0)
  })

  it('突发威胁按调度激活', () => {
    const env = new DynamicEnvironment(terrain, noThreats, noNofly, noObs, [
      makeObstacle({
        kind: 'threat',
        motion: 'static',
        enableAt: 4,
        active: true,
        threatRadius: 80,
        level: 5
      })
    ])
    const e = env.dynamics[0]
    expect(env.stateAt(e, 2).active).toBe(false)
    expect(env.dynamicThreatIntensity({ x: 0, y: 100, z: 0 }, 2)).toBe(0)
    expect(env.stateAt(e, 5).active).toBe(true)
    expect(env.dynamicThreatIntensity({ x: 0, y: 100, z: 0 }, 5)).toBeGreaterThan(0)
    // active 总开关关闭时即使进入时间窗也不激活
    const e2 = { ...e, active: false, id: 'd2' }
    expect(env.stateAt(e2, 5).active).toBe(false)
  })

  it('移动障碍时空碰撞检测', () => {
    // 障碍 t=0 在 (-10,100,0)，t=2 到 (10,100,0)
    const env = new DynamicEnvironment(terrain, noThreats, noNofly, noObs, [
      makeObstacle({
        speed: 10,
        position: { x: -10, y: 100, z: 0 },
        target: { x: 110, y: 100, z: 0 },
        radius: 8
      })
    ])
    const a: Vec3 = { x: -10, y: 100, z: 0 }
    const b: Vec3 = { x: 10, y: 100, z: 0 }
    // 与障碍同步运动：同一位置同一时刻 -> 碰撞
    expect(env.isSegmentFeasibleSpacetime(a, b, 8, 0, 2)).toBe(false)
    // 时间错开：t=13..15 障碍在远端（x 约 100→80），远离无人机航段
    expect(env.isSegmentFeasibleSpacetime(a, b, 8, 13, 15)).toBe(true)
  })

  it('预测轨迹长度与终点正确', () => {
    const e = makeObstacle({ speed: 10 })
    const path = predictPath(e, 0, 4, 8)
    expect(path).toHaveLength(9)
    expect(path[8].x).toBeCloseTo(40, 0)
  })
})

describe('高级规划算法（8 种）', () => {
  const algos = ['astar', 'dijkstra', 'rrt', 'rrtstar', 'hybridastar', 'aco', 'pso', 'ga'] as const
  const wps: Waypoint[] = [
    { id: 's', role: 'start', position: start, speed: 30 },
    { id: 'e', role: 'end', position: goal, speed: 30 }
  ]

  for (const algo of algos) {
    it(`${algo} 在无障碍场景规划成功`, () => {
      const env = new DynamicEnvironment(terrain, noThreats, noNofly, noObs)
      const r = planMission(env, wps, plan, defaultWeights, {
        smoothing: 'polyline',
        algoOverride: algo,
        seed: 7
      })
      expect(r.success, r.message).toBe(true)
      expect(r.smoothPath.length).toBeGreaterThan(2)
      for (let i = 1; i < r.smoothPath.length; i++) {
        expect(
          env.isSegmentFeasible(r.smoothPath[i - 1], r.smoothPath[i], plan.clearance)
        ).toBe(true)
      }
    })
  }

  it('多算法对比返回各项指标', () => {
    const env = new DynamicEnvironment(terrain, noThreats, noNofly, noObs)
    const entries = compareAlgorithms(
      env,
      wps,
      plan,
      defaultWeights,
      ['astar', 'rrt', 'pso'],
      'polyline',
      7
    )
    expect(entries).toHaveLength(3)
    for (const e of entries) {
      expect(e.success).toBe(true)
      expect(e.distance).toBeGreaterThan(0)
      expect(e.planTimeMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('RRT 固定种子结果可复现', () => {
    const env = new DynamicEnvironment(terrain, noThreats, noNofly, noObs)
    const r1 = planMission(env, wps, plan, defaultWeights, { smoothing: 'none', algoOverride: 'rrt', seed: 99 })
    const env2 = new DynamicEnvironment(terrain, noThreats, noNofly, noObs)
    const r2 = planMission(env2, wps, plan, defaultWeights, { smoothing: 'none', algoOverride: 'rrt', seed: 99 })
    expect(JSON.stringify(r1.smoothPath)).toBe(JSON.stringify(r2.smoothPath))
  })
})

describe('高级平滑方法', () => {
  const env = new DynamicEnvironment(terrain, noThreats, noNofly, noObs)
  // 用 A* 得到有折点的原始路径
  const raw = planMission(env, [
    { id: 's', role: 'start', position: start, speed: 30 },
    { id: 'e', role: 'end', position: goal, speed: 30 }
  ], plan, defaultWeights, { smoothing: 'none' }).smoothPath

  it('B样条/贝塞尔/多项式/Dubins/Clothoid 均无碰撞且起终点保持', () => {
    const methods = [
      smoothBSpline(env, raw, plan.clearance),
      smoothBezier(env, raw, plan.clearance),
      smoothPolynomial(env, raw, plan.clearance),
      smoothDubins(env, raw, plan.clearance, plan.dynamics.minTurnRadius),
      smoothClothoid(env, raw, plan.clearance, plan.dynamics.minTurnRadius)
    ]
    for (const p of methods) {
      expect(p.length).toBeGreaterThan(3)
      for (let i = 1; i < p.length; i++) {
        expect(env.isSegmentFeasible(p[i - 1], p[i], plan.clearance)).toBe(true)
      }
      // 端点接近
      expect(Math.hypot(p[0].x - raw[0].x, p[0].z - raw[0].z)).toBeLessThan(60)
      const last = p[p.length - 1]
      expect(Math.hypot(last.x - raw[raw.length - 1].x, last.z - raw[raw.length - 1].z)).toBeLessThan(60)
    }
  })

  it('平滑后指标可计算且最大转角不高于原始（折线预处理生效）', () => {
    const rawM = evaluateMetrics(raw, plan)
    const sm = planMission(env, [
      { id: 's', role: 'start', position: start, speed: 30 },
      { id: 'e', role: 'end', position: goal, speed: 30 }
    ], plan, defaultWeights, { smoothing: 'bspline' })
    const smM = sm.stats.smoothMetrics!
    expect(smM.maxTurnAngle).toBeLessThanOrEqual(rawM.maxTurnAngle + 5)
    expect(smM.maxAccel).toBeGreaterThanOrEqual(0)
    expect(smM.maxJerk).toBeGreaterThanOrEqual(0)
  })
})

describe('在线重规划', () => {
  it('碰撞风险触发局部时空 RRT，新路径无时空碰撞', () => {
    // 空中横穿障碍：在无人机 t≈9 经过 (-247,-92) 附近时相遇
    const dyn = makeObstacle({
      position: { x: -400, y: 120, z: -58 },
      target: { x: 0, y: 120, z: -58 },
      speed: 16,
      radius: 20
    })
    const env = new DynamicEnvironment(terrain, defaultThreats4Test(), defaultNofly4Test(), defaultObs4Test(), [dyn])
    const wps: Waypoint[] = [
      { id: 's', role: 'start', position: { x: -425, y: 120, z: -325 }, speed: 30 },
      { id: 'v', role: 'via', position: { x: -150, y: 130, z: 80 }, speed: 30 },
      { id: 'e', role: 'end', position: { x: 425, y: 110, z: 305 }, speed: 30 }
    ]
    // 使用与默认场景一致的大尺寸地形，保证航迹可达且与障碍时空相遇
    const envBig = new DynamicEnvironment(terrainBig, defaultThreats4Test(), defaultNofly4Test(), defaultObs4Test(), [dyn])
    const bigPlan: PlanParams = { ...plan, cellSize: 25, heightCell: 20, clearance: 12, cruiseAlt: 120 }
    const r = planMission(envBig, wps, bigPlan, defaultWeights, { smoothing: 'bspline' })
    expect(r.success).toBe(true)
    const traj = planTrajectory(r.smoothPath, bigPlan)

    // 找到首个碰撞风险触发
    let fired = -1
    for (let t = 0; t < 12; t += 0.25) {
      const s = traj.find((x) => x.time >= t)!
      const tr = checkReplanTriggers({
        env: envBig,
        plan: bigPlan,
        weights: defaultWeights,
        triggers: {
          enabled: true,
          onThreatApproach: false,
          onCollisionRisk: true,
          onYawDeviation: false,
          onRangeAnomaly: false,
          lookaheadTime: 6,
          warnDistance: 120,
          yawThreshold: 35,
          rangeThreshold: 0.35,
          windowRadius: 260
        },
        traj,
        time: t,
        position: s.position,
        heading: 0,
        plannedTotalLength: r.stats.distance,
        cooldownLeft: 0
      })
      if (tr.triggered) {
        fired = t
        expect(tr.reason).toBe('collision-risk')
        break
      }
    }
    expect(fired).toBeGreaterThanOrEqual(0)

    const lr = localReplan(envBig, bigPlan, defaultWeights, traj, fired, 260)
    expect(lr.success).toBe(true)
    // 新局部路径时空无碰撞
    let t = fired
    for (let i = 1; i < lr.localPath.length; i++) {
      const l = Math.hypot(
        lr.localPath[i].x - lr.localPath[i - 1].x,
        lr.localPath[i].y - lr.localPath[i - 1].y,
        lr.localPath[i].z - lr.localPath[i - 1].z
      )
      t += l / 30
      expect(
        envBig.isSegmentFeasibleSpacetime(lr.localPath[i - 1], lr.localPath[i], bigPlan.clearance, t - l / 30, t)
      ).toBe(true)
    }
  })

  it('威胁接近触发开关可关闭', () => {
    const e = makeObstacle({
      position: { x: 0, y: 100, z: 0 },
      target: { x: 0, y: 100, z: 0 },
      motion: 'static',
      speed: 0,
      radius: 12
    })
    const env = new DynamicEnvironment(terrain, noThreats, noNofly, noObs, [e])
    // 直接构造时间参数化轨迹（10s 内经过静态障碍位置）
    const traj = [
      { position: { x: -60, y: 100, z: 0 }, velocity: { x: 12, y: 0, z: 0 }, speed: 12, time: 0, s: 0 },
      { position: { x: 60, y: 100, z: 0 }, velocity: { x: 12, y: 0, z: 0 }, speed: 12, time: 10, s: 120 }
    ]
    const base = {
      plan,
      weights: defaultWeights,
      traj,
      time: 0,
      position: traj[0].position,
      heading: Math.PI / 2,
      plannedTotalLength: 120,
      cooldownLeft: 0
    }
    const cfg = {
      enabled: true,
      onThreatApproach: true,
      onCollisionRisk: false,
      onYawDeviation: false,
      onRangeAnomaly: false,
      lookaheadTime: 10,
      warnDistance: 80,
      yawThreshold: 35,
      rangeThreshold: 0.35,
      windowRadius: 260
    }
    const on = checkReplanTriggers({ ...base, env, triggers: cfg })
    expect(on.triggered).toBe(true)
    const off = checkReplanTriggers({ ...base, env, triggers: { ...cfg, enabled: false } })
    expect(off.triggered).toBe(false)
    const off2 = checkReplanTriggers({ ...base, env, triggers: { ...cfg, onThreatApproach: false } })
    expect(off2.triggered).toBe(false)
  })

  it('威胁尚远（未侵入安全裕度）时不触发，侵入时才触发', () => {
    const threat = makeObstacle({
      kind: 'threat',
      motion: 'static',
      speed: 0,
      position: { x: 0, y: 0, z: 0 },
      target: { x: 0, y: 0, z: 0 },
      threatRadius: 80,
      heightMin: 0,
      heightMax: 200,
      enableAt: 0
    })
    const env = new DynamicEnvironment(terrain, noThreats, noNofly, noObs, [threat])
    const cfg = {
      enabled: true,
      onThreatApproach: true,
      onCollisionRisk: false,
      onYawDeviation: false,
      onRangeAnomaly: false,
      lookaheadTime: 25,
      warnDistance: 120, // 旧口径会据此在 200m 外触发；新口径忽略
      yawThreshold: 35,
      rangeThreshold: 0.35,
      windowRadius: 260
    }
    const mkTraj = (z: number) => [
      { position: { x: -100, y: 100, z }, velocity: { x: 10, y: 0, z: 0 }, speed: 10, time: 0, s: 0 },
      { position: { x: 100, y: 100, z }, velocity: { x: 10, y: 0, z: 0 }, speed: 10, time: 20, s: 200 }
    ]
    const base = {
      plan,
      weights: defaultWeights,
      time: 0,
      heading: Math.PI / 2,
      plannedTotalLength: 200,
      cooldownLeft: 0
    }
    // 航线距威胁中心 120m（> 半径80+安全8）：有风险但尚小，不触发
    const far = checkReplanTriggers({
      ...base,
      env,
      triggers: cfg,
      traj: mkTraj(120),
      position: mkTraj(120)[0].position
    })
    expect(far.triggered).toBe(false)
    // 航线穿过威胁区：触发并给出风险位置
    const hitTraj = mkTraj(0)
    const hit = checkReplanTriggers({
      ...base,
      env,
      triggers: cfg,
      traj: hitTraj,
      position: hitTraj[0].position
    })
    expect(hit.triggered).toBe(true)
    expect(hit.reason).toBe('threat-approach')
    expect(hit.hazard).toBeDefined()
  })

  it('突发威胁压线时绕飞、不进入威胁区并接回原航线', () => {
    const threat = makeObstacle({
      kind: 'threat',
      motion: 'static',
      speed: 0,
      position: { x: 0, y: 0, z: 0 },
      target: { x: 0, y: 0, z: 0 },
      threatRadius: 60,
      heightMin: 0,
      heightMax: 200,
      enableAt: 0,
      level: 5
    })
    const env = new DynamicEnvironment(terrain, noThreats, noNofly, noObs, [threat])
    // 直线轨迹穿过威胁中心，20m 一个采样点
    const traj: {
      position: Vec3
      velocity: Vec3
      speed: number
      time: number
      s: number
    }[] = []
    for (let x = -200; x <= 200; x += 20) {
      traj.push({
        position: { x, y: 100, z: 0 },
        velocity: { x: 20, y: 0, z: 0 },
        speed: 20,
        time: (x + 200) / 20,
        s: x + 200
      })
    }
    const t = 2
    const tr = checkReplanTriggers({
      env,
      plan,
      weights: defaultWeights,
      triggers: {
        enabled: true,
        onThreatApproach: true,
        onCollisionRisk: true,
        onYawDeviation: false,
        onRangeAnomaly: false,
        lookaheadTime: 12,
        warnDistance: 120,
        yawThreshold: 35,
        rangeThreshold: 0.35,
        windowRadius: 260
      },
      traj,
      time: t,
      position: traj[2].position,
      heading: Math.PI / 2,
      plannedTotalLength: 400,
      cooldownLeft: 0
    })
    expect(tr.triggered).toBe(true)
    expect(tr.reason).toBe('threat-approach')

    const lr = localReplan(env, plan, defaultWeights, traj, t, 260)
    expect(lr.success).toBe(true)
    expect(lr.costAfter).toBeLessThan(lr.costBefore)
    // 绕飞路径不进入按安全距离膨胀的威胁区
    for (const p of lr.localPath) {
      expect(env.hitsDynamicThreat(p, plan.clearance, t + 3)).toBe(false)
    }
    // 绕飞终点精确接回原航线的接入点
    const tail = lr.localPath[lr.localPath.length - 1]
    const merge = traj[lr.mergeIndex].position
    expect(
      Math.hypot(tail.x - merge.x, tail.y - merge.y, tail.z - merge.z)
    ).toBeLessThan(1e-6)
  })

  it('绕飞无收益时保持原航线（收益门控）', () => {
    // 无任何动态实体：绕飞不可能更优，应判定为不成功（保持原航线）
    const env = new DynamicEnvironment(terrain, noThreats, noNofly, noObs, [])
    const traj: {
      position: Vec3
      velocity: Vec3
      speed: number
      time: number
      s: number
    }[] = []
    for (let x = -200; x <= 200; x += 20) {
      traj.push({
        position: { x, y: 100, z: 0 },
        velocity: { x: 20, y: 0, z: 0 },
        speed: 20,
        time: (x + 200) / 20,
        s: x + 200
      })
    }
    const lr = localReplan(env, plan, defaultWeights, traj, 2, 260)
    expect(lr.success).toBe(false)
    expect(lr.message).toContain('保持原航线')
  })
})

describe('轨迹跟踪仿真', () => {
  it('零初始偏差时跟踪误差很小', () => {
    const env = new DynamicEnvironment(terrain, noThreats, noNofly, noObs)
    const r = planMission(env, [
      { id: 's', role: 'start', position: start, speed: 30 },
      { id: 'e', role: 'end', position: goal, speed: 30 }
    ], plan, defaultWeights, { smoothing: 'bspline' })
    const traj = planTrajectory(r.smoothPath, plan)
    const { summary } = simulateTracking(traj)
    expect(summary.samples).toBe(traj.length)
    // 二阶跟踪存在小幅动态滞后（转弯段），RMS 应保持在米级
    expect(summary.rmsLateral).toBeLessThan(15)
    expect(summary.maxLateral).toBeLessThan(30)
  })
})

function defaultThreats4Test(): ThreatZone[] {
  return [
    {
      id: 't0',
      kind: 'radar',
      name: 'r',
      position: { x: 60, y: 0, z: 40 },
      radius: 110,
      heightMin: 0,
      heightMax: 160,
      level: 4,
      opacity: 0.2
    },
    {
      id: 't1',
      kind: 'sam',
      name: 's',
      position: { x: -140, y: 0, z: -90 },
      radius: 90,
      heightMin: 20,
      heightMax: 220,
      level: 5,
      opacity: 0.28
    }
  ]
}
function defaultNofly4Test(): NoFlyZone[] {
  return [
    {
      id: 'z0',
      name: 'hard',
      position: { x: -40, y: 0, z: 150 },
      radius: 70,
      heightMin: 0,
      heightMax: 300,
      penalty: 10,
      hardBlock: true
    }
  ]
}
function defaultObs4Test(): BuildingObstacle[] {
  return [
    { id: 'o0', name: 'A', position: { x: 240, y: 0, z: 120 }, size: { x: 36, z: 36 }, height: 55 }
  ]
}
