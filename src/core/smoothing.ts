import type { PlanParams, Vec3 } from '@/types'
import type { Environment } from './environment'
import {
  cumulativeLengths,
  dist,
  lerp,
  polylineLength
} from '@/utils/math3d'
import {
  climbAngleRad,
  extensionAllowed,
  horizontalCurvature,
  turnAngleRad
} from './dynamics'

/**
 * 折线平滑（拉普拉斯松弛 / 橡皮筋法）：
 * 内部节点向相邻节点中点移动，仅保留仍满足碰撞净空的更新。
 */
export function smoothPolyline(
  env: Environment,
  path: Vec3[],
  iterations: number,
  clearance: number,
  alpha = 0.35
): Vec3[] {
  if (path.length < 3) return path.map((p) => ({ ...p }))
  const pts = path.map((p) => ({ ...p }))
  for (let it = 0; it < iterations; it++) {
    const snapshot = pts.map((p) => ({ ...p }))
    for (let i = 1; i < pts.length - 1; i++) {
      const prev = snapshot[i - 1]
      const next = snapshot[i + 1]
      const candidate: Vec3 = {
        x: pts[i].x + alpha * ((prev.x + next.x) / 2 - pts[i].x),
        y: pts[i].y + alpha * ((prev.y + next.y) / 2 - pts[i].y),
        z: pts[i].z + alpha * ((prev.z + next.z) / 2 - pts[i].z)
      }
      if (
        env.isSegmentFeasible(snapshot[i - 1], candidate, clearance) &&
        env.isSegmentFeasible(candidate, snapshot[i + 1], clearance)
      ) {
        pts[i] = candidate
      }
    }
  }
  return pts
}

/**
 * 三次均匀 B 样条平滑。
 * 首尾控制点各重复 3 次（clamped），曲线精确插值起终点；
 * 输出在 feasibility 不满足时回退折线平滑。
 */
export function smoothBSpline(
  env: Environment,
  path: Vec3[],
  clearance: number,
  samplesPerSegment = 6,
  fallbackIterations = 3
): Vec3[] {
  if (path.length < 3) return path.map((p) => ({ ...p }))

  // 三次 B 样条只有在端点重复度 = 次数（3）时才插值端点；
  // 只重复 2 次时起点会偏出 (p1-p0)/6
  const cp = [
    path[0],
    path[0],
    ...path,
    path[path.length - 1],
    path[path.length - 1]
  ]
  const basis = (u: number) => {
    const u2 = u * u
    const u3 = u2 * u
    return [
      (1 - 3 * u + 3 * u2 - u3) / 6,
      (4 - 6 * u2 + 3 * u3) / 6,
      (1 + 3 * u + 3 * u2 - 3 * u3) / 6,
      u3 / 6
    ]
  }

  const out: Vec3[] = []
  for (let i = 0; i < cp.length - 3; i++) {
    const p0 = cp[i]
    const p1 = cp[i + 1]
    const p2 = cp[i + 2]
    const p3 = cp[i + 3]
    for (let s = 0; s < samplesPerSegment; s++) {
      const u = s / samplesPerSegment
      const b = basis(u)
      out.push({
        x: b[0] * p0.x + b[1] * p1.x + b[2] * p2.x + b[3] * p3.x,
        y: b[0] * p0.y + b[1] * p1.y + b[2] * p2.y + b[3] * p3.y,
        z: b[0] * p0.z + b[1] * p1.z + b[2] * p2.z + b[3] * p3.z
      })
    }
  }
  out.push({ ...cp[cp.length - 1] })

  // 可行性检查：B 样条可能切入障碍，逐段验证，失败则整体回退
  for (let i = 1; i < out.length; i++) {
    if (!env.isSegmentFeasible(out[i - 1], out[i], clearance)) {
      return smoothPolyline(env, path, fallbackIterations, clearance)
    }
  }
  return out
}

/**
 * 三次贝塞尔平滑（功能04）：以 Catmull-Rom 基函数逐段生成
 * C1 连续的三次曲线（每段等价于以相邻四点为控制信息的贝塞尔弧），
 * 首尾复制端点插值起终点；碰撞不满足时回退折线松弛。
 */
