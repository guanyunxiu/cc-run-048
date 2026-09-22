import type {
  CostWeights,
  PlanParams,
  Vec3
} from '@/types'
import type { Environment } from './environment'
import { clamp, dist } from '@/utils/math3d'
import { zeroWeights, type SegmentCosts } from './cost'

/** 二叉小顶堆优先队列（存储 [节点索引, f]） */
class MinHeap {
  private keys: number[] = []
  private vals: number[] = []

  get size(): number {
    return this.keys.length
  }

  push(key: number, val: number): void {
    this.keys.push(key)
    this.vals.push(val)
    let i = this.keys.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.vals[parent] <= this.vals[i]) break
      this.swap(i, parent)
      i = parent
    }
  }

  pop(): { key: number; val: number } {
    const key = this.keys[0]
    const val = this.vals[0]
    const lastK = this.keys.pop()!
    const lastV = this.vals.pop()!
    if (this.keys.length > 0) {
      this.keys[0] = lastK
      this.vals[0] = lastV
      let i = 0
      const n = this.keys.length
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let smallest = i
        if (l < n && this.vals[l] < this.vals[smallest]) smallest = l
        if (r < n && this.vals[r] < this.vals[smallest]) smallest = r
        if (smallest === i) break
        this.swap(i, smallest)
        i = smallest
      }
    }
    return { key, val }
  }

  private swap(i: number, j: number): void {
    ;[this.keys[i], this.keys[j]] = [this.keys[j], this.keys[i]]
    ;[this.vals[i], this.vals[j]] = [this.vals[j], this.vals[i]]
  }
}

export interface GridPlanResult {
  success: boolean
  path: Vec3[]
  expandedNodes: number
  message: string
}

interface GridDims {
  nx: number
  ny: number
  nz: number
  ox: number
  oz: number
  count: number
}

/**
 * 三维体素栅格图搜索（A* / Dijkstra）。
 * - 26 邻域，maxStep>1 时增加长步长扩展（跳点，中间点做碰撞采样）
 * - 代价分量按端点场值近似积分，避免逐边重采样
 */
export class GridPlanner {
  private env: Environment
  private params: PlanParams
  private weights: CostWeights
  /**
   * 规划碰撞净空 = 用户安全距离 + 栅格半对角裕量。
   * 保证的是“任意栅格中心自由”，而平滑/加密后的连续点落在栅格之间，
   * 半对角裕量确保最终航迹在用户 clearance 口径下持续无碰撞。
   */
  private inflatedClearance: number
  private dims: GridDims
  private visited: Uint8Array
  private gScore: Map<number, number>
  private cameFrom: Map<number, number>
  private threatCache: Float32Array
  private noflyCache: Float32Array
  private offsets: { dx: number; dy: number; dz: number }[] = []

  constructor(env: Environment, plan: PlanParams, weights: CostWeights) {
    this.env = env
    this.params = plan
    this.weights = weights

    const size = env.terrain.params.size
    const nx = Math.floor(size / plan.cellSize) + 1
    const nz = nx
    const ny = Math.floor(env.maxAltitude / plan.heightCell) + 1
    const count = nx * ny * nz
    if (count > 4_000_000) {
      throw new Error(
        '体素数量过大，请增大栅格分辨率（cellSize / heightCell）'
      )
    }
    this.dims = { nx, ny, nz, ox: -size / 2, oz: -size / 2, count }
    const halfDiag = Math.hypot(plan.cellSize, plan.cellSize, plan.heightCell) / 2
    this.inflatedClearance = plan.clearance + halfDiag
    this.visited = new Uint8Array(count)
    this.gScore = new Map()
    this.cameFrom = new Map()
    this.threatCache = new Float32Array(count).fill(-1)
    this.noflyCache = new Float32Array(count).fill(-1)
    this.buildOffsets()
  }

