# 二值边缘图 Hough 直线投票与来源解释后端

面向小型零一矩阵的离散 Hough 直线分析服务，提供 HTTP API 与命令行（CLI）。
只做后端：没有图像上传、没有边缘检测器、没有相机标定、没有任意曲线识别。
输入矩阵中的 `1` 就是需要参与投票的边缘像素中心。

- 运行环境：Windows 本地、Node.js（建议 22.5+，开发与实测为 Node 25）、TypeScript
- 存储：内置 `node:sqlite`（Node 自带，无需 C++ 编译、无需 Docker/WSL）
- 不依赖任何在线 API 或付费服务

## 坐标口径与参数模型

- 矩阵左上角为原点；**列号 = x，行号 = y**；像素中心使用整数坐标 `(x, y)`。
- 直线参数式：`rho = x*cos(theta) + y*sin(theta)`。
- `theta` 是直线**法线**与 x 轴的夹角，不是直线自身的走向：
  - 垂直线 `x=2` 的法线沿 x 轴，在 `theta=0°, rho=2` 聚票；
  - 水平线 `y=3` 的法线沿 y 轴，在 `theta=90°, rho=3` 聚票。
- 角度网格固定为 `[0°, 180°)`（不含 180°），步长 `thetaStepDeg` 必须是**能整除 180 的正整数度**
  （1、2、3、4、5、6、9、10、12、15、18、20、30、36、45、60、90、180）。
- 距离步长 `rhoStep` 为用户给定的正有限数；`rho` 允许为负值，累加器覆盖图像对角线的正负距离。

### 距离量化（含负半格）

距离格编号明确采用：

```
rhoIndex = floor(rho / rhoStep + 0.5)
```

`floor` 为数学向负无穷取整，例如 `rhoStep=2` 时：

| rho | rho/rhoStep + 0.5 | floor | rhoIndex |
| --- | --- | --- | --- |
| 1.0 | 1.0 | 1 | 1 |
| -1.0 | 0.0 | 0 | 0 |
| -1.01 | -0.005 | -1 | -1 |
| -3.0 | -1.0 | -1 | -1 |

不会把负距离截到 0。格的代表距离为 `rho = rhoIndex * rhoStep`。

### 投票规则

- 每个边缘点对每个角度格**恰好投一票**，票落到该角度下量化得到的距离格。
- 票数守恒：全部角度格票数之和 = 边缘点数 × 角度格数。
- 空矩阵不产生任何有票格，不会制造虚假候选。
- 候选格返回：角度格编号、距离格编号、法线角、代表 `rho`、票数。
- 支持点在查询时按**同一量化规则**重新计算，不使用任何欧氏容差补点，也不会改变已保存票数；支持分页且始终报告总票数。

## 这不是线段检测器（重要语义）

- 输出是参数空间中的**累加器格（候选）**，不做非极大值抑制、不合并近邻峰、不恢复线段端点。
- 相邻角度/距离格可能描述同一条或非常相近的几何直线，因此**候选条数不等于图中真实直线条数**。
- 用不同网格分辨率重新分析同一输入时，候选格会因量化变化而变化；这**不能**解释为原图发生了变化，`compare` 只并排报告并显式说明。

## 限制与错误码

固定上限（可在 `src/hough.ts` 的 `LIMITS` 调整）：

- 宽、高各 ≤ 1024
- 角度格数 ≤ 360（即角度步长 ≥ 1°）
- 总投票预算 = 边缘点数 × 角度格数 ≤ 20,000,000

参数校验在分配累加器之前完成；非法矩阵、非有限/非正步长、超限请求直接失败，不会留下半张成功累加器；数据库写入在单个事务中完成，失败回滚。

| 错误码 | 含义 | HTTP |
| --- | --- | --- |
| `INVALID_MATRIX` | 非数组、锯齿、元素不是 0/1 | 400 |
| `MATRIX_TOO_LARGE` | 宽高超限 | 413 |
| `INVALID_THETA_STEP` | 角度步非正整数或不能整除 180 | 400 |
| `INVALID_RHO_STEP` | rhoStep 非正或非有限 | 400 |
| `GRID_TOO_LARGE` | 角度格数超限 | 413 |
| `VOTE_BUDGET_EXCEEDED` | 投票总数超预算 | 413 |
| `INVALID_CELL` / `INVALID_QUERY` | 格编号或分页参数非法 | 400 |
| `NOT_FOUND` | 分析或路由不存在 | 404 |
| `BODY_TOO_LARGE` | 请求体超过 8MB | 413 |

