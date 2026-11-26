# Agent 轨迹工作台（Trajectory Viewer 改版）

在原 Trajectory Viewer 的基础上改版，用来看 Tuple Agent 每一次运行的来龙去脉：这次主人发了什么、模型收到了什么上下文、每一轮想了什么、说了什么、调用了哪些工具、工具返回了什么、最后手机上实际显示的是什么。

账号仍然是 Tuple 邮箱登录，只能看到这个账号上传的轨迹。

## 页面

左边是运行列表（北京时间，按天分组；点确认卡等子运行缩进在对应对话下面，可筛选、只看失败、自动刷新）。右边四个标签：

- **过程**：最终回复（会标出“手机上显示的不是模型原文”“这次回复是一张卡片”“运行失败没有发出回复”等情况）、失败清单、轨迹时间条、每一轮的思考 / 输出 / 工具调用（参数、结果重点字段、完整结果、工具内部又调用的模型），以及卡片事件和之后的确认操作。
- **上下文**：选第几轮，看模型收到的完整请求。各段（Role / Rule / Style / SOP / Recent / 调用上下文 / Page / 工具定义）按字数画成占比条，点开看原文；最近聊天显示成对话气泡，日程和联系人显示成表格；第 2 轮起只显示相比上一轮新增的消息。可一键复制完整请求 JSON。
- **工具**：ToolPolicy 的结果（给了哪些、排除了哪些、为什么），以及提供给模型的全部工具定义和参数。
- **原始事件**：所有事件按顺序，点一行看 metadata 和存档内容。

快捷键：`J` / `K` 上下切换运行，`1`–`4` 切换标签，`/` 搜索。地址栏带运行 ID，链接可以直接分享（`#/run/<Run ID>?tab=context&round=2`）。

## 部署到 Vercel（团队共用）

在 Vercel 导入这个仓库即可，`vercel.json` 已经配好：静态页面来自 `ui/`，接口是 `api/index.js` 一个函数，函数放在香港（`hkg1`），离 Tuple 后端近。

环境变量（Project Settings → Environment Variables）：

| 名称 | 说明 |
| --- | --- |
| `SESSION_SECRET` | 建议设置：任意一长串随机字符。设置后登录 cookie 会加密，换掉它会让所有人重新登录。 |
| `TRAJECTORY_API_ORIGIN` | 可选，默认 `https://backend.tuple.fun`。 |

- Vercel 上不保存任何状态：Tuple 登录凭证只放在浏览器的 HttpOnly cookie 里，30 天有效。函数只负责把请求转给 Tuple 后端，不存储、不记录密码和轨迹内容。
- 同一个账号的网页登录同时只能有一个（后端规则），在别的网页端登录会把这里挤掉。

## 在自己电脑上运行（Go）

需要 Go 1.25+：

```sh
go run . -api-origin https://backend.tuple.fun -listen 127.0.0.1:8765 -state ./state
```

打开 <http://127.0.0.1:8765/>（用 127.0.0.1，不要用 localhost）。

- `-state DIR`：登录状态用 Windows DPAPI 加密保存在 `DIR/sessions.dat`，重启后不用再登录（其他系统上不保存）；同时生成 `DIR/cli.key` 给命令行用。`state/` 已在 `.gitignore` 里。
- `-ui ./ui`：直接从磁盘读界面，改完刷新页面即可，不用重新编译。
- 原来的界面保留在 `/classic/`。
- 部署到自己的服务器时，用 `-public-origin` 传 HTTPS 反向代理的外部地址，Go 只监听内网。

## 命令行 `tv.mjs`

配合本地 Go 服务（带 `-state`）使用，复用网页的登录状态，适合快速查轨迹：

```sh
node tv.mjs ls                            # 今天和昨天的运行：主人消息、回复、工具
node tv.mjs show <id>                     # 一次运行的全过程（--full 不截断，--json 结构化）
node tv.mjs ctx <id> --list               # 上下文各段字数；--section sop 打印某段；--conv / --new 看对话消息
node tv.mjs tools <id> [工具名]           # 提供给模型的工具定义
node tv.mjs events <id> --kind tool       # 原始事件
node tv.mjs payload <id> <seq>            # 某个事件的存档内容
node tv.mjs grep "<正则>" --since 2026-11-23 --in tools
```

`<id>` 可以是 Invocation ID、Run ID、Run ID 前缀，或 `last`、`last2`…。`TV_BASE` 可改服务地址。

## 接口

Go 服务和 Vercel 函数提供同一套接口：

- `GET /api/session`，`POST /api/login`，`POST /api/logout`
- `GET /api/trajectories`、`/api/trajectories/{id}`、`/{id}/events`、`/{id}/payloads/{payload}`：转发到后端 `/v1/agent/trajectories`
- `GET /api/bundle/{id}`：一次取回一条运行的详情、全部事件、全部存档内容和子运行（Go 服务带内存缓存）

## 代码结构

- `main.go`、`bundle.go`、`persist.go`、`seal_*.go`：Go 服务
- `api/index.js`：Vercel 函数（无状态版的同一套接口）
- `ui/`：工作台界面；`ui/digest.js` 把原始事件整理成“轮次 → 思考 / 输出 / 工具 / 结果”，界面和命令行共用
- `web/`：原界面（`/classic/`）
- `tv.mjs`：命令行

## 测试

```sh
go test -race ./...
npm test
```

## Repeat the simulator upload check

Use a fresh iOS simulator, an empty temporary directory and the repository's
isolated integration runner from the Tuple backend checkout.

```sh
export TRAJECTORY_SMOKE_DIR="$(mktemp -d)"
python3 scripts/tests/run_isolated_integration.py \
  --output "$TRAJECTORY_SMOKE_DIR/isolated" --packages ./modules/robot \
  --run '^TestTrajectory(MySQLMigrationHTTPAndAccountBarrier|SimulatorCloudRoundTrip)$' \
  --test-timeout 45m --execute
```

In a second terminal, use the same temporary directory. From the app checkout,
run the native test against the published loopback origin.

```sh
flutter test -d "$NEW_SIMULATOR_UDID" \
  --dart-define="PINCHEE_API_ORIGIN=$(cat "$TRAJECTORY_SMOKE_DIR/api-origin")" \
  integration_test/agent_trajectory_cloud_smoke_test.dart
```

For browser acceptance, start the viewer against the same origin. The isolated
fixtures use `trajectory-smoke-primary@example.test` and
`trajectory-smoke-control@example.test` with password
`isolated-trajectory-smoke-26`. The primary account can view the synthetic
trajectory. The control account has an empty list.

After browser acceptance, run
`touch "$TRAJECTORY_SMOKE_DIR/verify"` to finish the MySQL check and stop the
isolated backend. Stop its standalone viewer with Ctrl-C.
