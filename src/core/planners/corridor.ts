import type { CostWeights, PlanParams, Vec3 } from '@/types'
import type { Environment } from '@/core/environment'
import { Random } from '@/core/rng'
import { dist } from '@/utils/math3d'
import { evaluatePath } from '@/core/cost'

/**
 * 元启发式规划器共享的“切片走廊”模型（功能01）：
 * 在起点->终点之间沿直线等距放置 N 个切片，每个个体由
 * 每一切片上的一个候选点组成（侧向 + 高度偏移）。
 * 适用于蚁群 / 粒子群 / 遗传三类算法。
 */
export interface CorridorModel {
  slices: Slice[]
  /** 每切片候选点数量（侧向档 × 高度档） */
  optionsPerSlice: Vec3[][]
  N: number
}

export interface Slice {
  center: Vec3
  /** 水平侧向单位向量 */
  side: Vec3
  forward: Vec3
  spacing: number
}

const LATERAL_LEVELS = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2]
const VERT_LEVELS = [-1, -0.5, 0, 0.5, 1]

export function buildCorridor(
  start: Vec3,
  goal: Vec3,
  env: Environment,
  plan: PlanParams,
  rng: Random,
  slices = 10
): CorridorModel {
  // 水平航向与其侧向法向
  const f0 = normalize({ x: goal.x - start.x, y: 0, z: goal.z - start.z })
  const side = normalize({ x: f0.z, y: 0, z: -f0.x })

  const total = dist(start, goal)
  const spacing = total / (slices + 1)
  const corridorW = Math.min(plan.tuning.psoCorridor, total * 0.28)
  const vertW = Math.max(plan.dynamics.minTurnRadius * 0.8, 40)

  // 绕障中心线：沿直线推进，遇碰撞则侧向/高度抬升贪婪绕行
  const centers = corridorCenterline(start, goal, env, plan, slices)

  const sliceList: Slice[] = []
  const optionsPerSlice: Vec3[][] = []

  for (let i = 0; i < slices; i++) {
    const center = centers[i]
    sliceList.push({ center, side, forward: f0, spacing })

    const opts: Vec3[] = []
    for (const lat of LATERAL_LEVELS) {
      for (const vert of VERT_LEVELS) {
        // 轻微抖动，避免候选点过于规整；中心档位放置精确中心线点
        const isCenter = lat === 0 && vert === 0
        const jitter = isCenter ? 0 : 0.08
        const p: Vec3 = {
          x: center.x + side.x * lat * corridorW * 0.5 + (isCenter ? 0 : rng.gaussian() * corridorW * jitter),
          y: Math.max(
            20,
            center.y + vert * vertW + (isCenter ? 0 : rng.gaussian() * vertW * jitter)
          ),
          z: center.z + side.z * lat * corridorW * 0.5 + (isCenter ? 0 : rng.gaussian() * corridorW * jitter)
        }
        opts.push(p)
      }
    }
    optionsPerSlice.push(opts)
  }

  return { slices: sliceList, optionsPerSlice, N: slices }
}

/**
 * 走廊中心线：默认直线插值；若某切片直线点碰撞，
 * 用侧向偏移（双向扇形扫描）+ 高度抬升贪婪找到自由点，
 * 使走廊与地形/禁飞几何贴合，提高元启发式算法可行解概率。
 */
