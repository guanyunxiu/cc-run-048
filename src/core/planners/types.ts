import type {
  CandidatePath,
  ConvergencePoint,
  CostWeights,
  PlanParams,
  Vec3
} from '@/types'
import type { Environment } from '@/core/environment'
import { Random } from '@/core/rng'
import { evaluatePath } from '@/core/cost'
import { extensionAllowed } from '@/core/dynamics'
import { dist } from '@/utils/math3d'

export interface PlannerContext {
  env: Environment
  plan: PlanParams
  weights: CostWeights
  rng: Random
}

export interface PlannerOutput {
  success: boolean
  path: Vec3[]
  expandedNodes: number
  message: string
  candidates?: CandidatePath[]
  /** 迭代三：随机算法收敛曲线（每代最优/平均代价） */
  convergence?: ConvergencePoint[]
}

/** 所有规划算法（A星/Dijkstra 适配器之外）实现的统一接口 */
export interface PathPlanner {
  plan(start: Vec3, goal: Vec3): PlannerOutput
}

/** 抽象采样规划器公共能力：自由空间采样、最近邻、动力学扩展 */
export abstract class SamplingPlannerBase implements PathPlanner {
  protected ctx: PlannerContext
  protected bounds: number

  constructor(ctx: PlannerContext) {
    this.ctx = ctx
    this.bounds = ctx.env.terrain.params.size / 2 - 4
  }

  abstract plan(start: Vec3, goal: Vec3): PlannerOutput

  protected free(p: Vec3): boolean {
    return this.ctx.env.isBlocked(p, this.ctx.plan.clearance) === false
  }

  /** 在起终点连线周围的盒形区域内做偏置采样，偏向走廊以提升效率 */
  protected sample(goal: Vec3, goalBias: number): Vec3 {
    const rng = this.ctx.rng
    if (rng.next() < goalBias) return { ...goal }
    const b = this.bounds
    const alt = this.ctx.plan.cruiseAlt
    return {
      x: rng.range(-b, b),
      y: Math.max(20, alt + rng.gaussian() * 70),
      z: rng.range(-b, b)
    }
  }

  protected nearest(nodes: Vec3[], p: Vec3): number {
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < nodes.length; i++) {
      const d =
        (nodes[i].x - p.x) ** 2 +
        (nodes[i].y - p.y) ** 2 +
        (nodes[i].z - p.z) ** 2
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return best
  }

  /** 从 a 朝 b 扩展一个固定步长，考虑动力学（转弯/爬升）与碰撞 */
  protected steer(a: Vec3, b: Vec3, parent: Vec3 | null): Vec3 | null {
    const { plan, env } = this.ctx
    const d = dist(a, b)
    const step = Math.min(plan.tuning.rrtStep, d)
    if (step < plan.dynamics.minStep * 0.5) return null
    const k = step / Math.max(d, 1e-9)
    const cand: Vec3 = {
      x: a.x + (b.x - a.x) * k,
      y: a.y + (b.y - a.y) * k,
      z: a.z + (b.z - a.z) * k
    }
    cand.y = Math.max(cand.y, 20)
    if (plan.dynamics.enforceInSearch && parent) {
      if (!extensionAllowed(plan.dynamics, parent, a, cand)) return null
    }
    if (!env.isSegmentFeasible(a, cand, plan.clearance)) return null
    return cand
  }
}

/** 路径代价（加权口径，与评估面板一致） */
export function pathWeightedCost(
  env: Environment,
  path: Vec3[],
  plan: PlanParams,
  weights: CostWeights
): number {
  if (path.length < 2) return Infinity
  return evaluatePath(env, path, weights, plan).total
}
