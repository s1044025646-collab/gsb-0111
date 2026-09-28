# 本地地震震相拾取与震源定位后端

这是一个 Windows 本地可运行的 TypeScript/Node.js/SQLite 后端，只使用虚构合成数据，不连接真实地震台网，也不包含网页界面。它提供：

- 测站坐标、启用状态与时钟校准历史
- 可重复随机种子的合成波形生成与原始采样留存
- STA/LTA 风格的 P/S 自动拾取、到时误差和人工修订审计
- 速度模型版本、事件候选、P/S 关联和带权震源反演
- 稳定/拒绝定位解、逐拾取残差、不确定性、复核与发布状态
- 分页 HTTP API、命令行工作流、事务边界和进程重启持久化

## 环境要求

- Node.js 22 或更新版本（当前开发环境为 Node.js 25）
- npm
- Windows PowerShell

## 安装与测试

```powershell
npm install
npm test
npm run build
```

运行可重复端到端演示：

```powershell
npm run demo
```

演示不依赖真实等待；它使用固定时间戳和随机种子，展示一个四站稳定定位事件和一个单站伪触发拒绝事件。

## 启动与停止 API

默认使用本机 SQLite 文件 `data/seismic.sqlite`，监听 `127.0.0.1`，端口由操作系统自动分配：

```powershell
npm start
```

启动后终端会打印类似：

```text
Seismic API listening on http://127.0.0.1:53124
```

在该终端按 `Ctrl+C` 停止服务。也可以显式指定端口：

```powershell
$env:PORT="18080"
npm start
```

指定数据库文件：

```powershell
$env:SEISMIC_DB="E:\path\to\local.sqlite"
npm start
Remove-Item Env:SEISMIC_DB
```

迁移在启动时幂等执行，可重复启动，不会删除已有数据。

## API 摘要

所有列表接口支持 `page` 和 `limit`（1–200）。错误响应统一为：

```json
{ "error": { "code": "VALIDATION", "message": "latitude must be between -90 and 90" } }
```

错误码：

- `VALIDATION`：HTTP 400，参数非法
- `NOT_FOUND`：HTTP 404，实体或路由不存在
- `CONFLICT`：HTTP 409，状态冲突，例如发布被拒绝的解
- `UNPROCESSABLE`：HTTP 422，业务条件不足，例如没有活动速度模型
- `INTERNAL`：HTTP 500，意外错误

常用端点：

- `GET /health`
- `POST /stations`，`GET /stations`
- `POST /stations/:id/clock`
- `POST /velocity-models`，`GET /velocity-models`
- `POST /segments/synthetic`，`GET /segments`
- `POST /segments/:id/picks`，`GET /picks`，`POST /picks/:id/revision`
- `POST /events/associate`，`GET /events`，`GET /events/:id`
- `POST /events/:id/locate`
- `POST /events/:id/review`
- `GET /solutions`，`GET /solutions/:id`，`POST /solutions/:id/publish`

创建速度模型：

```powershell
$body = @{ name="v1"; pVelocityMps=5800; vpVsRatio=1.73; activate=$true } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:53124/velocity-models" -ContentType "application/json" -Body $body
```

## CLI 工作流

CLI 每次操作都打印执行前后的关键计数：测站、片段、有效拾取、事件和稳定解数量。

```powershell
npm run build
$db = ".\data\cli-demo.sqlite"
$env:SEISMIC_DB = $db
node dist/cli.js init-model --name local-v1
node dist/cli.js add-station --code S01 --lat 0.1 --lon 0 --clock-offset 80
node dist/cli.js add-station --code S02 --lat -0.1 --lon 0
node dist/cli.js add-station --code S03 --lat 0 --lon 0.1
node dist/cli.js add-station --code S04 --lat 0 --lon -0.1
node dist/cli.js calibrate-clock --station 1 --offset 80 --uncertainty 10 --reason "NTP calibration"
node dist/cli.js import-synthetic --station S01 --event-key quake-1 --origin 3000000 --lat 0.02 --lon -0.01 --depth 12000 --seed 1001
node dist/cli.js import-synthetic --station S02 --event-key quake-1 --origin 3000000 --lat 0.02 --lon -0.01 --depth 12000 --seed 1002
node dist/cli.js import-synthetic --station S03 --event-key quake-1 --origin 3000000 --lat 0.02 --lon -0.01 --depth 12000 --seed 1003
node dist/cli.js import-synthetic --station S04 --event-key quake-1 --origin 3000000 --lat 0.02 --lon -0.01 --depth 12000 --seed 1004
node dist/cli.js pick --segment 1
node dist/cli.js pick --segment 2
node dist/cli.js pick --segment 3
node dist/cli.js pick --segment 4
node dist/cli.js revise-pick --pick 1 --sample 125 --uncertainty 80 --decision confirmed --reason "manual refinement"
node dist/cli.js associate --window 5000
node dist/cli.js locate --event 1
node dist/cli.js explain --solution 1
node dist/cli.js review --event 1 --decision confirm --note "checked residuals" --reviewer operator
node dist/cli.js publish --solution 1
node dist/cli.js show-event --event 1
node dist/cli.js export-report --event 1
Remove-Item Env:SEISMIC_DB
```

## 定位与拒绝规则

反演使用 P/S 到时、到时误差倒数权重、局部笛卡尔坐标、恒定 P 速度和 Vp/Vs 比值，通过阻尼非线性最小二乘估计震中、深度、起震时刻及协方差不确定性。

以下情况不会伪造稳定解，而会保存 `quality=rejected` 的解和明确原因：

- 少于 4 个测站或少于 5 个到时
- 方位角覆盖严重退化或法方程奇异
- 水平/深度不确定性超过阈值
- RMS 或最大绝对残差超过阈值
- 存在无法解释的坏测站/晚到震相

关联逻辑按时间窗和“每站一个 P”形成候选，再在同站兼容 S−P 范围内匹配 S。重复片段和重复到时会幂等去重；相邻余震形成不同事件，晚到震相不会仅因“最近”而被并入已有事件。

## 审计与版本重现

- `waveform_segments.samples` 保留原始采样
- 修改拾取不会覆盖旧行：旧拾取标记为 `revised`，新拾取通过 `revised_from_pick_id` 关联
- `pick_revisions` 保存修改前后值、原因、操作者和时间
- 定位输入由模型 ID、拾取 ID、校正到时和到时误差生成 `input_hash`
- 修改拾取或速度模型会产生新的 `location_solutions`
- 已发布的历史解不会被覆盖，可按当时模型和输入哈希重现

## 数据与测试边界

数据完全由内置合成器生成。测试覆盖：

- 多站正常事件的到时误差、残差和定位精度
- 单站伪触发与少站拒绝
- 45 秒间隔的重叠余震不合并
- 已校准时钟偏移
- 坏测站大残差拒绝
- 共线退化站网拒绝
- 人工修订、历史解保留和速度模型版本隔离
- 重复导入/重复拾取幂等
- API 参数校验和分页
- SQLite 文件关闭重开后的持久化状态

不要在生产环境暴露服务到公网；该项目定位为本机研究/教学后端。
