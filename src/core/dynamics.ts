import type {
  ConstraintReport,
  DynamicsParams,
  PlanParams,
  Vec3
} from '@/types'
import type { Environment } from './environment'
import type { TrajectorySample } from './smoothing'
import { cumulativeLengths, dist, lerp } from '@/utils/math3d'

const RAD2DEG = 180 / Math.PI

/** 水平偏航角（弧度，0..PI）：prev->cur 与 cur->next 两方向的夹角 */
export function turnAngleRad(prev: Vec3, cur: Vec3, next: Vec3): number {
  const v1x = cur.x - prev.x
  const v1z = cur.z - prev.z
  const v2x = next.x - cur.x
  const v2z = next.z - cur.z
  const l1 = Math.hypot(v1x, v1z)
  const l2 = Math.hypot(v2x, v2z)
  if (l1 < 1e-9 || l2 < 1e-9) return 0
  const c = (v1x * v2x + v1z * v2z) / (l1 * l2)
  return Math.acos(Math.max(-1, Math.min(1, c)))
}

/** 爬升角（弧度，带符号）：a->b 方向与水平面的夹角 */
export function climbAngleRad(a: Vec3, b: Vec3): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dz = b.z - a.z
  const l = Math.hypot(dx, dy, dz)
  if (l < 1e-9) return 0
  return Math.asin(Math.max(-1, Math.min(1, dy / l)))
}

/**
 * 搜索期扩展可行性（功能03）：
 * 给树/图节点扩展 cur->next（prev 为 cur 父节点）时，
 * 检查最小步长、最大转弯角、最大爬升角。
 */
export function extensionAllowed(
  dyn: DynamicsParams,
  prev: Vec3 | null,
  cur: Vec3,
  next: Vec3
): boolean {
  const step = dist(cur, next)
  if (step + 1e-6 < dyn.minStep) return false
  if (prev) {
    const turn = turnAngleRad(prev, cur, next) * RAD2DEG
    if (turn > dyn.maxTurnAngle + 1e-6) return false
  }
  const climb = Math.abs(climbAngleRad(cur, next)) * RAD2DEG
  if (climb > dyn.maxClimbAngle + 1e-6) return false
  return true
}

/** 三点水平曲率（1/米）：外接圆半径的倒数；共线时返回 0 */
export function horizontalCurvature(a: Vec3, b: Vec3, c: Vec3): number {
  const v1x = b.x - a.x
  const v1z = b.z - a.z
  const v2x = c.x - b.x
  const v2z = c.z - b.z
  const l1 = Math.hypot(v1x, v1z)
  const l2 = Math.hypot(v2x, v2z)
  if (l1 < 1e-9 || l2 < 1e-9) return 0
  const cross = v1x * v2z - v1z * v2x
  const dot = v1x * v2x + v1z * v2z
  const sinA = Math.abs(cross) / (l1 * l2)
  if (sinA < 1e-4) return 0
  // 外接圆半径 R = l3 / (2 sin A)，l3 为 a->c 水平距离
  const l3 = Math.hypot(c.x - a.x, c.z - a.z)
  const r = l3 / (2 * sinA)
  return r > 1e-6 ? 1 / r : 0
}

/**
 * 航迹动力学检查与统计（功能03）。
 * dense 为均匀加密的航迹；traj 为时间参数化轨迹（可选，用于加速度/姿态率）。
 */
