# 无人机三维航迹规划与避障仿真系统 v3.0（迭代三：科研仿真与算法对比平台）

浏览器端多目标航迹规划、多无人机协同、批量实验与 Pareto 多目标对比平台。
规划计算运行在 **Web Worker 池**，不阻塞渲染；渲染引擎 **Three.js / WebGL2**，
场计算支持 **WebGPU compute** 可选加速（无 GPU 时透明回退 CPU）。

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 语言 | TypeScript 5.6（strict） |
| 渲染 | three 0.169 / WebGL2（自动回退 WebGL1）；分块 LOD / InstancedMesh |
| 前端 | Vue 3.5（`<script setup>`） |
| 状态 | Pinia（scene / sim / fleet / view） |
| 并行 | Web Worker 池（Vite `?worker` 独立分包），消息带 id 路由 |
| GPU 加速 | WebGPU WGSL compute（威胁/裕度/代价场），能力检测 + CPU 回退 |
| 构建 | Vite 5 |
| 测试 | Vitest（node 算法测试 + jsdom/WebGL mock 渲染测试），78 用例 |

## 迭代三四大功能

### 功能01：多目标代价优化
- 综合代价 7 维：**航程、威胁暴露、高度、能耗、平滑、禁飞区惩罚、动力学惩罚**
  （`src/core/cost.ts`，权重实时调节）
- 能耗模型：寄生阻力 + 诱导阻力 + 爬升势能（质量/阻力系数/诱导因子/爬升效率可调）
- 动力学惩罚：最大转弯角/爬升角越限量按航程归一化积分
- **Pareto 前沿**：权重单纯形扫描（8 组偏好预设 + 随机 Dirichlet 权重）+
  NSGA-II 非支配排序 + 拥挤距离；支持二维与三维（轴测）展示，点击散点可回读权重
  （`src/core/pareto.ts`、`ParetoChart.vue`）
- 代价曲线、**收敛曲线**（ACO/PSO/GA 每代最优与平均代价）、迭代过程展示
- **权重敏感性分析**：单权重 0→4 倍扫描，各目标归一化趋势图（`SensitivityChart.vue`）

### 功能02：仿真评估与实验对比
- 单次规划与**批量实验**：多算法 × 多种子重复（`src/core/experiment.ts`）
- 指标：成功率、航程、威胁暴露量/时间、规划耗时、平滑度、能耗、约束满足率、曲率
- 均值 ± 标准差 / 极值聚合；进度回报；可取消
- 多次运行对比、**算法性能对比图**（6 指标柱状切换）
- 导出：航迹 CSV、指标聚合 CSV、运行明细 CSV、完整实验报告 JSON、场景配置 JSON（v3.0）
- 实验配置保存与一键载入复现（固定种子，结果可重现）