function corridorCenterline(
  start: Vec3,
  goal: Vec3,
  env: Environment,
  plan: PlanParams,
  slices: number
): Vec3[] {
  const centers: Vec3[] = []
  const f0 = normalize({ x: goal.x - start.x, y: 0, z: goal.z - start.z })
  const side = { x: f0.z, y: 0, z: -f0.x }
  const clearance = plan.clearance
  let prev: Vec3 = start

  for (let i = 1; i <= slices; i++) {
    const t = i / (slices + 1)
    const nominal: Vec3 = {
      x: start.x + (goal.x - start.x) * t,
      y: start.y + (goal.y - start.y) * t,
      z: start.z + (goal.z - start.z) * t
    }
    let chosen = nominal
    if (
      env.isBlocked(nominal, clearance) ||
      !env.isSegmentFeasible(prev, nominal, clearance)
    ) {
      // 侧向扇形扫描 + 抬升
      let best: Vec3 | null = null
      let bestScore = Infinity
      const offsets: number[] = []
      for (let k = 1; k <= 6; k++) {
        offsets.push(k * 22, -k * 22)
      }
      for (const latOff of offsets) {
        for (const up of [0, 25, 55, 90]) {
          const cand: Vec3 = {
            x: nominal.x + side.x * latOff,
            y: nominal.y + up,
            z: nominal.z + side.z * latOff
          }
          if (env.isBlocked(cand, clearance)) continue
          if (!env.isSegmentFeasible(prev, cand, clearance)) continue
          const score = Math.abs(latOff) + up * 1.2
          if (score < bestScore) {
            bestScore = score
            best = cand
          }
        }
      }
      if (best) chosen = best
    }
    centers.push(chosen)
    prev = chosen
  }
  return centers
}

/** 将“每切片选项索引”的决策向量转成完整路径 */
export function decode(
  start: Vec3,
  goal: Vec3,
  model: CorridorModel,
  choices: number[]
): Vec3[] {
  const path: Vec3[] = [{ ...start }]
  for (let i = 0; i < model.N; i++) {
    const opts = model.optionsPerSlice[i]
    const idx = Math.max(0, Math.min(opts.length - 1, Math.round(choices[i])))
    path.push(opts[idx])
  }
  path.push({ ...goal })
  return path
}

/**
 * 路径适应度：加权代价（迭代三含能耗/动力学分量）+ 碰撞重罚。
 * 碰撞按不可行采样点数计罚，保证有碰撞的解永远劣于无碰解。
 */
export function fitness(
  env: Environment,
  path: Vec3[],
  plan: PlanParams,
  weights: CostWeights
): number {
  let collisionPenalty = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]
    const b = path[i]
    const l = dist(a, b)
    if (!env.isSegmentFeasible(a, b, plan.clearance, Math.max(plan.cellSize * 0.5, 6))) {
      collisionPenalty += 1e5 + l * 100
    }
  }
  return evaluatePath(env, path, weights, plan).total + collisionPenalty
}

export function isFeasible(
  env: Environment,
  path: Vec3[],
  plan: PlanParams
): boolean {
  for (let i = 1; i < path.length; i++) {
    if (!env.isSegmentFeasible(path[i - 1], path[i], plan.clearance)) return false
  }
  return true
}

/**
 * 最优解局部修复：对每一切片选项做坐标下降贪心，
 * 以“碰撞段数 + 代价”为目标逐切片选最优，用于元启发式算法的收尾改进。
 * 碰撞检测为提前退出的短路计算，速度快于完整适应度。
 * 返回新的 choices（不修改原数组）。
 */
export function hillClimbRepair(
  env: Environment,
  model: CorridorModel,
  start: Vec3,
  goal: Vec3,
  choices: number[],
  plan: PlanParams,
  weights: CostWeights,
  maxPasses = 6
): number[] {
  const cur = [...choices]
  const pathAt = (ch: number[]) => decode(start, goal, model, ch)
  let bestCost = fitness(env, pathAt(cur), plan, weights)
  if (bestCost < 1e4) return cur // 已无碰撞，无需修复

  // 快速碰撞计数（短路）
  const collisionCount = (ch: number[]): number => {
    const p = pathAt(ch)
    let n = 0
    for (let i = 1; i < p.length; i++) {
      if (!env.isSegmentFeasible(p[i - 1], p[i], plan.clearance, Math.max(plan.cellSize * 0.5, 6)))
        n++
    }
    return n
  }
  let bestColl = collisionCount(cur)

  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false
    for (let i = 0; i < model.N; i++) {
      const old = cur[i]
      let bestJ = old
      const M = model.optionsPerSlice[i].length
      for (let j = 0; j < M; j++) {
        if (j === old) continue
        cur[i] = j
        const coll = collisionCount(cur)
        if (coll < bestColl || (coll === bestColl && coll === 0)) {
          const c = coll === 0 ? fitness(env, pathAt(cur), plan, weights) : Infinity
          if (coll < bestColl || (coll === 0 && c < bestCost)) {
            bestColl = coll
            bestCost = coll === 0 ? c : bestCost
            bestJ = j
          }
        }
      }
      cur[i] = bestJ
      if (bestJ !== old) improved = true
      if (bestColl === 0) {
        bestCost = fitness(env, pathAt(cur), plan, weights)
        return cur
      }
    }
    if (!improved) break
  }
  return cur
}

