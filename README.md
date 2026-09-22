# 无人机三维航迹规划与避障仿真系统 v3.0（迭代三）

浏览器端**接近完整的科研仿真与算法对比平台**：多无人机三维航迹规划、多目标代价优化、
Pareto 前沿、批量实验与指标评估、动态避障与在线重规划。
规划计算运行在 **Web Worker**（不阻塞渲染），渲染为 **Three.js / WebGL2**，
标量场计算提供 **WebGPU 可选升级**（自动回退 CPU）。

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 语言 | TypeScript 5.6（strict） |
| 渲染 | three 0.169 / WebGL2（自动回退 WebGL1），WebGPU 可选计算 |
| 前端 | Vue 3.5（`<script setup>`） |
| 状态 | Pinia（scene / sim / engine / fleet） |
| 并行 | Web Worker 池 + SharedArrayBuffer 进度遥测（COOP/COEP 跨域隔离） |
| 性能 | InstancedMesh / LOD / 视锥裁剪 / LRU 规划缓存 / 并行分槽 |
| 构建 | Vite 5 |
| 测试 | Vitest（**93 个用例**：node 算法 + jsdom/WebGL mock 渲染） |

## 迭代三四大功能

### 功能01：多目标代价优化
- **七维综合代价**：航程、威胁暴露、高度、能耗、平滑、禁飞区惩罚、**动力学违反惩罚**
  （`src/core/cost.ts` 七维 `ObjectiveVector`，能耗含平飞推进功 + 爬升势能功）
- 权重 0~250 实时调节；多目标加权标量优化
- **Pareto 前沿**：12 组典型权重策略扫描 → 七维目标空间非支配排序（NSGA-II 风格拥挤距离），
  二维/三维目标投影散点图，点击前沿解一键套用权重重规划
- **代价曲线 / 收敛曲线 / 迭代过程**：ACO/PSO/GA 逐代记录最优 + 平均代价
- **权重敏感性分析**：单轴权重扫描，多目标归一化权衡曲线（`weightSensitivity`）

### 功能02：仿真评估与实验对比
- 单次规划与**批量实验**：多算法 × 多种子重复（成功率/航程/威胁暴露/暴露时间/
  规划时间/平滑度/约束满足率/能耗，均值±标准差/最优/最差）
- **多算法指标对比**：分组柱状图 + 雷达图（统一“越优越长/越靠外”口径）
- 多次运行结果对比；参数/算法性能对比
- **导出**：航迹 CSV、规划日志 TXT、指标报告 JSON、全部运行 CSV、**实验配置 JSON（可复现）**
- 实验配置（场景快照 + 参数 + 种子）保存与一键复现

### 功能03：多目标与评估可视化
- **代价热力图 / 威胁强度 / 安全裕度 / 综合代价** 四种标量场图层（水平切片叠加）
- **Pareto 前沿二维或三维投影**（轴可任选 7 维目标，悬停查看目标向量）
- **多算法指标对比图**（柱状/雷达切换）
- 时间轴播放/暂停/加速(0.5~8×)/回放/拖拽
- **多无人机同时仿真**：独立任务/算法/起飞延迟，统一时间轴，机间安全间隔与防撞监测
- **传感器探测范围 / 通信范围 / 通信链路**可视化（范围内自动组网连线）

### 功能04：工程性能与可扩展性
- 规划运行于独立 **Web Worker**，新增 batch/pareto/sensitivity/fleet 消息
- **SharedArrayBuffer** 进度遥测（Vite COOP/COEP 头，不可用时回退 postMessage）
- **OffscreenCanvas** 离屏热力图栅格化（不支持时回退普通 canvas/SSR 安全）
- **大场景分块 + LOD**（距离透明度降级、分辨率自适应）、**视锥裁剪**、**InstancedMesh 建筑**
- **增量规划 / LRU 规划缓存 / 并行搜索**（`parallelMap` 按硬件核数分槽）
- 实时 **FPS / 帧耗时 / 规划耗时 / draw calls / 三角面 / JS 堆内存** HUD
- **WebGPU 可选升级**：compute shader 批量计算威胁标量场，能力检测 + 无缝 CPU 回退
- **算法模块热插拔**（注册表）+ **参数预设**（内置 5 套任务画像 + localStorage 自定义）

## 快速开始

```bash
npm install
npm run dev        # http://localhost:5173（已启用 COOP/COEP 跨域隔离）
npm run build      # 产物在 dist/（Worker 独立 chunk）
npm run test       # 93 个单元/集成测试
npm run typecheck  # vue-tsc 严格类型检查
npm run preview
```