### 功能03：多目标与评估可视化
- 地形叠加层：**威胁热力图、安全裕度图、综合代价热力图、威胁强度三维体素云**
- **Pareto 前沿 2D / 3D** 散点（按算法着色，非支配解高亮，可点选）
- 多算法指标对比柱状图、收敛曲线、权重敏感性曲线
- 时间轴：播放/暂停/**逐帧步进/循环**、0.5~8× 加速、拖拽回放
- **多无人机同时仿真**：独立任务/算法，Worker 池并行规划，统一时钟回放，
  机间冲突自动检测告警（安全间隔 30m）
- 传感器范围（半透明球）、探测范围（地面环）、**机间通信链路**（距离判定绿/灰线）

### 功能04：工程性能与可扩展性
- **Web Worker 池**：容量随 CPU 核心自适应，消息 id 路由，批量/编队/Pareto 并行
- **SharedArrayBuffer / OffscreenCanvas 能力检测**；SAB 不可用时自动回退结构化克隆；
  离屏纹理优先 OffscreenCanvas
- **大场景分块 + 两级 LOD + 视锥裁剪**（4×4 chunk，按相机距离切换细分，
  `src/three/chunked-terrain.ts`）
- **建筑 InstancedMesh** 实例化渲染（拾取按 instanceId 反查）
- **规划结果 LRU 缓存**（同参数命中免重算，命中率监控）、随机算法确定性可复现
- **实时性能监控**：FPS、帧耗时、draw calls、三角形、JS 堆、规划耗时，可导出 CSV
  （`src/core/perf-monitor.ts`）
- **WebGPU 可选升级**：WGSL compute shader 计算地形标量场（`webgpu-field.ts`），
  一键测试后端与耗时，不支持时静默回退
- 算法注册表热插拔（8 算法）+ **参数/权重预设**（快速 RRT、高质量 RRT*、
  隐身/续航/机动权重等 8 组）

## 快速开始

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # 产物在 dist/（Worker 独立 chunk）
npm run test       # 78 个单元/集成测试
npm run typecheck  # vue-tsc 严格类型检查
npm run preview
```

> WebGPU 与 SharedArrayBuffer 需要安全上下文（https 或 localhost）；
> SAB 跨域隔离需服务端发送 `Cross-Origin-Opener-Policy: same-origin` 与
> `Cross-Origin-Embedder-Policy: require-corp`，缺失时自动回退，不影响功能。

打开后自动完成一次全局规划。右侧标签页：

1. **规划/约束**：8 算法、7 维权重（含能耗/动力学）、能耗模型参数
2. **多目标**：扫描 Pareto 前沿（2D/3D）、权重敏感性分析、点选应用权重
3. **算法对比**：批量对比 + 指标柱状图 + Pareto + 收敛曲线
4. **批量实验**：多种子重复、聚合统计、CSV/JSON 导出、配置保存复现
5. **多机编队**：3 机并行规划、统一回放、传感器/通信可视化、冲突告警
6. **仿真评估**：约束、平滑前后、跟踪、能耗、平滑度、收敛与代价曲线
7. **性能/工程**：FPS/内存监控、LOD/实例化/缓存开关、叠加层、WebGPU 测试、预设

## 操作指南

- 视角：左键旋转 / 右键平移 / 滚轮缩放；轨道 / 俯视 / 跟随相机
- 编辑：左侧工具在地形上点击放置威胁/禁飞/建筑/移动障碍/航点；`Delete` 删除
- 播放：`空格` 播放暂停；⏪⏩ 逐帧 ±1s；🔁 循环回放
- 快捷键 `Esc` 退出编辑模式

## 架构

```
src/
├── core/
│   ├── cost.ts              # 7 维多目标代价（能耗/动力学）+ 目标向量
│   ├── pareto.ts            # 非支配排序/拥挤距离/权重扫描/敏感性
│   ├── experiment.ts        # 批量实验/聚合统计/CSV/报告
│   ├── plan-cache.ts        # LRU 规划缓存
│   ├── worker-pool.ts       # Worker 池（id 路由/进度）
│   ├── capabilities.ts      # WebGPU/SAB/OffscreenCanvas 能力检测
│   ├── webgpu-field.ts      # WGSL compute 场计算 + CPU 回退
│   ├── perf-monitor.ts      # FPS/帧时/drawCall/堆监控
│   ├── planners/            # 8 算法注册表；ACO/PSO/GA 产出收敛曲线
│   └── ...（terrain/environment/dynamics/smoothing/metrics/tracking/replanning）
├── three/
│   ├── SceneRenderer.ts     # 场景/编队/传感器/叠加层/性能采样
│   ├── chunked-terrain.ts   # 分块 LOD 地形
│   └── factory.ts           # InstancedMesh/传感器范围/通信链路/离屏画布
├── stores/                  # scene / sim / fleet / view
├── components/              # ParetoChart / SensitivityChart / ConvergenceChart
│                            # ParetoPanel / ExperimentPanel / FleetPanel / PerfPanel
└── workers/planner.worker.ts # plan/trajectory/compare/batch/pareto + progress
```

## 已知边界

- 全局规划在 t=0 静态口径下进行；动态实体由在线局部重规划处理
- WebGPU 仅加速地形标量场（威胁/裕度/代价），主渲染管线仍为 WebGL2
- 元启发式采用切片走廊 + 分层 DP 修复，极复杂绕行场景会如实报失败
- 无头环境（无 GPU）由 78 个 Vitest 用例保证算法正确性，渲染建议本地浏览器运行