## 快速开始（Windows PowerShell）

```powershell
npm install
npm run build      # TypeScript 编译到 dist/
npm test           # 构建 + 25 个测试（算法、持久化、HTTP API）
npm run demo       # 垂直/水平/交叉/切片/分辨率比较的完整演示
npm start          # 启动 HTTP API；默认端口 0 = 自动选择空闲端口
```

指定端口与数据目录：

```powershell
$env:HOUGH_DATA_DIR = "E:\GSB\0403\B\data"
node --disable-warning=ExperimentalWarning dist/src/cli.js serve --port 8080 --host 127.0.0.1
```

端口被占用时会自动回退到操作系统分配的空闲端口；启动日志打印实际地址。

## HTTP API

```text
GET  /api/health
POST /api/analyses                       # { matrix, config:{thetaStepDeg,rhoStep}, name? }
GET  /api/analyses                       # 列表（不含矩阵与格明细）
GET  /api/analyses/:id                   # 元数据 + 全部有票格
GET  /api/analyses/:id/candidates?minVotes=&limit=
GET  /api/analyses/:id/slices/:thetaIndex
GET  /api/analyses/:id/cells/:thetaIndex/:rhoIndex/support?page=&pageSize=
GET  /api/analyses/:id/export            # 含输入快照、坐标口径、参数、结果格的 JSON
POST /api/compare                        # { a, b, minVotes?, limit? }
```

候选排序固定为：先按票数降序，票数相同按角度格升序，再按距离格升序。

调用示例：

```powershell
$body = '{"matrix":[[0,0,1,0],[0,0,1,0],[0,0,1,0],[1,1,1,1]],"config":{"thetaStepDeg":15,"rhoStep":1}}'
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/api/analyses -ContentType 'application/json' -Body $body
```

## CLI

```powershell
node dist/src/cli.js import --matrix examples/cross.json --theta 15 --rho 1 --name cross
node dist/src/cli.js list
node dist/src/cli.js candidates <id> --min-votes 4 --limit 10
node dist/src/cli.js slice <id> 6
node dist/src/cli.js support <id> 6 3 --page 0 --page-size 100
node dist/src/cli.js compare <idA> <idB>
node dist/src/cli.js export <id> --out report.json
```

矩阵文件为 JSON 二维 0/1 数组，见 `examples/`。

## 持久化

SQLite 数据库位于 `data/hough.sqlite`（可用 `HOUGH_DATA_DIR` 覆盖）。保存内容：

- 输入矩阵快照与边缘点坐标（左上角、列 x 行 y、整数像素中心）
- 角度/距离参数、累加器范围、总投票预算与每格票数

重启后按 id 取回的报告与投票完成时完全一致；支持点仅在查询时重算。

## 目录结构

```text
src/hough.ts    核心：矩阵校验、量化、累加器、候选、支持点、切片、逐点核对
src/db.ts       SQLite 快照/结果持久化、导出、分辨率比较
src/server.ts   无第三方依赖的 HTTP API
src/cli.ts      CLI 入口
src/demo.ts     演示脚本
test/           node:test 测试与预写坐标/答案的夹具
examples/       示例矩阵
```

## 已知限制与合理假设

- 只支持 `theta ∈ [0°,180°)` 的无向直线；同一直线的另一种有向表示 `(theta+180,-rho)` 不在网格内。
- 不做线段端点、间隙长度、粗细或非极大值抑制处理。
- 请求体上限 8MB；超大型图请先在外部裁剪，本服务不包含任何图像 IO 或边缘提取。
- Node 的 SQLite 仍带 Experimental 标记，启动命令用 `--disable-warning=ExperimentalWarning` 抑制提示，功能不受影响。