/**
 * 分层动态规划修复（元启发式算法收尾保证）：
 * 将各切片候选点视为分层图节点，若存在“起点→各层→终点”的
 * 无碰撞链，则用最短路 DP 求出代价最小的可行 choices。
 * 返回 null 表示走廊内不存在可行解。
 */
export function feasibleChainDP(
  env: Environment,
  model: CorridorModel,
  start: Vec3,
  goal: Vec3,
  plan: PlanParams,
  weights: CostWeights
): number[] | null {
  const N = model.N
  const cl = plan.clearance

  // 节点代价（威胁/高度场）
  const nodeCost: number[][] = model.optionsPerSlice.map((opts) =>
    opts.map((p) => {
      const alt =
        Math.abs(p.y - plan.cruiseAlt) / Math.max(plan.cruiseAlt, 1)
      return (
        env.threatIntensity(p) * weights.threat * 8 +
        env.noflyPenalty(p) * weights.nofly * 0.2 +
        alt * weights.altitude * 8
      )
    })
  )

  // 边可行性：start->layer0
  const edgeOk = (a: Vec3, b: Vec3) => env.isSegmentFeasible(a, b, cl)
  const segCost = (a: Vec3, b: Vec3) =>
    dist(a, b) * weights.distance

  let dp: number[] = model.optionsPerSlice[0].map((p, j) =>
    edgeOk(start, p)
      ? segCost(start, p) + (nodeCost[0][j] ?? 0)
      : Infinity
  )
  const parent: (number | null)[][] = model.optionsPerSlice.map((layer) =>
    new Array<number | null>(layer.length).fill(null)
  )

  for (let i = 1; i < N; i++) {
    const next = new Array<number>(model.optionsPerSlice[i].length).fill(Infinity)
    for (let j = 0; j < next.length; j++) {
      const pj = model.optionsPerSlice[i][j]
      let best = Infinity
      let bestK = -1
      for (let k = 0; k < dp.length; k++) {
        if (!Number.isFinite(dp[k])) continue
        const pk = model.optionsPerSlice[i - 1][k]
        if (!edgeOk(pk, pj)) continue
        const c = dp[k] + segCost(pk, pj) + (nodeCost[i][j] ?? 0)
        if (c < best) {
          best = c
          bestK = k
        }
      }
      if (bestK >= 0) {
        next[j] = best
        parent[i][j] = bestK
      }
    }
    dp = next
  }

  // 末层 -> goal
  let bestJ = -1
  let best = Infinity
  for (let j = 0; j < dp.length; j++) {
    if (!Number.isFinite(dp[j])) continue
    const pj = model.optionsPerSlice[N - 1][j]
    if (!edgeOk(pj, goal)) continue
    const c = dp[j] + segCost(pj, goal)
    if (c < best) {
      best = c
      bestJ = j
    }
  }
  if (bestJ < 0) return null

  const choices = new Array<number>(N)
  let cur: number | null = bestJ
  for (let i = N - 1; i >= 0; i--) {
    choices[i] = cur as number
    cur = parent[i][cur as number]
  }
  return choices
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z)
  return l < 1e-9 ? { x: 0, y: 0, z: 0 } : { x: v.x / l, y: v.y / l, z: v.z / l }
}