打开后自动完成一次全局规划。右侧 8 个标签页：
1. **环境**：地形/威胁/禁飞/建筑/动态实体编辑
2. **规划**：8 种算法、7 种平滑、七维代价权重、动力学约束
3. **多目标**：七维权重、目标向量、收敛曲线、**Pareto 扫描**、权重敏感性
4. **对比**：同环境多算法横向对比
5. **批量实验**：多种子统计、柱状/雷达图、报告与配置导出
6. **多机**：编队规划、传感器/通信范围、机间间隔
7. **评估**：全部指标、约束、平滑前后、跟踪误差、代价/收敛曲线
8. **性能**：实时 HUD、WebGPU、LOD/裁剪/实例化、Worker/缓存、参数预设

## 架构

```
src/
├── core/
│   ├── cost.ts                  # 七维多目标代价（航程/威胁/高度/禁飞/平滑/能耗/动力学）
│   ├── multi-objective.ts       # Pareto 非支配排序/拥挤距离/权重扫描/敏感性
│   ├── experiment.ts            # 批量实验、统计汇总、报告/CSV 导出、可复现配置
│   ├── field-grid.ts            # 标量场栅格（威胁/裕度/代价）+ 分块/LOD/配色
│   ├── offscreen-heat.ts        # OffscreenCanvas 离屏热力图（含降级）
│   ├── webgpu-field.ts          # WebGPU compute shader 标量场（能力检测+回退）
│   ├── fleet.ts                 # 多机规划/采样/间隔/通信链路
│   ├── planner-pool.ts          # LRU 缓存/并行分槽/SharedArrayBuffer 遥测
│   ├── perf-monitor.ts          # FPS/帧耗时/内存/draw call 监控
│   ├── presets.ts               # 内置 + 自定义参数预设（localStorage）
│   ├── terrain.ts/environment.ts/dynamic-environment.ts
│   ├── planner.ts planners/     # 8 种算法（注册表热插拔，ACO/PSO/GA 输出收敛曲线）
│   ├── dynamics.ts smoothing.ts metrics.ts tracking.ts replanning.ts planning.ts
│   └── *.test.ts
├── three/
│   ├── SceneRenderer.ts         # 场图层/LOD/实例化/多机/范围环/链路/性能HUD
│   └── factory.ts               # InstancedMesh/场叠加层/范围球环/链路/编队机/HUD
├── stores/
│   ├── scene.ts                 # 场景（v3.0 序列化，旧版权重自动迁移）
│   ├── sim.ts                   # 单机规划/回放（编队复用时间轴）
│   ├── engine.ts                # 图层/后端/WebGPU/性能/编队运行时
│   └── fleet.ts                 # 编队规格与 Worker 规划
├── workers/planner.worker.ts    # plan/trajectory/compare/batch/pareto/sensitivity/fleet
└── components/                  # 8 标签页 + Pareto/收敛/敏感性/指标对比图
```

数据流：`UI/拾取 → Pinia store → Worker(pareto/batch/fleet…) → 结果 →
Three 动画循环（RAIFF：动态实体/多机更新/场 LOD/性能上报）`。

## 十项功能对照（迭代一/二/三）

1. 三维地形与环境建模 — FBM 地形 + 时变动态实体
2. 威胁区编辑 — 静态威胁 + 动态/突发威胁
3. 禁飞区编辑 — 硬避障 + 软禁飞
4. 避障与约束 — 8 算法 + 七项动力学约束 + 自动整形
5. 高级规划 — RRT*/Hybrid A*/ACO/PSO/GA，可插拔、候选可视化
6. 多航点/多策略 — 多航点、全局/局部、批量对比
7. 平滑与速度规划 — 7 种平滑、曲率限速、加速度传播
8. 实时渲染 — 动态实体、预测轨迹、安全裕度、候选、触发提示
9. 评估 — 航程/威胁/暴露/代价 + 约束/曲率/抖动/跟踪 + **七维目标/批量统计**
10. 导出/导入 — JSON（**v3.0**，含编队/图层）、CSV、**日志/指标报告/实验配置**

**迭代三新增**：七维多目标 + Pareto + 敏感性、批量实验与可复现、
四类标量场、多机与传感器/通信、Worker/SharedArrayBuffer/OffscreenCanvas/
LOD/实例化/缓存/并行/性能 HUD/WebGPU/参数预设。

## 已知边界

- 全局规划在 t=0 静态口径进行；移动障碍/突发威胁在回放期由在线局部重规划处理
- 元启发式算法（ACO/PSO/GA）采用切片走廊 + 分层 DP 修复，极端绕行场景会如实报失败
- WebGPU 仅用于标量场数据并行（渲染主路径仍为 WebGL2，保证设备兼容）；
  不支持时自动回退 CPU，功能不受影响
- SharedArrayBuffer 需 COOP/COEP 跨域隔离（dev/preview 已配置），
  不满足时自动回退 postMessage
- 无头环境（无 GPU）由 93 个 Vitest 用例保证算法与降级逻辑正确性，渲染建议本地浏览器运行
