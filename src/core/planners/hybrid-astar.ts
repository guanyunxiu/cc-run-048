import type { Vec3 } from '@/types'
import type { PlannerOutput, PathPlanner, PlannerContext } from '@/core/planners/types'
import { extensionAllowed } from '@/core/dynamics'

/**
 * Hybrid A* 三维规划器（功能01）。
 * 状态 = 空间栅格 (ix,iy,iz) + 航向档位 ih；
 * 扩展使用相对当前航向的运动基元（直行 / 左右不同转弯档 × 平飞/爬升/下滑），
 * 天然满足最大转弯角、最大爬升角与最小步长等动力学约束。
 * 代价 = 航程 + 威胁/禁飞场 + 转角平滑，启发 = 欧氏距离 × 权重。
 */

interface HNode {
  key: number
  ix: number
  iy: number
  iz: number
  ih: number
  p: Vec3
  yaw: number
  g: number
  parent: number
}

export class HybridAStarPlanner implements PathPlanner {
  private ctx: PlannerContext
  constructor(ctx: PlannerContext) {
    this.ctx = ctx
  }

  plan(start: Vec3, goal: Vec3): PlannerOutput {
    const { env, plan, weights } = this.ctx
    const cs = plan.cellSize
    const hc = plan.heightCell
    const half = env.terrain.params.size / 2
    const nx = Math.floor(env.terrain.params.size / cs) + 1
    const ny = Math.floor(env.maxAltitude / hc) + 1
    const HEADINGS = 16
    const idxKey = (ix: number, iy: number, iz: number, ih: number) =>
      ix + nx * (iz + nx * (iy + ny * ih))

    const toGrid = (p: Vec3) => ({
      ix: clampInt(Math.round((p.x + half) / cs), 0, nx - 1),
      iy: clampInt(Math.round(p.y / hc), 0, ny - 1),
      iz: clampInt(Math.round((p.z + half) / cs), 0, nx - 1)
    })
    const toWorld = (ix: number, iy: number, iz: number): Vec3 => ({
      x: -half + ix * cs,
      y: iy * hc,
      z: -half + iz * cs
    })

    // 起点吸附到最近自由栅格
    const sg = nearestFree(toGrid(start), (g) => {
      const w = toWorld(g.ix, g.iy, g.iz)
      return !env.isBlocked(w, plan.clearance)
    })
    const gg = nearestFree(toGrid(goal), (g) => {
      const w = toWorld(g.ix, g.iy, g.iz)
      return !env.isBlocked(w, plan.clearance)
    })
    if (!sg || !gg) {
      return {
        success: false,
        path: [],
        expandedNodes: 0,
        message: '起终点附近无可行栅格'
      }
    }

    const startWorld = { ...start }
    const goalWorld = toWorld(gg.ix, gg.iy, gg.iz)
    const initYaw = Math.atan2(goalWorld.x - startWorld.x, goalWorld.z - startWorld.z)
    const initH = yawToBin(initYaw, HEADINGS)

    const nodes: HNode[] = []
    const index = new Map<number, number>()
    const gScore = new Map<number, number>()
    const cameFrom = new Map<number, number>()
    const open: { key: number; f: number }[] = []

    const startKey = idxKey(sg.ix, sg.iy, sg.iz, initH)
    gScore.set(startKey, 0)
    nodes.push({
      key: startKey,
      ix: sg.ix,
      iy: sg.iy,
      iz: sg.iz,
      ih: initH,
      p: startWorld,
      yaw: initYaw,
      g: 0,
      parent: -1
    })
    index.set(startKey, 0)
    openPush(open, startKey, this.heuristic(startWorld, goalWorld))

    // 运动基元：转弯档位 × 爬升档位
    const turnLevels: number[] = (() => {
      const m = plan.tuning.motionPrims
      const maxTurn = (plan.dynamics.maxTurnAngle * Math.PI) / 180
      const arr = [0]
      for (let i = 1; i <= m; i++) {
        const a = (maxTurn * i) / m
        arr.push(-a, a)
      }
      return arr
    })()
    const climbLevels = [
      -(plan.dynamics.maxClimbAngle * Math.PI) / 180,
      0,
      (plan.dynamics.maxClimbAngle * Math.PI) / 180
    ]
    const stepLen = Math.max(cs * plan.maxStep, plan.dynamics.minStep * 1.2)

    let expanded = 0
    const closed = new Set<number>()
    let goalKey = -1

    while (open.length > 0) {
      const cur = openPop(open)
      if (cur < 0) break
      if (closed.has(cur)) continue
      closed.add(cur)
      const curNode = index.get(cur)!
      const node = nodes[curNode]
      expanded++
      if (expanded > plan.maxNodes) {
        return {
          success: false,
          path: [],
          expandedNodes: expanded,
          message: 'Hybrid A* 达到扩展上限'
        }
      }
      if (node.ix === gg.ix && node.iy === gg.iy && node.iz === gg.iz) {
        goalKey = cur
        break
      }

      // 解析扩展：周期性尝试当前节点直连目标（Hybrid A* 标准做法）
      if (
        expanded % 3 === 0 &&
        env.isSegmentFeasible(node.p, goalWorld, plan.clearance)
      ) {
        const gParent = node.parent >= 0 ? nodes[node.parent].p : null
        if (
          !plan.dynamics.enforceInSearch ||
          extensionAllowed(plan.dynamics, gParent, node.p, goalWorld)
        ) {
          goalKey = cur
          break
        }
      }

      for (const dYaw of turnLevels) {
        for (const climb of climbLevels) {
          const yaw = node.yaw + dYaw
          const len = stepLen
          const next: Vec3 = {
            x: node.p.x + Math.sin(yaw) * Math.cos(climb) * len,
            y: node.p.y + Math.sin(climb) * len,
            z: node.p.z + Math.cos(yaw) * Math.cos(climb) * len
          }
          if (next.y < hc) continue
          const g = toGrid(next)
          if (g.ix < 0 || g.iy < 0 || g.iz < 0 || g.ix >= nx || g.iy >= ny || g.iz >= nx)
            continue
          // 动力学约束二次校验（转弯/爬升/步长）
          const parent = node.parent >= 0 ? nodes[node.parent].p : null
          if (
            plan.dynamics.enforceInSearch &&
            !extensionAllowed(plan.dynamics, parent, node.p, next)
          )
            continue
          if (!env.isSegmentFeasible(node.p, next, plan.clearance)) continue

          const ih = yawToBin(yaw, HEADINGS)
          const key = idxKey(g.ix, g.iy, g.iz, ih)
          if (closed.has(key)) continue

          const l = Math.hypot(
            next.x - node.p.x,
            next.y - node.p.y,
            next.z - node.p.z
          )
          const threat =
            ((env.threatIntensity(node.p) + env.threatIntensity(next)) / 2) * l
          const nofly =
            ((env.noflyPenalty(node.p) + env.noflyPenalty(next)) / 2) * l
          const turnPenalty = Math.abs(dYaw / Math.PI) * l
          const stepCost =
            l * weights.distance +
            threat * weights.threat +
            nofly * weights.nofly +
            turnPenalty * weights.smooth
          const tentative = node.g + stepCost
          if (tentative < (gScore.get(key) ?? Infinity)) {
            gScore.set(key, tentative)
            cameFrom.set(key, cur)
            if (!index.has(key)) {
              nodes.push({
                key,
                ix: g.ix,
                iy: g.iy,
                iz: g.iz,
                ih,
                p: next,
                yaw,
                g: tentative,
                parent: curNode
              })
              index.set(key, nodes.length - 1)
            } else {
              const n = nodes[index.get(key)!]
              n.p = next
              n.yaw = yaw
              n.g = tentative
              n.parent = curNode
            }
            openPush(open, key, tentative + this.heuristic(next, goalWorld))
          }
        }
      }
      if (goalKey >= 0) break
    }

    if (goalKey < 0) {
      return {
        success: false,
        path: [],
        expandedNodes: expanded,
        message: 'Hybrid A* 未找到可行运动基元路径'
      }
    }

    // 回溯
    const path: Vec3[] = []
    let kk: number | undefined = goalKey
    while (kk !== undefined) {
      const nodeIdx = index.get(kk)
      if (nodeIdx === undefined) break
      path.push(nodes[nodeIdx].p)
      kk = cameFrom.get(kk)
    }
    path.reverse()
    // 用精确起终点替换栅格吸附端点（解析扩展时终点由 goal 补齐）
    path[0] = { ...start }
    path[path.length - 1] = { ...goal }
    return {
      success: true,
      path,
      expandedNodes: expanded,
      message: 'Hybrid A* 规划成功'
    }
  }

