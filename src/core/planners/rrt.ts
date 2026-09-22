import type { CandidatePath, Vec3 } from '@/types'
import { extensionAllowed } from '@/core/dynamics'
import {
  pathWeightedCost,
  SamplingPlannerBase
} from '@/core/planners/types'
import type { PlannerOutput } from '@/core/planners/types'

interface RRTNode {
  p: Vec3
  parent: number
  /** RRT*：从根到该节点的累计代价（加权） */
  g: number
}

/**
 * RRT / RRT* 三维航迹规划器（功能01）。
 * - 目标偏置采样；steer 固定步长；边做碰撞采样与动力学约束；
 * - RRT* 在邻域半径内选最优父节点并重连（rewire）；
 * - 到达目标后继续采样以优化解（RRT 提前结束）；
 * - 记录采样过程候选航迹用于“候选航迹显示”。
 */
export class RRTPlanner extends SamplingPlannerBase {
  private star: boolean

  constructor(ctx: ConstructorParameters<typeof SamplingPlannerBase>[0], star = false) {
    super(ctx)
    this.star = star
  }

  plan(start: Vec3, goal: Vec3): PlannerOutput {
    const { env, plan, weights, rng } = this.ctx
    if (!this.free(start) || !this.free(goal)) {
      return {
        success: false,
        path: [],
        expandedNodes: 0,
        message: '起终点位于障碍/禁飞区内'
      }
    }

    const nodes: RRTNode[] = [{ p: { ...start }, parent: -1, g: 0 }]
    const maxN = plan.tuning.maxSamples
    const goalBias = plan.tuning.goalBias
    const rewireR = plan.tuning.rewireRadius
    const goalTol = plan.tuning.rrtStep * 0.9

    let goalIdx = -1
    let bestGoalCost = Infinity
    const candidates: CandidatePath[] = []
    let reachedIter = -1

    const parentOf = (i: number): Vec3 | null => {
      const pi = nodes[i].parent
      return pi >= 0 ? nodes[pi].p : null
    }

    const withinRadius = (p: Vec3, r: number): number[] => {
      const out: number[] = []
      const r2 = r * r
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i].p
        if ((n.x - p.x) ** 2 + (n.y - p.y) ** 2 + (n.z - p.z) ** 2 <= r2) {
          out.push(i)
        }
      }
      return out
    }

    for (let iter = 0; iter < maxN; iter++) {
      const sample = this.sample(goal, goalBias)
      const nearIdx = this.nearestNode(nodes, sample)
      const cand = this.steer(nodes[nearIdx].p, sample, parentOf(nearIdx))
      if (!cand) continue
      const newIdx = nodes.length

      // 选择父节点
      let chosenParent = nearIdx
      let chosenG = nodes[nearIdx].g + this.edgeCost(nodes[nearIdx].p, cand)
      if (this.star) {
        for (const ni of withinRadius(cand, rewireR)) {
          if (
            this.edgeDynamicsOk(nodes, ni, cand) &&
            env.isSegmentFeasible(nodes[ni].p, cand, plan.clearance)
          ) {
            const g = nodes[ni].g + this.edgeCost(nodes[ni].p, cand)
            if (g < chosenG) {
              chosenG = g
              chosenParent = ni
            }
          }
        }
      }
      nodes.push({ p: cand, parent: chosenParent, g: chosenG })

      // 重连
      if (this.star) {
        for (const ni of withinRadius(cand, rewireR)) {
          if (ni === chosenParent) continue
          const gNew = chosenG + this.edgeCost(cand, nodes[ni].p)
          if (
            gNew < nodes[ni].g &&
            env.isSegmentFeasible(cand, nodes[ni].p, plan.clearance)
          ) {
            nodes[ni].parent = newIdx
            nodes[ni].g = gNew
          }
        }
      }

      // 到达目标
      const dg = Math.hypot(cand.x - goal.x, cand.y - goal.y, cand.z - goal.z)
      if (dg <= goalTol && env.isSegmentFeasible(cand, goal, plan.clearance)) {
        const gGoal = chosenG + this.edgeCost(cand, goal)
        if (gGoal < bestGoalCost) {
          nodes.push({ p: { ...goal }, parent: newIdx, g: gGoal })
          goalIdx = nodes.length - 1
          bestGoalCost = gGoal
          if (reachedIter < 0) reachedIter = iter
        }
      }

      // 已找到解后做有限的额外优化采样（RRT* 优化，RRT 提前结束）
      if (goalIdx >= 0) {
        if (!this.star) break
        if (iter - reachedIter > Math.min(1200, maxN * 0.4)) break
      }

      // 候选航迹：周期性记录采样分支（控制数量）
      if (iter % 40 === 0) {
        const branch = this.trace(nodes, newIdx)
        if (branch.length >= 4) {
          candidates.push({ points: branch, cost: nodes[newIdx].g })
          if (candidates.length > 60) candidates.shift()
        }
      }
    }

    if (goalIdx < 0) {
      return {
        success: false,
        path: [],
        expandedNodes: nodes.length,
        message: `${this.star ? 'RRT*' : 'RRT'} 达到采样上限仍未到达目标`,
        candidates
      }
    }

    const path = this.trace(nodes, goalIdx)
    const cost = pathWeightedCost(env, path, plan, weights)
    candidates.push({ points: path, cost })
    return {
      success: true,
      path,
      expandedNodes: nodes.length,
      message: `${this.star ? 'RRT*' : 'RRT'} 规划成功`,
      candidates
    }
  }

  /** 扩展动力学校验：祖父-父-新点的转弯角与爬升角 */
  private edgeDynamicsOk(nodes: RRTNode[], fromIdx: number, next: Vec3): boolean {
    const { plan } = this.ctx
    if (!plan.dynamics.enforceInSearch) return true
    const from = nodes[fromIdx]
    const prev = from.parent >= 0 ? nodes[from.parent].p : null
    return extensionAllowed(plan.dynamics, prev, from.p, next)
  }

  private nearestNode(nodes: RRTNode[], p: Vec3): number {
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i].p
      const d = (n.x - p.x) ** 2 + (n.y - p.y) ** 2 + (n.z - p.z) ** 2
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return best
  }

  private edgeCost(a: Vec3, b: Vec3): number {
    const { env, weights } = this.ctx
    const l = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
    const threat = ((env.threatIntensity(a) + env.threatIntensity(b)) / 2) * l
    const nofly = ((env.noflyPenalty(a) + env.noflyPenalty(b)) / 2) * l
    return l * weights.distance + threat * weights.threat + nofly * weights.nofly
  }

  private trace(nodes: RRTNode[], idx: number): Vec3[] {
    const path: Vec3[] = []
    let cur: number = idx
    while (cur >= 0) {
      path.push(nodes[cur].p)
      cur = nodes[cur].parent
    }
    path.reverse()
    return path
  }
}
