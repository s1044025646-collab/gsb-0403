# 二值边缘图 Hough 直线投票后端

纯后端项目（TypeScript + Node.js + SQLite），对小型二值边缘图做离散 Hough 直线投票，
并提供 HTTP API 与命令行工具（CLI）。不包含图像上传界面、边缘检测器、相机标定或曲线识别：
输入矩阵里的 `1` 就是参与投票的边缘点。

## 坐标与参数化口径

- 原点在矩阵左上角，列号为 `x`，行号为 `y`，像素中心使用整数坐标。
- 直线用法线式参数化：`rho = x*cos(theta) + y*sin(theta)`。
  - `theta` 是**法线角**（直线法向量与 +x 轴的夹角），不是直线本身的方向角；
    直线方向为 `theta + 90°`。
  - `rho` 是原点到直线的带符号距离，可正可负。
- theta 网格：`0° <= theta < 180°`，步长 `thetaStepDeg` 为能整除 180 的正整数，
  共 `nTheta = 180 / thetaStepDeg` 个角度格。
- rho 量化：格编号 `rhoIdx = floor(rho / rhoStep + 0.5)`（四舍五入到最近格，
  负半格向零方向入，例如 `rho = -0.5`、`rhoStep = 1` 时 `rhoIdx = 0`，`rho = -0.51` 时为 `-1`）。
  不会把负距离截断到 0。累加器 rho 范围覆盖图像对角线正负距离：`rhoIdx ∈ [-R, R]`，
  `R = floor(((w-1)+(h-1)) / rhoStep + 0.5)`。
- 每个边缘点对每个角度格恰投一票；所有角度格票数总和 = 边缘点数 × 角度格数；
  空图（全零矩阵）总票数为 0，不产生任何有票候选。

## 候选与支持点

- 候选按 `votes >= minVotes` 过滤，按「票数降序、角度格升序、距离格升序」固定排序，
  再按 `limit` 截断。
- 支持点（来源点）在查询时按**同一量化规则**重新计算（`rhoIdx` 相等即属于该格），
  不按任意欧氏容差补点；支持点可分页（`offset`/`limit`），报告的总数始终完整。
- 本服务直接报告参数格，**不做**非极大值抑制、近邻峰合并或线段端点恢复。
  相邻参数格可能描述几何上很接近的直线，因此返回的候选条数**不等于**图中真实直线数。
  修改分辨率（theta/rho 步长）会形成一个**新的分析版本**；量化候选的变化不能自动解释为
  原图发生了变化。它不是线段检测器：不输出端点、长度或线段计数。

## 环境要求

- Windows 本地运行，Node.js >= 22.5（使用内置 `node:sqlite` 与 `node:test`，
  无原生扩展、无 Docker/WSL、无外部在线服务）。开发依赖仅 `typescript` 与 `@types/node`。

## 常用命令

```powershell
npm install        # 安装开发依赖
npm run build      # 编译到 dist/
npm test           # 编译并运行全部测试（node:test）
npm start          # 启动 API 服务（默认端口 0 = 自动选择空闲端口）
npm run demo       # CLI 演示：垂直线、水平线、交叉线
node scripts/smoke.mjs   # 端到端冒烟测试（启动服务→调用 API→关闭）
```

服务端口与数据库位置可配置：

```powershell
node dist/server.js --port 8080 --db data\hough.db
# 或用环境变量 PORT
```

数据目录默认为项目内 `data/`（数据库 `data/hough.db`）。SQLite 保存输入矩阵快照、
坐标口径、网格参数与全部投票结果，重启后报告可完整复现。

## HTTP API