  private heuristic(a: Vec3, b: Vec3): number {
    const { plan, weights } = this.ctx
    const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
    return d * weights.distance * plan.heuristicWeight
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function yawToBin(yaw: number, headings: number): number {
  let y = yaw
  while (y < 0) y += Math.PI * 2
  while (y >= Math.PI * 2) y -= Math.PI * 2
  return Math.round((y / (Math.PI * 2)) * headings) % headings
}

function nearestFree(
  g: { ix: number; iy: number; iz: number },
  free: (g: { ix: number; iy: number; iz: number }) => boolean
): { ix: number; iy: number; iz: number } | null {
  for (let r = 0; r <= 4; r++) {
    let best: { ix: number; iy: number; iz: number } | null = null
    let bestD = Infinity
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue
          const cand = { ix: g.ix + dx, iy: g.iy + dy, iz: g.iz + dz }
          if (!free(cand)) continue
          const d = dx * dx + dy * dy + dz * dz
          if (d < bestD) {
            bestD = d
            best = cand
          }
        }
      }
    }
    if (best) return best
  }
  return null
}

/** 二叉堆（[key,f] 小顶堆） */
function openPush(heap: { key: number; f: number }[], key: number, f: number) {
  heap.push({ key, f })
  let i = heap.length - 1
  while (i > 0) {
    const p = (i - 1) >> 1
    if (heap[p].f <= heap[i].f) break
    ;[heap[p], heap[i]] = [heap[i], heap[p]]
    i = p
  }
}
function openPop(heap: { key: number; f: number }[]): number {
  const top = heap[0]
  const last = heap.pop()!
  if (heap.length > 0) {
    heap[0] = last
    let i = 0
    const n = heap.length
    for (;;) {
      const l = i * 2 + 1
      const r = l + 1
      let s = i
      if (l < n && heap[l].f < heap[s].f) s = l
      if (r < n && heap[r].f < heap[s].f) s = r
      if (s === i) break
      ;[heap[s], heap[i]] = [heap[i], heap[s]]
      i = s
    }
  }
  return top.key
}