export function checkPathConstraints(
  dense: Vec3[],
  dyn: DynamicsParams,
  traj?: TrajectorySample[]
): ConstraintReport {
  const report: ConstraintReport = {
    samples: dense.length,
    turnViolations: 0,
    climbViolations: 0,
    stepViolations: 0,
    radiusViolations: 0,
    accelViolations: 0,
    attitudeRateViolations: 0,
    satisfactionRate: 100,
    violationIndices: []
  }
  if (dense.length < 2) return report

  const cum = cumulativeLengths(dense)
  const total = cum[cum.length - 1]
  // 定弦长前瞻：使转弯/曲率统计与点密度无关
  const chord = Math.max(dyn.minTurnRadius * 1.2, 20)

  const pointAt = (s: number): { p: Vec3; idx: number } => {
    const target = Math.max(0, Math.min(total, s))
    // 二分
    let lo = 0
    let hi = cum.length - 1
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (cum[mid] <= target) lo = mid
      else hi = mid
    }
    const segLen = cum[hi] - cum[lo]
    const t = segLen > 1e-9 ? (target - cum[lo]) / segLen : 0
    return { p: lerp(dense[lo], dense[hi], t), idx: lo }
  }

  const flagged = new Set<number>()
  let geometricChecks = 0
  let geometricBad = 0

  for (let i = 0; i < dense.length; i++) {
    // 转弯角 & 转弯半径（定弦前后瞻）
    if (cum[i] > chord && total - cum[i] > chord) {
      const a = pointAt(cum[i] - chord).p
      const b = dense[i]
      const c = pointAt(cum[i] + chord).p
      geometricChecks++
      const turn = turnAngleRad(a, b, c) * RAD2DEG
      let bad = false
      if (turn > dyn.maxTurnAngle) {
        report.turnViolations++
        bad = true
      }
      if (turn > 2) {
        const curv = horizontalCurvature(a, b, c)
        if (curv > 1 / Math.max(dyn.minTurnRadius, 1e-6)) {
          report.radiusViolations++
          bad = true
        }
      }
      if (bad) {
        geometricBad++
        flagged.add(i)
      }
    }
  }

  // 爬升角（逐段）与异常碎步检测（逐段）
  // 注：加密点间距本就可小于 minStep，这里仅标记停滞/回退式的异常碎段
  // （长度 < minStep*0.3），真正的最小步长约束在搜索扩展期保证。
  for (let i = 1; i < dense.length; i++) {
    geometricChecks++
    const climb = Math.abs(climbAngleRad(dense[i - 1], dense[i])) * RAD2DEG
    const segLen = dist(dense[i - 1], dense[i])
    let bad = false
    if (climb > dyn.maxClimbAngle) {
      report.climbViolations++
      bad = true
    }
    if (segLen < dyn.minStep * 0.3 && segLen > 1e-9) {
      report.stepViolations++
      bad = true
    }
    if (bad) {
      geometricBad++
      flagged.add(i)
    }
  }

  // 时间维：加速度 / 姿态变化率
  if (traj && traj.length >= 3) {
    let timeChecks = 0
    let timeBad = 0
    for (let i = 1; i < traj.length - 1; i++) {
      const dt = traj[i + 1].time - traj[i - 1].time
      if (dt <= 1e-6) continue
      timeChecks++
      const ax = (traj[i + 1].velocity.x - traj[i - 1].velocity.x) / dt
      const ay = (traj[i + 1].velocity.y - traj[i - 1].velocity.y) / dt
      const az = (traj[i + 1].velocity.z - traj[i - 1].velocity.z) / dt
      let bad = false
      if (Math.hypot(ax, ay, az) > dyn.maxAccel * 1.15) {
        report.accelViolations++
        bad = true
      }
      const yaw1 = Math.atan2(traj[i - 1].velocity.x, traj[i - 1].velocity.z)
      const yaw2 = Math.atan2(traj[i + 1].velocity.x, traj[i + 1].velocity.z)
      let dyaw = Math.abs(yaw2 - yaw1) * RAD2DEG
      if (dyaw > 180) dyaw = 360 - dyaw
      if (dyaw / dt > dyn.maxAttitudeRate * 1.15) {
        report.attitudeRateViolations++
        bad = true
      }
      if (bad) timeBad++
    }
    const geomRate =
      geometricChecks > 0 ? 1 - geometricBad / geometricChecks : 1
    const timeRate = timeChecks > 0 ? 1 - timeBad / timeChecks : 1
    report.satisfactionRate =
      Math.round((geomRate * 0.7 + timeRate * 0.3) * 1000) / 10
  } else {
    report.satisfactionRate =
      geometricChecks > 0
        ? Math.round((1 - geometricBad / geometricChecks) * 1000) / 10
        : 100
  }

  report.violationIndices = [...flagged].sort((a, b) => a - b)
  return report
}

/**
 * 航迹可行性自动修正（功能03）：
 * 对违反转弯/爬升角的顶点做碰撞感知的拉普拉斯松弛（向邻点中点收缩），
 * 仅接受同时满足动力学约束与环境净空的移动。
 */
export function repairPathDynamics(
  env: Environment,
  path: Vec3[],
  plan: PlanParams,
  iterations = 12
): Vec3[] {
  const dyn = plan.dynamics
  if (path.length < 3) return path.map((p) => ({ ...p }))
  const pts = path.map((p) => ({ ...p }))
  const clearance = plan.clearance
  const alpha = 0.4

  const moveOk = (i: number, cand: Vec3, snap: Vec3[]): boolean => {
    // 注意：不对密采样曲线施加最小步长门槛（曲线点间距本可小于 minStep，
    // 最小步长在原始航段搜索期保证）；此处只校验转弯角/爬升角与碰撞。
    const turnClimbOk = (pp: Vec3 | null, a: Vec3, b: Vec3): boolean => {
      if (pp) {
        const turn = turnAngleRad(pp, a, b) * RAD2DEG
        if (turn > dyn.maxTurnAngle) return false
      }
      return Math.abs(climbAngleRad(a, b)) * RAD2DEG <= dyn.maxClimbAngle
    }
    if (i > 0) {
      if (!env.isSegmentFeasible(snap[i - 1], cand, clearance)) return false
      if (!turnClimbOk(i >= 2 ? snap[i - 2] : null, snap[i - 1], cand)) return false
    }
    if (i < snap.length - 1) {
      if (!env.isSegmentFeasible(cand, snap[i + 1], clearance)) return false
      if (!turnClimbOk(snap[i - 1] ?? null, cand, snap[i + 1])) return false
    }
    return true
  }

  for (let it = 0; it < iterations; it++) {
    const snap = pts.map((p) => ({ ...p }))
    let changed = false
    for (let i = 1; i < pts.length - 1; i++) {
      const prev = snap[i - 1]
      const next = snap[i + 1]
      const candidate: Vec3 = {
        x: pts[i].x + alpha * ((prev.x + next.x) / 2 - pts[i].x),
        y: pts[i].y + alpha * ((prev.y + next.y) / 2 - pts[i].y),
        z: pts[i].z + alpha * ((prev.z + next.z) / 2 - pts[i].z)
      }
      if (moveOk(i, candidate, snap)) {
        pts[i] = candidate
        changed = true
      }
    }
    if (!changed) break
  }
  return pts
}
