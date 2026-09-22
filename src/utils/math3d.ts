import type { Vec3 } from '@/types'

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z })

export const clone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z })

export const add = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z
})

export const sub = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z
})

export const scale = (a: Vec3, s: number): Vec3 => ({
  x: a.x * s,
  y: a.y * s,
  z: a.z * s
})

export const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z)

export const dist = (a: Vec3, b: Vec3): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

export const dist2 = (a: Vec3, b: Vec3): number => {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return dx * dx + dy * dy + dz * dz
}

export const normalize = (a: Vec3): Vec3 => {
  const l = len(a)
  return l < 1e-9 ? { x: 0, y: 0, z: 0 } : { x: a.x / l, y: a.y / l, z: a.z / l }
}

export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t
})

export const dot = (a: Vec3, b: Vec3): number =>
  a.x * b.x + a.y * b.y + a.z * b.z

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, v))

/** 折线总航程 */
export function polylineLength(points: Vec3[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i])
  return total
}

/** 折线段到点的累积长度数组 */
export function cumulativeLengths(points: Vec3[]): number[] {
  const cum = [0]
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + dist(points[i - 1], points[i]))
  }
  return cum
}

/**
 * 线段 P1-P2 与圆柱（竖直轴，中心 c，半径 r，高度 [hMin,hMax]）的最近距离。
 * 用于威胁暴露 / 禁飞区碰撞的连续检测。
 */
export function segmentCylinderDistance(
  p1: Vec3,
  p2: Vec3,
  c: Vec3,
  radius: number,
  hMin: number,
  hMax: number
): number {
  // 在线段上采样若干点求最近距离（步长约 radius/4），兼顾精度与性能
  const segLen = dist(p1, p2)
  const steps = Math.max(2, Math.ceil(segLen / Math.max(radius / 3, 1)))
  let best = Infinity
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const px = p1.x + (p2.x - p1.x) * t
    const py = p1.y + (p2.y - p1.y) * t
    const pz = p1.z + (p2.z - p1.z) * t
    const planar = Math.hypot(px - c.x, pz - c.z)
    const dy = Math.max(hMin - py, 0, py - hMax)
    const dr = Math.max(planar - radius, 0)
    const d = Math.hypot(dr, dy)
    if (d < best) best = d
  }
  return best
}

/** 线段是否与 AABB 盒相交（slab 法，盒以 cx,cz 为中心、底面 y=baseY） */
export function segmentIntersectsBox(
  p1: Vec3,
  p2: Vec3,
  cx: number,
  cz: number,
  halfX: number,
  halfZ: number,
  baseY: number,
  height: number
): boolean {
  const min = { x: cx - halfX, y: baseY, z: cz - halfZ }
  const max = { x: cx + halfX, y: baseY + height, z: cz + halfZ }
  const d = sub(p2, p1)
  let tmin = 0
  let tmax = 1
  const axes: (keyof Vec3)[] = ['x', 'y', 'z']
  for (const ax of axes) {
    if (Math.abs(d[ax]) < 1e-9) {
      if (p1[ax] < min[ax] || p1[ax] > max[ax]) return false
    } else {
      let t1 = (min[ax] - p1[ax]) / d[ax]
      let t2 = (max[ax] - p1[ax]) / d[ax]
      if (t1 > t2) [t1, t2] = [t2, t1]
      tmin = Math.max(tmin, t1)
      tmax = Math.min(tmax, t2)
      if (tmin > tmax) return false
    }
  }
  return true
}