统一错误格式：`{ "error": { "code": "...", "message": "..." } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/analyses` | 导入矩阵并投票。Body：`{matrix, thetaStepDeg, rhoStep, note?}`，返回 201 + 元信息与前 20 个候选 |
| GET | `/api/analyses` | 列出全部分析 |
| GET | `/api/analyses/:id` | 查看一个分析的元信息 |
| GET | `/api/analyses/:id/candidates?minVotes=&limit=` | 查询候选格 |
| GET | `/api/analyses/:id/slice?thetaIdx=` | 查看某个角度切片（该角度下所有有票的 rho 格） |
| GET | `/api/analyses/:id/cells/:thetaIdx/:rhoIdx/points?offset=&limit=` | 查询一个候选格的来源点（分页） |
| GET | `/api/analyses/:id/compare?with=:id2&minVotes=&limit=` | 比较两个分析（例如不同分辨率版本） |
| GET | `/api/analyses/:id/export` | 导出完整 JSON（矩阵、参数、全部票数） |

错误码：`INVALID_MATRIX`（非 0/1、行宽不一致、空矩阵）、`MATRIX_TOO_LARGE`、
`INVALID_GRID`（角度步长不能整除 180、rho 步长非正数或非有限值）、
`BUDGET_EXCEEDED`（投票预算超限）、`BAD_REQUEST`、`NOT_FOUND`、`INTERNAL`。
所有校验在写库前完成，投票与入库在同一事务中，非法或超限请求不会留下半张累加器。

内置限制（`src/hough.ts` 的 `LIMITS`）：宽/高 ≤ 512，角度格数 ≤ 180，
投票预算（边缘点数 × 角度格数）≤ 5,000,000。

## CLI

```powershell
npm run build
node dist/cli.js import fixtures\vertical-x2.json --theta-step 90 --rho-step 1 --note "垂直线"
node dist/cli.js list
node dist/cli.js show 1
node dist/cli.js candidates 1 --min-votes 2 --limit 10
node dist/cli.js slice 1 0            # thetaIdx=0 的角度切片
node dist/cli.js points 1 0 2         # 候选格 (thetaIdx=0, rhoIdx=2) 的来源点
node dist/cli.js compare 1 2          # 比较两个分析版本
node dist/cli.js export 1 out.json
node dist/cli.js demo                 # 内置演示
```

所有命令支持 `--db <路径>` 指定数据库文件（默认 `data/hough.db`）。

## 演示内容

`npm run demo` 在 6×6 图上依次展示：

1. 垂直线 `x = 2`：在 `theta = 0°`、`rho = 2` 处聚 6 票；
2. 水平线 `y = 3`：在 `theta = 90°`、`rho = 3` 处聚 6 票；
3. 交叉线 `x = 2` 与 `y = 3`：共享交点 `(2,3)` 在两个候选格中各投一票
   （每个点对每个角度格都投票，交点属于它所在的每一条直线）。

## 测试

`npm test` 覆盖：单点、空白图、全一图、负 rho、半格舍入（含负半格）、
近邻参数格平局排序、票数守恒、指定格与完整小矩阵的独立逐点求和核对、
输入转置后的角度对应关系（`rho'(θ) = rho(90°−θ)`，含法线角等价与浮点边界处理）、
参数校验与预算限制、API 错误码与「不留半张累加器」、数据库重启复现。
夹具在 `fixtures/` 中，预先写明坐标与答案。

## 目录结构

```
src/hough.ts    核心：校验、量化、投票、候选选择、支持点重算
src/store.ts    SQLite 持久化（事务写入，重启复现）
src/api.ts      HTTP API
src/server.ts   服务入口（可配置端口，默认空闲端口）
src/cli.ts      命令行工具与演示
test/           node:test 测试
fixtures/       预写坐标与答案的夹具
scripts/smoke.mjs  端到端冒烟测试
data/           项目内数据目录（SQLite 数据库）
```

## 已知限制

- 仅报告量化参数格；相邻格可能对应相近直线，输出条数不等于真实直线数。
- `node:sqlite` 在 Node 25 仍标记为 experimental（启动时有警告），接口在未来 Node 版本可能调整。
- 浮点 `sin/cos` 在互补角上可能差 1 ulp，恰好压在半格边界的 rho 在转置对应格之间可能差一格
  （测试中已按边界情形处理）。
- 单进程服务，无鉴权，面向本地分析用途。