export function smoothBezier(
  env: Environment,
  path: Vec3[],
  clearance: number,
  samplesPerSegment = 8,
  fallbackIterations = 3
): Vec3[] {
  if (path.length < 3) return path.map((p) => ({ ...p }))
  const cp = [path[0], ...path, path[path.length - 1]]

  const out: Vec3[] = []
  for (let i = 0; i < cp.length - 3; i++) {
    const p0 = cp[i]
    const p1 = cp[i + 1]
    const p2 = cp[i + 2]
    const p3 = cp[i + 3]
    for (let s = 0; s < samplesPerSegment; s++) {
      const u = s / samplesPerSegment
      const u2 = u * u
      const u3 = u2 * u
      out.push({
        x:
          0.5 *
          (2 * p1.x +
            (-p0.x + p2.x) * u +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * u2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * u3),
        y:
          0.5 *
          (2 * p1.y +
            (-p0.y + p2.y) * u +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * u2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * u3),
        z:
          0.5 *
          (2 * p1.z +
            (-p0.z + p2.z) * u +
            (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * u2 +
            (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * u3)
      })
    }
  }
  out.push({ ...cp[cp.length - 1] })

  for (let i = 1; i < out.length; i++) {
    if (!env.isSegmentFeasible(out[i - 1], out[i], clearance)) {
      return smoothPolyline(env, path, fallbackIterations, clearance)
    }
  }
  return out
}

/**
 * 三次多项式平滑（功能04）：以累积弦长为参数，对 x/y/z 三个分量
 * 分别拟合自然三次样条（Natural Cubic Spline），再均匀重采样。
 * 碰撞不满足时回退折线松弛。
 */
export function smoothPolynomial(
  env: Environment,
  path: Vec3[],
  clearance: number,
  sampleSpacing = 6,
  fallbackIterations = 3
): Vec3[] {
  if (path.length < 3) return path.map((p) => ({ ...p }))

  // 累积弦长参数（归一化到 0..1）
  const t: number[] = [0]
  for (let i = 1; i < path.length; i++) t.push(t[i - 1] + dist(path[i - 1], path[i]))
  const total = t[t.length - 1] || 1
  const u = t.map((v) => v / total)

  const interpAxes: ('x' | 'y' | 'z')[] = ['x', 'y', 'z']
  const samples = Math.max(path.length * 4, Math.ceil(total / sampleSpacing))
  const out: Vec3[] = []
  for (let k = 0; k <= samples; k++) {
    const uu = k / samples
    const p: Vec3 = { x: 0, y: 0, z: 0 }
    for (const ax of interpAxes) {
      p[ax] = naturalSplineInterp(u, path.map((q) => q[ax]), uu)
    }
    out.push(p)
  }

  for (let i = 1; i < out.length; i++) {
    if (!env.isSegmentFeasible(out[i - 1], out[i], clearance)) {
      return smoothPolyline(env, path, fallbackIterations, clearance)
    }
  }
  return out
}

/** 自然三次样条插值：节点 xs（单调）、值 ys，求 x 处的值 */
function naturalSplineInterp(xs: number[], ys: number[], x: number): number {
  const n = xs.length - 1
  if (x <= xs[0]) return ys[0]
  if (x >= xs[n]) return ys[n]

  // 三对角求解二阶导 M（缓存到函数上不可行（每次调用），直接现场解，
  // 点数通常 < 数百，复杂度可接受）
  const h: number[] = []
  for (let i = 0; i < n; i++) h.push(xs[i + 1] - xs[i])
  const alpha: number[] = new Array(n + 1).fill(0)
  for (let i = 1; i < n; i++) {
    alpha[i] =
      (3 / h[i]) * (ys[i + 1] - ys[i]) -
      (3 / h[i - 1]) * (ys[i] - ys[i - 1])
  }
  const l = new Array<number>(n + 1).fill(0)
  const mu = new Array<number>(n + 1).fill(0)
  const z = new Array<number>(n + 1).fill(0)
  l[0] = 1
  for (let i = 1; i < n; i++) {
    l[i] = 2 * (xs[i + 1] - xs[i - 1]) - h[i - 1] * mu[i - 1]
    mu[i] = h[i] / l[i]
    z[i] = (alpha[i] - h[i - 1] * z[i - 1]) / l[i]
  }
  l[n] = 1
  const m = new Array<number>(n + 1).fill(0)
  for (let j = n - 1; j >= 0; j--) {
    m[j] = z[j] - mu[j] * m[j + 1]
  }

  let i = 0
  while (i < n && x > xs[i + 1]) i++
  const a = (xs[i + 1] - x) / h[i]
  const b = (x - xs[i]) / h[i]
  return (
    a * ys[i] +
    b * ys[i + 1] +
    ((a ** 3 - a) * m[i] * h[i] * h[i]) / 6 +
    ((b ** 3 - b) * m[i + 1] * h[i] * h[i]) / 6
  )
}

/**
 * Dubins 平滑（功能04）：
 * 先用 RDP 抽稀航迹得到带航向的航路点，再在水平面内以
 * 最小转弯半径 R 构造 LSL/RSR/LSR/RSL 最短 Dubins 弧线连接，
 * 高度按弧长线性过渡。整段碰撞验证失败则回退折线松弛。
 */
export function smoothDubins(
  env: Environment,
  path: Vec3[],
  clearance: number,
  turnRadius: number,
  sampleSpacing = 6,
  fallbackIterations = 3
): Vec3[] {
  if (path.length < 3) return path.map((p) => ({ ...p }))
  const wps = rdpSimplify(path, turnRadius * 0.35)
  if (wps.length < 2) return path.map((p) => ({ ...p }))

  interface Pose {
    x: number
    z: number
    y: number
    yaw: number
  }
  const poses: Pose[] = wps.map((p, i) => {
    const prev = wps[Math.max(0, i - 1)]
    const next = wps[Math.min(wps.length - 1, i + 1)]
    return {
      x: p.x,
      z: p.z,
      y: p.y,
      yaw: Math.atan2(next.x - prev.x, next.z - prev.z)
    }
  })

  const R = Math.max(turnRadius, 10)
  const out: Vec3[] = []
  for (let i = 0; i < poses.length - 1; i++) {
    const seg = dubinsSegment(poses[i], poses[i + 1], R, sampleSpacing)
    if (!seg) continue
    if (out.length > 0 && seg.length > 0) seg.shift()
    // 高度线性插值（首末高度之间按弧长比例）
    const base = out.length
    for (let k = 0; k < seg.length; k++) {
      const t = seg.length <= 1 ? 0 : k / (seg.length - 1)
      seg[k].y = poses[i].y + (poses[i + 1].y - poses[i].y) * t
    }
    void base
    out.push(...seg)
  }

  if (out.length < 2) {
    return smoothPolyline(env, path, fallbackIterations, clearance)
  }
  for (let i = 1; i < out.length; i++) {
    if (!env.isSegmentFeasible(out[i - 1], out[i], clearance)) {
      return smoothPolyline(env, path, fallbackIterations, clearance)
    }
  }
  return out
}

/** 单个 Dubins 航段：枚举 LSL/RSR/LSR/RSL 四种构型，取总弧长最短 */
function dubinsSegment(
  a: { x: number; z: number; yaw: number },
  b: { x: number; z: number; yaw: number },
  R: number,
  spacing: number
): Vec3[] | null {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const d = Math.hypot(dx, dz) / R
  if (!Number.isFinite(d) || d < 1e-6) return null
  const theta = Math.atan2(dx, dz)
  const alpha = modPi(a.yaw - theta)
  const beta = modPi(b.yaw - theta)

  const sa = Math.sin(alpha)
  const sb = Math.sin(beta)
  const ca = Math.cos(alpha)
  const cb = Math.cos(beta)

  // 各构型解（t, p, q）均为“归一化长度”，真实长度乘 R；无解为 null
  type Sol = [number, number, number]
  const solLSL: Sol | null = (() => {
    const tmp = 2 + d * d - 2 * Math.cos(alpha - beta) + 2 * d * (sa - sb)
    if (tmp < 0) return null
    const p = Math.sqrt(tmp)
    const th = mod2pi(Math.atan2(cb - ca, d + sa - sb))
    return [mod2pi(-alpha + th), p, mod2pi(beta - th)]
  })()
  const solRSR: Sol | null = (() => {
    const tmp = 2 + d * d - 2 * Math.cos(alpha - beta) - 2 * d * (sa - sb)
    if (tmp < 0) return null
    const p = Math.sqrt(tmp)
    const th = mod2pi(Math.atan2(ca - cb, d - sa + sb))
    return [mod2pi(alpha - th), p, mod2pi(-beta + th)]
  })()
  const solLSR: Sol | null = (() => {
    const tmp = d * d - 2 + 2 * Math.cos(alpha - beta) + 2 * d * (sa + sb)
    if (tmp < 0) return null
    const p = Math.sqrt(tmp)
    const th = mod2pi(Math.atan2(-ca - cb, d + sa + sb) - Math.atan2(-2, p))
    return [mod2pi(-alpha + th), p, mod2pi(-beta + th)]
  })()
  const solRSL: Sol | null = (() => {
    const tmp = d * d - 2 + 2 * Math.cos(alpha - beta) - 2 * d * (sa + sb)
    if (tmp < 0) return null
    const p = Math.sqrt(tmp)
    const th = mod2pi(Math.atan2(ca + cb, d - sa - sb) - Math.atan2(2, p))
    return [mod2pi(alpha - th), p, mod2pi(beta - th)]
  })()

  const words: { word: 'LSL' | 'RSR' | 'LSR' | 'RSL'; sol: Sol }[] = []
  if (solLSL) words.push({ word: 'LSL', sol: solLSL })
  if (solRSR) words.push({ word: 'RSR', sol: solRSR })
  if (solLSR) words.push({ word: 'LSR', sol: solLSR })
  if (solRSL) words.push({ word: 'RSL', sol: solRSL })
  if (words.length === 0) return null
  words.sort(
    (u, v) =>
      u.sol[0] + u.sol[1] + u.sol[2] - (v.sol[0] + v.sol[1] + v.sol[2])
  )
  const best = words[0]

  // 采样：弧1（t）、直线（p）、弧2（q）。L 左转（曲率+），R 右转。
  const pts: Vec3[] = []
  let x = a.x
  let z = a.z
  let yaw = a.yaw
  const emitArc = (angle: number, left: boolean) => {
    const n = Math.max(2, Math.ceil((Math.abs(angle) * R) / spacing))
    const dir = left ? 1 : -1
    // 圆心在当前航向左侧（dir=+1）
    const cx = x + R * Math.cos(yaw + dir * Math.PI / 2)
    const cz = z - R * Math.sin(yaw + dir * Math.PI / 2)
    for (let i = 0; i <= n; i++) {
      // 起点相对圆心的方位角
      const startAng = yaw - dir * Math.PI / 2
      const ang = startAng + dir * (angle * i / n)
      pts.push({ x: cx + R * Math.sin(ang), y: 0, z: cz + R * Math.cos(ang) })
    }
    const last = pts[pts.length - 1]
    x = last.x
    z = last.z
    yaw = mod2pi(yaw + dir * angle)
    if (yaw > Math.PI) yaw -= 2 * Math.PI
  }
  const emitStraight = (len: number) => {
    const n = Math.max(1, Math.ceil(len / spacing))
    for (let i = 1; i <= n; i++) {
      pts.push({
        x: x + len * (i / n) * Math.sin(yaw),
        y: 0,
        z: z + len * (i / n) * Math.cos(yaw)
      })
    }
    x += len * Math.sin(yaw)
    z += len * Math.cos(yaw)
  }

  emitArc(best.sol[0], best.word[0] === 'L')
  emitStraight(best.sol[1] * R)
  emitArc(best.sol[2], best.word[2] === 'L')
  return pts
}

/**
 * Clothoid（回旋曲线）平滑（功能04）：
 * 每个折点用标准“回旋弧 - 圆弧 - 回旋弧”（CCSC）替换尖角。
 * 回旋弧曲率在 0 与 1/R 之间线性变化（Fresnel 形式数值积分），
 * 入/出口锚点严格位于原直线上且切线对齐，无拼接尖角；
 * 切线长度不足时自适应放大转弯半径；碰撞则回退折线松弛。
 */
export function smoothClothoid(
  env: Environment,
  path: Vec3[],
  clearance: number,
  turnRadius: number,
  sampleSpacing = 6,
  fallbackIterations = 3
): Vec3[] {
  if (path.length < 3) return path.map((q) => ({ ...q }))
  const R0 = Math.max(turnRadius, 12)
  const wps = rdpSimplify(path, R0 * 0.3)
  if (wps.length < 3) return path.map((q) => ({ ...q }))

  const yawOf = (u: Vec3, v: Vec3) => Math.atan2(v.x - u.x, v.z - u.z)
  const out: Vec3[] = [{ ...wps[0] }]

  for (let i = 1; i < wps.length - 1; i++) {
    const a = wps[i - 1]
    const b = wps[i]
    const c = wps[i + 1]
    const yawIn = yawOf(a, b)
    const yawOut = yawOf(b, c)
    let defl = yawOut - yawIn
    while (defl > Math.PI) defl -= 2 * Math.PI
    while (defl < -Math.PI) defl += 2 * Math.PI
    const absDefl = Math.abs(defl)
    if (absDefl < 0.03) {
      out.push({ ...b })
      continue
    }

    // 构造本角点的回旋替换弧，独立验证；不满足（相邻角点弧段相互
    // 干扰等）则保留原角点折线，保证最终航迹可行。
    const cornerArc = buildClothoidCorner(
      a,
      b,
      c,
      absDefl,
      Math.sign(defl),
      R0,
      sampleSpacing
    )
    const anchor = out[out.length - 1]
    const chain: Vec3[] = []
    if (cornerArc) {
      // cornerArc 已包含入/出口锚点，出口锚点在 b->c 上；
      // 与已输出的上一锚点做通视检查
      let feasible = true
      let prev = anchor
      for (const q of cornerArc) {
        if (!env.isSegmentFeasible(prev, q, clearance)) {
          feasible = false
          break
        }
        prev = q
      }
      if (feasible) chain.push(...cornerArc)
    }
    if (chain.length === 0) {
      // 回退：加入角点 b（保持原折线）
      out.push({ ...b })
    } else {
      // cornerArc 首点可能与上一锚点重复，去重
      const first = chain[0]
      if (dist(first, anchor) > 1) out.push(first)
      out.push(...chain.slice(1))
    }
  }
  out.push({ ...wps[wps.length - 1] })

  const merged = removeShortSegments(out, Math.max(sampleSpacing * 0.5, 1))
  for (let k = 1; k < merged.length; k++) {
    if (!env.isSegmentFeasible(merged[k - 1], merged[k], clearance)) {
      return smoothPolyline(env, path, fallbackIterations, clearance)
    }
  }
  return merged
}

/** 构造单个折点的 CCSC 回旋弧点集（含入/出口锚点），不可行返回 null */
function buildClothoidCorner(
  a: Vec3,
  b: Vec3,
  c: Vec3,
  absDefl: number,
  dir: number,
  R0: number,
  sampleSpacing: number
): Vec3[] | null {
  const yawIn = Math.atan2(b.x - a.x, b.z - a.z)
  const yawOut = Math.atan2(c.x - b.x, c.z - b.z)
  const abLen = dist(a, b)
  const bcLen = dist(b, c)
  const maxT = Math.min(abLen, bcLen) * 0.46

  const tau = Math.min(absDefl / 2 - 0.01, 0.35)
  const arcAngle = Math.max(0, absDefl - 2 * tau)

  let R = R0
  if (ccscTangent(R, tau, arcAngle) > maxT) {
    let lo = 0
    let hi = R
    for (let k = 0; k < 16; k++) {
      const mid = (lo + hi) / 2
      if (ccscTangent(mid, tau, arcAngle) > maxT) hi = mid
      else lo = mid
    }
    R = Math.max(lo, 1)
  }
  const T = Math.min(ccscTangent(R, tau, arcAngle), maxT)
  const L = 2 * R * tau

  const vIn = {
    x: Math.sin(yawIn),
    y: (b.y - a.y) / Math.max(abLen, 1e-9),
    z: Math.cos(yawIn)
  }
  const vOut = {
    x: Math.sin(yawOut),
    y: (c.y - b.y) / Math.max(bcLen, 1e-9),
    z: Math.cos(yawOut)
  }
  const pIn: Vec3 = { x: b.x - vIn.x * T, y: b.y - vIn.y * T, z: b.z - vIn.z * T }
  const pOut: Vec3 = { x: b.x + vOut.x * T, y: b.y + vOut.y * T, z: b.z + vOut.z * T }

  const arc: Vec3[] = [pIn]
  const sp1 = integrateLinearSpiral(pIn, yawIn, dir, R, L, sampleSpacing)
  arc.push(...sp1.points.slice(1))
  const p1 = sp1.points[sp1.points.length - 1]
  const yaw1 = yawIn + dir * tau

  let arcEnd = p1
  let yawArcEnd = yaw1
  if (arcAngle > 0.004) {
    const cx = p1.x + R * Math.cos(yaw1 + dir * Math.PI / 2)
    const cz = p1.z - R * Math.sin(yaw1 + dir * Math.PI / 2)
    const n = Math.max(2, Math.ceil((arcAngle * R) / sampleSpacing))
    for (let k = 1; k <= n; k++) {
      const ang = yaw1 - dir * Math.PI / 2 + dir * ((arcAngle * k) / n)
      arcEnd = {
        x: cx + R * Math.sin(ang),
        y: pIn.y,
        z: cz + R * Math.cos(ang)
      }
      arc.push(arcEnd)
    }
    yawArcEnd = yaw1 + dir * arcAngle
  }

  const exitPts = integrateLinearSpiralDown(arcEnd, yawArcEnd, dir, R, L, sampleSpacing)
  const rawExitEnd = exitPts[exitPts.length - 1]
  const ox = pOut.x - rawExitEnd.x
  const oz = pOut.z - rawExitEnd.z
  for (let k = 1; k < exitPts.length; k++) {
    arc.push({
      x: exitPts[k].x + ox,
      y: pIn.y, // 高度稍后按弧长统一重分配
      z: exitPts[k].z + oz
    })
  }

  // 高度按平面累积弧长从 pIn.y 线性过渡到 pOut.y，避免爬升集中
  const cum: number[] = [0]
  for (let k = 1; k < arc.length; k++) {
    cum.push(
      cum[k - 1] +
        Math.hypot(arc[k].x - arc[k - 1].x, arc[k].z - arc[k - 1].z)
    )
  }
  const totalPlanar = cum[cum.length - 1] || 1
  for (let k = 0; k < arc.length; k++) {
    arc[k].y = pIn.y + (pOut.y - pIn.y) * (cum[k] / totalPlanar)
  }
  return arc
}

/**
 * CCSC 切线占位 T(R)：局部坐标（入口沿 +z、左转朝 +x）下正向积分
 * 完整“回旋+圆弧+回旋”，角点在入口直线 x=0 上，出口直线过末端且
 * 方向角为总偏转 δ，故 T = endX / sin δ。
 */
function ccscTangent(R: number, tau: number, arcAngle: number): number {
  const L = 2 * R * tau
  const s1 = spiralShift(0, 0, 0, R, L, true)
  const yaw1 = tau
  const cx = s1.x + R * Math.cos(yaw1 + Math.PI / 2)
  const cz = s1.z - R * Math.sin(yaw1 + Math.PI / 2)
  const endAng = yaw1 - Math.PI / 2 + arcAngle
  const p2 = { x: cx + R * Math.sin(endAng), z: cz + R * Math.cos(endAng) }
  const yaw2 = yaw1 + arcAngle
  const s3 = spiralShift(p2.x, p2.z, yaw2, R, L, false)
  const totalDefl = 2 * tau + arcAngle
  // 局部坐标按“左转”积分；构造右转时整体关于 z 轴镜像，占位长度相同
  const sd = Math.sin(totalDefl)
  if (Math.abs(sd) < 1e-4) return (s1.z + (p2.z - s1.z)) / 2
  return Math.abs(s3.x / sd)
}

/** 单条回旋弧位移（up=true: k 0→1/R；false: 1/R→0） */
function spiralShift(
  x0: number,
  z0: number,
  yaw0: number,
  R: number,
  L: number,
  up: boolean
): { x: number; z: number } {
  const n = 48
  const ds = L / n
  let x = x0
  let z = z0
  let yaw = yaw0
  for (let i = 1; i <= n; i++) {
    const sMid = (i - 0.5) * ds
    const k = up ? sMid / (R * L) : 1 / R - sMid / (R * L)
    yaw += k * ds
    x += Math.sin(yaw) * ds
    z += Math.cos(yaw) * ds
  }
  return { x, z }
}

/** 删除长度小于 eps 的退化段（保留端点） */
function removeShortSegments(pts: Vec3[], eps: number): Vec3[] {
  const res = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    if (dist(res[res.length - 1], pts[i]) >= eps) res.push(pts[i])
  }
  const last = pts[pts.length - 1]
  if (res[res.length - 1] !== last) res.push(last)
  return res
}

/** 线性曲率回旋弧采样（曲率 0 → dir/R）。 */
function integrateLinearSpiral(
  start: Vec3,
  yaw0: number,
  dir: number,
  R: number,
  L: number,
  spacing: number
): { points: Vec3[]; yawEnd: number } {
  const n = Math.max(4, Math.ceil(L / spacing))
  const ds = L / n
  const points: Vec3[] = [{ ...start }]
  let x = start.x
  let z = start.z
  let yaw = yaw0
  for (let i = 1; i <= n; i++) {
    const sMid = (i - 0.5) * ds
    yaw += ((dir * sMid) / (R * L)) * ds
    x += Math.sin(yaw) * ds
    z += Math.cos(yaw) * ds
    points.push({ x, y: start.y, z })
  }
  return { points, yawEnd: yaw }
}

/** 线性曲率回旋弧采样（曲率 dir/R → 0）。 */
function integrateLinearSpiralDown(
  start: Vec3,
  yaw0: number,
  dir: number,
  R: number,
  L: number,
  spacing: number
): Vec3[] {
  const n = Math.max(4, Math.ceil(L / spacing))
  const ds = L / n
  const points: Vec3[] = [{ ...start }]
  let x = start.x
  let z = start.z
  let yaw = yaw0
  for (let i = 1; i <= n; i++) {
    const sMid = (i - 0.5) * ds
    const k = dir * (1 / R - sMid / (R * L))
    yaw += k * ds
    x += Math.sin(yaw) * ds
    z += Math.cos(yaw) * ds
    points.push({ x, y: start.y, z })
  }
  return points
}


function modPi(v: number): number {
  let x = v
  while (x > Math.PI) x -= 2 * Math.PI
  while (x < -Math.PI) x += 2 * Math.PI
  return x
}
function mod2pi(v: number): number {
  let x = v
  while (x < 0) x += 2 * Math.PI
  while (x >= 2 * Math.PI) x -= 2 * Math.PI
  return x
}

/** Ramer-Douglas-Peucker 抽稀（水平+高度联合） */
function rdpSimplify(points: Vec3[], epsilon: number): Vec3[] {
  if (points.length < 3) return points.map((q) => ({ ...q }))
  const keep = new Array<boolean>(points.length).fill(false)
  keep[0] = true
  keep[points.length - 1] = true
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length) {
    const [lo, hi] = stack.pop()!
    let maxD = 0
    let idx = -1
    const a = points[lo]
    const b = points[hi]
    const ab = dist(a, b)
    for (let i = lo + 1; i < hi; i++) {
      const pt = points[i]
      let d: number
      if (ab < 1e-9) {
        d = dist(a, pt)
      } else {
        const tt =
          ((pt.x - a.x) * (b.x - a.x) +
            (pt.y - a.y) * (b.y - a.y) +
            (pt.z - a.z) * (b.z - a.z)) /
          (ab * ab)
        d = dist(pt, lerp(a, b, Math.max(0, Math.min(1, tt))))
      }
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (maxD > epsilon && idx > 0) {
      keep[idx] = true
      stack.push([lo, idx])
      stack.push([idx, hi])
    }
  }
  return points.filter((_, i) => keep[i]).map((q) => ({ ...q }))
}

export function densify(path: Vec3[], spacing: number): Vec3[] {
  if (path.length < 2) return path.map((p) => ({ ...p }))
  const out: Vec3[] = [path[0]]
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]
    const b = path[i]
    const segLen = dist(a, b)
    if (segLen < 1e-9) continue
    // 至少分 1 段；段长超过 spacing 时增加分段数
    const pieces = Math.max(1, Math.ceil(segLen / spacing))
    for (let k = 1; k <= pieces; k++) {
      out.push(lerp(a, b, k / pieces))
    }
  }
  return out
}