  private buildOffsets(): void {
    // 基础 26 邻域
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue
          this.offsets.push({ dx, dy, dz })
        }
      }
    }
    // 长步长：各分量取 [-s,-2,0,2,s] 的组合（至少一个分量绝对值>=2）
    const s = clamp(Math.round(this.params.maxStep), 1, 3)
    if (s >= 2) {
      const vals = s >= 3 ? [-3, -2, 2, 3] : [-2, 2]
      for (const dx of vals) {
        for (const dy of vals) {
          for (const dz of vals) {
            // 与 26 邻域不重复
            if (
              Math.abs(dx) <= 1 &&
              Math.abs(dy) <= 1 &&
              Math.abs(dz) <= 1
            ) {
              continue
            }
            this.offsets.push({ dx, dy, dz })
          }
        }
      }
    }
  }

  private idx(ix: number, iy: number, iz: number): number {
    const { nx, ny, nz } = this.dims
    return ix + nx * (iz + nz * iy)
  }

  private toWorld(ix: number, iy: number, iz: number): Vec3 {
    const { ox, oz } = this.dims
    return {
      x: ox + ix * this.params.cellSize,
      y: iy * this.params.heightCell,
      z: oz + iz * this.params.cellSize
    }
  }

  private toGrid(p: Vec3): { ix: number; iy: number; iz: number } {
    const { ox, oz } = this.dims
    return {
      ix: clamp(
        Math.round((p.x - ox) / this.params.cellSize),
        0,
        this.dims.nx - 1
      ),
      iy: clamp(
        Math.round(p.y / this.params.heightCell),
        0,
        this.dims.ny - 1
      ),
      iz: clamp(
        Math.round((p.z - oz) / this.params.cellSize),
        0,
        this.dims.nz - 1
      )
    }
  }

  private threatAt(idx: number, p: Vec3): number {
    let v = this.threatCache[idx]
    if (v < 0) {
      v = this.env.threatIntensity(p)
      this.threatCache[idx] = v
    }
    return v
  }

  private noflyAt(idx: number, p: Vec3): number {
    let v = this.noflyCache[idx]
    if (v < 0) {
      v = this.env.noflyPenalty(p)
      this.noflyCache[idx] = v
    }
    return v
  }

  private isFree(idx: number, p: Vec3): boolean {
    if (this.visited[idx] === 0) {
      this.visited[idx] = this.env.isBlocked(p, this.inflatedClearance)
        ? 2
        : 1
    }
    return this.visited[idx] === 1
  }

  /** 在目标栅格附近螺旋搜索最近的自由栅格 */
  private nearestFree(p: Vec3): number {
    const g = this.toGrid(p)
    const { nx, ny, nz } = this.dims
    for (let r = 0; r <= 4; r++) {
      let best = -1
      let bestD = Infinity
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue
            const ix = g.ix + dx
            const iy = g.iy + dy
            const iz = g.iz + dz
            if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz)
              continue
            const id = this.idx(ix, iy, iz)
            const w = this.toWorld(ix, iy, iz)
            if (!this.isFree(id, w)) continue
            const d =
              (w.x - p.x) ** 2 +
              (w.y - p.y) ** 2 +
              (w.z - p.z) ** 2
            if (d < bestD) {
              bestD = d
              best = id
            }
          }
        }
      }
      if (best >= 0) return best
    }
    return -1
  }

  private heuristic(a: Vec3, b: Vec3): number {
    if (this.params.algo === 'dijkstra') return 0
    const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
    return d * this.params.heuristicWeight * this.weights.distance
  }

  /** 边代价：端点场值的梯形近似 + 转角平滑 */
  private edgeCost(
    parentIdx: number,
    curIdx: number,
    nextIdx: number,
    cur: Vec3,
    next: Vec3
  ): number {
    const length = Math.hypot(
      next.x - cur.x,
      next.y - cur.y,
      next.z - cur.z
    )
    const w = this.weights
    const threat =
      ((this.threatAt(curIdx, cur) + this.threatAt(nextIdx, next)) / 2) *
      length
    const nofly =
      ((this.noflyAt(curIdx, cur) + this.noflyAt(nextIdx, next)) / 2) *
      length
    const alt =
      ((Math.abs(cur.y - this.params.cruiseAlt) +
        Math.abs(next.y - this.params.cruiseAlt)) /
        2 /
        Math.max(this.params.cruiseAlt, 1)) *
      length

    let smooth = 0
    const pIdx = this.cameFrom.get(curIdx) ?? parentIdx
    if (pIdx >= 0) {
      const pp = this.idxToPos(pIdx)
      if (pp) {
        const v1x = cur.x - pp.x
        const v1y = cur.y - pp.y
        const v1z = cur.z - pp.z
        const l1 = Math.hypot(v1x, v1y, v1z)
        if (l1 > 1e-6) {
          const dot =
            (v1x * (next.x - cur.x) +
              v1y * (next.y - cur.y) +
              v1z * (next.z - cur.z)) /
            (l1 * length)
          smooth = 1 - Math.max(-1, Math.min(1, dot))
        }
      }
    }

    return (
      length * w.distance +
      threat * w.threat +
      alt * w.altitude +
      nofly * w.nofly +
      smooth * length * w.smooth
    )
  }

  private idxToPos(id: number): Vec3 | null {
    const { nx, ny, nz } = this.dims
    const ix = id % nx
    let t = (id / nx) | 0
    const iz = t % nz
    t = (t / nz) | 0
    const iy = t % ny
    if (iy >= ny) return null
    return this.toWorld(ix, iy, iz)
  }

  /**
   * 边碰撞采样：沿航段按固定世界间距（约 0.75 cell）检查中间点。
   * 长对角边只检测端点会漏穿山角/建筑，故所有边统一采样。
   */
  private edgeClear(cur: Vec3, next: Vec3): boolean {
    const length = Math.hypot(
      next.x - cur.x,
      next.y - cur.y,
      next.z - cur.z
    )
    const stepWorld = Math.min(this.params.cellSize, this.params.heightCell)
    let inner = Math.max(0, Math.ceil(length / stepWorld) - 1)
    // 短对角边也插入中点，避免切角穿障
    if (inner === 0 && length > stepWorld * 0.8) inner = 1
    if (inner <= 0) return true
    for (let i = 1; i <= inner; i++) {
      const t = i / (inner + 1)
      const p: Vec3 = {
        x: cur.x + (next.x - cur.x) * t,
        y: cur.y + (next.y - cur.y) * t,
        z: cur.z + (next.z - cur.z) * t
      }
      // 用体素索引查询，保证与该区域栅格口径一致
      const g = this.toGrid(p)
      const id = this.idx(g.ix, g.iy, g.iz)
      if (!this.isFree(id, this.toWorld(g.ix, g.iy, g.iz))) return false
    }
    return true
  }

  plan(start: Vec3, goal: Vec3): GridPlanResult {
    const startIdx = this.nearestFree(start)
    const goalIdx = this.nearestFree(goal)
    if (startIdx < 0) return { success: false, path: [], expandedNodes: 0, message: '起点附近无可行栅格（可能位于地形/禁飞区内）' }
    if (goalIdx < 0) return { success: false, path: [], expandedNodes: 0, message: '终点附近无可行栅格（可能位于地形/禁飞区内）' }

    const open = new MinHeap()
    this.gScore.set(startIdx, 0)
    const startPos = this.idxToPos(startIdx)!
    const goalPos = this.idxToPos(goalIdx)!
    open.push(startIdx, this.heuristic(startPos, goalPos))

    const { nx, ny, nz } = this.dims
    let expanded = 0
    const closed = new Uint8Array(this.dims.count)

    while (open.size > 0) {
      const { key: curIdx } = open.pop()
      if (closed[curIdx]) continue
      closed[curIdx] = 1
      expanded++
      if (expanded > this.params.maxNodes) {
        return { success: false, path: [], expandedNodes: expanded, message: '达到最大扩展节点数，未找到路径' }
      }
      if (curIdx === goalIdx) {
        return {
          success: true,
          path: this.pinEndpoints(this.reconstruct(goalIdx), start, goal),
          expandedNodes: expanded,
          message: '规划成功'
        }
      }

      const cur = this.idxToPos(curIdx)!
      const gCur = this.gScore.get(curIdx)!
      const cix = curIdx % nx
      let t = (curIdx / nx) | 0
      const ciz = t % nz
      const ciy = (t / nz) | 0

      for (const o of this.offsets) {
        const ix = cix + o.dx
        const iy = ciy + o.dy
        const iz = ciz + o.dz
        if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz)
          continue
        const nIdx = this.idx(ix, iy, iz)
        if (closed[nIdx]) continue
        const next = this.toWorld(ix, iy, iz)
        if (!this.isFree(nIdx, next)) continue

        const longStep = Math.max(Math.abs(o.dx), Math.abs(o.dy), Math.abs(o.dz))
        if (!this.edgeClear(cur, next)) continue

        const stepCost = this.edgeCost(-1, curIdx, nIdx, cur, next)
        const tentative = gCur + stepCost
        if (tentative < (this.gScore.get(nIdx) ?? Infinity)) {
          this.cameFrom.set(nIdx, curIdx)
          this.gScore.set(nIdx, tentative)
          open.push(nIdx, tentative + this.heuristic(next, goalPos))
        }
      }
    }

    return {
      success: false,
      path: [],
      expandedNodes: expanded,
      message: '开放列表耗尽：目标不可达（可能被地形/禁飞区完全封闭）'
    }
  }

  private reconstruct(goalIdx: number): Vec3[] {
    const path: Vec3[] = []
    let cur: number | undefined = goalIdx
    while (cur !== undefined) {
      path.push(this.idxToPos(cur)!)
      cur = this.cameFrom.get(cur)
    }
    path.reverse()
    return path
  }

  /**
   * 端点归位：栅格搜索的起终点被吸附到最近自由栅格中心，
   * 直接返回会偏离用户设定的航点（最多约一个栅格）。
   * 这里把首末点替换/前插为精确起终点，新边按用户安全距离验证，
   * 验证不过（航点本身贴近障碍等极端情况）则保留栅格端点。
   */
  private pinEndpoints(path: Vec3[], start: Vec3, goal: Vec3): Vec3[] {
    if (path.length === 0) return path
    const out = path.map((p) => ({ ...p }))
    const clearance = this.params.clearance

    if (dist(out[0], start) > 1e-6) {
      if (
        out.length >= 2 &&
        this.env.isSegmentFeasible(start, out[1], clearance)
      ) {
        out[0] = { ...start }
      } else if (this.env.isSegmentFeasible(start, out[0], clearance)) {
        out.unshift({ ...start })
      }
    }

    const last = out.length - 1
    if (dist(out[last], goal) > 1e-6) {
      if (
        out.length >= 2 &&
        this.env.isSegmentFeasible(out[last - 1], goal, clearance)
      ) {
        out[last] = { ...goal }
      } else if (this.env.isSegmentFeasible(out[last], goal, clearance)) {
        out.push({ ...goal })
      }
    }
    return out
  }
}

/** 用于统计/测试：汇总路径代价分量（规划器图内近似口径） */
export function sumSegmentCosts(costs: SegmentCosts[]): CostWeights {
  const s = zeroWeights()
  for (const c of costs) {
    s.distance += c.distance
    s.threat += c.threat
    s.altitude += c.altitude
    s.nofly += c.nofly
    s.smooth += c.smooth
  }
  return s
}