export interface TrajectorySample {
  position: Vec3
  velocity: Vec3
  speed: number
  /** 累计时间（秒） */
  time: number
  /** 累计航程（米） */
  s: number
}

/**
 * 速度规划（功能04 增强）：
 * 1) 梯形速度剖面给出基准速度；
 * 2) 曲率限速 v <= sqrt(a_max / kappa)（最小转弯半径约束）；
 * 3) 正反向两遍传播，保证加速度不超过 maxAccel；
 * 4) 生成时间参数化轨迹。
 */
export function planTrajectory(
  path: Vec3[],
  plan: PlanParams,
  cruiseSpeed?: number
): TrajectorySample[] {
  if (path.length < 2) return []
  const dense = densify(path, Math.max(plan.cellSize * 0.5, 4))
  const cum = cumulativeLengths(dense)
  const total = cum[cum.length - 1]

  const vCruise = Math.min(
    Math.max(cruiseSpeed ?? (plan.speedMin + plan.speedMax) / 2, plan.speedMin),
    plan.speedMax
  )
  const accel = Math.max(Math.min(plan.dynamics?.maxAccel ?? vCruise * 0.5, 30), 4)
  const minRadius = Math.max(plan.dynamics?.minTurnRadius ?? 30, 5)
  const dAccel = (vCruise * vCruise) / (2 * accel)

  // 1) 基准速度（梯形 / 三角形剖面）
  const base = (s: number): number => {
    if (2 * dAccel >= total) {
      const peak = Math.sqrt(accel * total)
      if (s < total / 2) return Math.min(Math.sqrt(2 * accel * s), peak)
      return Math.min(Math.sqrt(2 * accel * (total - s)), peak)
    }
    if (s < dAccel) return Math.sqrt(2 * accel * s)
    if (s > total - dAccel) return Math.sqrt(2 * accel * (total - s))
    return vCruise
  }

  // 2) 曲率限速（三点外接圆）
  const speed = new Array<number>(dense.length)
  const chord = Math.max(minRadius * 1.2, 16)
  const pointAt = (s: number): Vec3 => {
    const target = Math.max(0, Math.min(total, s))
    let lo = 0
    let hi = cum.length - 1
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (cum[mid] <= target) lo = mid
      else hi = mid
    }
    const segLen = cum[hi] - cum[lo]
    const t = segLen > 1e-9 ? (target - cum[lo]) / segLen : 0
    return lerp(dense[lo], dense[hi], t)
  }

  for (let i = 0; i < dense.length; i++) {
    let v = Math.max(base(cum[i]), plan.speedMin * 0.25)
    if (cum[i] > chord && total - cum[i] > chord) {
      const a = pointAt(cum[i] - chord)
      const c = pointAt(cum[i] + chord)
      const kappa = horizontalCurvature(a, dense[i], c)
      if (kappa > 1e-6) {
        const vCurv = Math.sqrt(accel / kappa)
        v = Math.min(v, vCurv, plan.speedMax)
      }
    }
    // 端部必须减速到 0
    if (i === dense.length - 1) v = 0
    speed[i] = v
  }

  // 3a) 正向传播：加速能力限制
  for (let i = 1; i < dense.length; i++) {
    const ds = cum[i] - cum[i - 1]
    const vReach = Math.sqrt(speed[i - 1] ** 2 + 2 * accel * ds)
    if (speed[i] > vReach) speed[i] = vReach
  }
  // 3b) 反向传播：制动能力限制
  for (let i = dense.length - 2; i >= 0; i--) {
    const ds = cum[i + 1] - cum[i]
    const vReach = Math.sqrt(speed[i + 1] ** 2 + 2 * accel * ds)
    if (speed[i] > vReach) speed[i] = vReach
  }

  const samples: TrajectorySample[] = []
  let time = 0
  for (let i = 0; i < dense.length; i++) {
    const s = cum[i]
    const v = speed[i]
    let velocity: Vec3
    if (i < dense.length - 1) {
      const d = dist(dense[i], dense[i + 1])
      const k = d > 1e-9 ? v / d : 0
      velocity = {
        x: (dense[i + 1].x - dense[i].x) * k,
        y: (dense[i + 1].y - dense[i].y) * k,
        z: (dense[i + 1].z - dense[i].z) * k
      }
    } else {
      const d = dist(dense[i - 1], dense[i])
      const k = d > 1e-9 ? v / d : 0
      velocity = {
        x: (dense[i].x - dense[i - 1].x) * k,
        y: (dense[i].y - dense[i - 1].y) * k,
        z: (dense[i].z - dense[i - 1].z) * k
      }
    }
    samples.push({ position: dense[i], velocity, speed: v, time, s })
    if (i < dense.length - 1) {
      const ds = cum[i + 1] - s
      const vAvg = Math.max((v + speed[i + 1]) / 2, 0.5)
      time += ds / vAvg
    }
  }
  return samples
}

export function pathDistance(path: Vec3[]): number {
  return polylineLength(path)
}

/** 供平滑模块自检：路径最大偏转角/爬升角（调试用） */
export function pathAngles(path: Vec3[]): { maxTurn: number; maxClimb: number } {
  let maxTurn = 0
  let maxClimb = 0
  for (let i = 1; i < path.length; i++) {
    const c = Math.abs(climbAngleRad(path[i - 1], path[i])) * (180 / Math.PI)
    if (c > maxClimb) maxClimb = c
    if (i >= 2) {
      const t = turnAngleRad(path[i - 2], path[i - 1], path[i]) * (180 / Math.PI)
      if (t > maxTurn) maxTurn = t
    }
  }
  void extensionAllowed
  return { maxTurn, maxClimb }
}
