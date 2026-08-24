# 003 腾讯云 PostgreSQL 连接池接入方案（审核稿）

> 状态：003a、003b、003c 已静态审核通过；003d 验证脚本已实现并等待静态审核；尚未连接腾讯云、尚未切换 UserStore 或业务流量。
>
> 前置基线：001 用户数据基线和 002 身份合并批次均已完成真实云端验收；002 临时“全部库”权限已经回收。
>
> 已确定部署通道：后端初步部署到 CloudBase Run，只通过腾讯云 VPC 内网访问 MemFire PostgreSQL；不搭建受控隧道，不临时开放公网地址。

## 1. 本批目标

为 Node.js 后端建立一个使用 `diet_app` 账号的 PostgreSQL 连接池，使后续 `UserStore` 腾讯云适配器只能通过受控事务访问数据库，并验证：

- 连接池可以建立、复用和关闭连接。
- 每个用户业务事务都先以参数化方式绑定 `app.current_user_id`。
- 用户上下文只在当前事务有效，连接归还池后不会泄漏给下一个用户。
- SQL 或 RPC 失败时先回滚，再归还连接；回滚失败时销毁该连接。
- 连接池耗尽、数据库超时或进程关闭时行为确定，不产生悬挂事务。
- 健康检查不会使用管理员账号，也不会绕过 RLS。

## 2. 明确边界

### 本批包含

1. 增加 Node.js PostgreSQL 驱动依赖。
2. 增加腾讯云连接池配置解析和严格校验。
3. 增加单例连接池生命周期管理。
4. 增加无用户上下文的普通连接辅助函数。
5. 增加带用户上下文的事务辅助函数。
6. 增加独立的连接池就绪检查和安全关闭逻辑。
7. 增加假连接池静态测试与真实腾讯云连通性测试脚本。
8. 保留真实测试的原始输出，但不记录数据库密码或完整连接串。

### 本批不包含

- 不把 `USER_STORE_ADAPTER` 切换到腾讯云。
- 不实现 38 个 `UserStore` 方法的 PostgreSQL 映射。
- 不删除或改写现有 SQLite 适配器。
- 不复用旧的 PolarDB Supabase `diet_user_store_execute` 分发架构。
- 不让 LangGraph 开始真实云端读写。
- 不执行迁移 SQL，不申请 DMC“全部库”SQL 窗口或 SQL 变更权限。
- 不使用 `admin_rag` 或 `diet_owner` 作为应用连接账号。

这样可以保持既定顺序：003 连接池接入完成后，下一批才做 `UserStore` 完整契约映射和测试。

## 3. 现状盘点

当前仓库有三种不同层次，不能混为一谈：

1. `src/services/userStore.js` 是当前可运行的 SQLite 实现。
2. `src/stores/supabaseUserStore.js` 是旧的 PolarDB Supabase 草稿，依赖一个尚未部署的统一分发 RPC。
3. 腾讯云 PostgreSQL 已部署的是 001—002 细粒度表、RLS 和 RPC，没有部署旧统一分发 RPC。

因此003不在旧 Supabase 适配器上打补丁，而是新增独立的 PostgreSQL 连接基础层。旧适配器暂时保留，等腾讯云 `UserStore` 完整契约通过后再单独决定归档或删除。

命名规则固定如下：

- `polardb-supabase` 和 `POLARDB_SUPABASE_*` 只属于未部署的旧 Supabase 草稿，不作为腾讯云连接配置，也不通过简单改名复用。
- 新连接基础层统一使用 `TENCENT_PG_*`。
- 当前 `USER_STORE_ADAPTER` 必须保持 `sqlite`；后续真实 PostgreSQL UserStore 完整实现并验收后，正式候选值使用 `tencent-postgres`。
- 运行时对旧值 `polardb-supabase` 和尚未完成的 `tencent-postgres` 都失败关闭，防止部署环境中的历史变量误启用错误适配器。

## 4. 文件拆分

建议将003拆为四个可独立静态审核的部分：

### 003a：配置与连接池工厂

- `src/db/postgresPoolConfig.js`
- `src/db/postgresPool.js`
- `.env.example` 的非敏感配置说明
- `.gitignore` 的本地环境文件保护（忽略 `.env.local` / `.env.*`，但保留 `.env.example`）
- `package.json` / `package-lock.json` 的 PostgreSQL 驱动依赖

### 003b：事务与用户上下文护栏

- `src/db/postgresTransaction.js`
- `withPostgresClient(callback)`
- `withUserTransaction(userId, callback)`

### 003c：就绪检查与进程关闭

- `src/db/postgresDiagnostics.js`
- `src/db/postgresReadiness.js`
- `src/serverLifecycle.js`
- `src/db/postgresPool.js` 的错误监听和幂等关闭状态机
- `src/server.js` 的 `/api/ready` 与信号接线
- 独立 `/api/ready`，数据库未就绪时返回非成功状态
- `SIGTERM` / `SIGINT` 停止接收新请求并关闭连接池
- 连接池错误日志脱敏

### 003d：验证脚本

- 纯本地假连接池行为测试
- 使用 `diet_app` 的真实云端连接池测试
- 用户上下文不串号测试
- 超时、回滚和池耗尽测试

003d 分成两个明确入口：

- `npm run test:003`：只运行003a—003d本地测试，不读取真实密码、不建立网络连接。
- `npm run verify:003d:cloud`：真实云内验收；只有同时满足私网地址、`USER_STORE_ADAPTER=sqlite` 和一次性人工确认开关时才会运行。

真实入口不会接受公网主机或域名，只接受 RFC1918 私网 IPv4。当前已知数据库私网端点是 `10.0.0.2:5432`，因此这个收紧不会影响本批部署；如果以后腾讯云改为私网 DNS，需要先静态审核域名与解析结果的双重校验，不能临时放宽为任意主机名。

003a—003d 全部静态审核通过后才进行真实连接测试。

## 5. 配置设计

使用拆分字段，不要求用户手写包含密码的完整 URL：

```dotenv
TENCENT_PG_HOST=
TENCENT_PG_PORT=5432
TENCENT_PG_DATABASE=diet_secretary
TENCENT_PG_USER=diet_app
TENCENT_PG_PASSWORD=
TENCENT_PG_SSL_MODE=require
TENCENT_PG_SSL_CA_BASE64=
TENCENT_PG_POOL_MAX=5
TENCENT_PG_IDLE_TIMEOUT_MS=30000
TENCENT_PG_CONNECT_TIMEOUT_MS=5000
TENCENT_PG_STATEMENT_TIMEOUT_MS=10000
TENCENT_PG_LOCK_TIMEOUT_MS=3000
TENCENT_PG_IDLE_TX_TIMEOUT_MS=15000
```

约束：

- 端口必须为 1—65535。
- 池上限初始只允许 1—20，默认 5；最终值必须结合数据库连接预算和后端副本数调整。
- 所有超时必须为有限正整数，并设置安全上限。
- 数据库名必须固定为 `diet_secretary`，应用账号必须固定为 `diet_app`；检测到 `admin_rag`、`diet_owner` 或其他账号时拒绝启动真实池。
- 密码为空时失败关闭，任何日志和错误对象都不得输出密码或完整连接串。
- `TENCENT_PG_SSL_MODE` 只允许 `disable`、`require`、`verify-full`；默认 `require`。`require` 表示明确加密但不校验证书链，`verify-full` 必须同时提供 `TENCENT_PG_SSL_CA_BASE64`。真实环境最终值根据实际接入端点和证书能力确认，不能静默降级。

连接池规模使用下面的预算原则，而不是把单机默认值复制到所有实例：

```text
每个后端副本的池上限 <= (数据库可分配给应用的连接数 - 运维保留连接数) / 最大后端副本数
```

## 6. 用户上下文事务护栏

RLS 依赖 `app.current_user_id()` 读取事务内配置 `app.current_user_id`。连接池复用连接时，禁止使用会残留到后续请求的会话级 `SET`。

每次用户业务调用必须遵循同一个不可绕过的顺序：

```sql
BEGIN;
SELECT set_config('app.current_user_id', $1, true);
SET LOCAL statement_timeout = '...';
SET LOCAL lock_timeout = '...';
SET LOCAL idle_in_transaction_session_timeout = '...';
-- 参数化 SQL 或 RPC
COMMIT;
```

其中 `$1` 必须先通过现有 `UserIdSchema`。第三个参数 `true` 表示只在当前事务有效。

代码约束：

- 用户数据访问不允许直接调用 `pool.query()`。
- `withUserTransaction` 必须独占一个 `client` 完成 `BEGIN`、上下文绑定、业务调用和 `COMMIT`。
- 回调只取得冻结的、仅含 `query(text, values)` 的作用域客户端，不取得原始 `pg.Client`、`release()` 或 `connect()`。
- 回调查询必须是单条非空 SQL 并显式提供参数数组；拒绝分号、SQL 注释、事务控制、会话控制和 `set_config()`，避免普通业务路径覆盖包装器边界。
- 任意业务错误都执行 `ROLLBACK`。
- `set_config`、超时设置或 `COMMIT` 失败也执行 `ROLLBACK`；`BEGIN` 失败时直接销毁连接。
- `ROLLBACK` 本身失败时，不把连接放回池，而是销毁。
- 回调结束后作用域客户端立即失效；仍在运行或已经失败但未等待的查询会阻止提交并触发回滚。
- `UserIdSchema`、回调类型和事务超时范围在借用连接前完成校验；注入测试配置也不能绕过003a的超时上下限。
- 不允许业务调用覆盖 `app.current_user_id`，也不向普通回调暴露设置会话级参数的辅助接口。
- RPC 的目标用户仍由 `app.current_user_id()` 读取；不因使用连接池而改为信任客户端传入的目标用户ID。

## 7. 健康检查与关闭

### 存活检查

现有 `/api/health` 只表示 Node.js 进程仍在运行，不访问数据库。

### 就绪检查

新增 `/api/ready`：

- 从连接池独占借用一个客户端，以客户端侧 `query_timeout=2000ms` 执行固定只读查询。
- 同时核对 `current_database() = 'diet_secretary'`、`current_user = 'diet_app'`，并要求 `current_setting('app.current_user_id', true)` 为空，主动发现会话上下文泄漏。
- 成功固定返回 HTTP 200 和 `{ "status": "ready" }`；失败固定返回 HTTP 503 和 `{ "status": "not_ready" }`。
- 查询错误、超时、身份不符或上下文残留时以 `release(error)` 销毁该连接，不把状态不确定的连接放回池。
- 响应和日志都不暴露主机、账号、数据库实际值、SQL 原文、错误原文、密码或连接串；诊断日志只保留固定事件名和经过格式白名单的错误码。
- 就绪检查不设置用户上下文，也不查询业务表；现有 `/api/health` 继续只表示 Node.js 进程存活。

连接池本身注册 `error` 监听器，避免空闲客户端的错误事件成为未处理事件；监听器同样只写入固定事件名和白名单错误码。连接池关闭状态为单向的 `open -> closing -> closed`，关闭开始后拒绝创建或借用新池，重复关闭共享同一个 Promise，`pool.end()` 最多调用一次。

### 进程关闭

收到 `SIGTERM` 或 `SIGINT` 后：

1. 立即调用 `server.close()` 停止接收新 HTTP 请求，并在支持时调用 `closeIdleConnections()` 清理空闲 keep-alive 连接。
2. 等待已进入处理的请求在10秒上限内结束。
3. HTTP请求排空后调用幂等的 `closePostgresPool()`，最终执行 `pool.end()`。
4. 正常完成以退出码0结束；10秒超时则调用 `closeAllConnections()`、限时尝试关闭数据库资源，并以退出码1结束。
5. 任意关闭错误只记录脱敏事件和错误码，不记录底层错误原文。

关闭控制器必须幂等；`SIGTERM`、`SIGINT` 连续到达时共享同一次关闭过程，避免重复关闭服务器、连接池或重复退出。

## 8. 网络前置条件

当前 DMC 登记的数据源位于广州，地址为 `10.0.0.2:5432`，这是私网地址。003 已确定使用 CloudBase Run 作为初步部署环境，并只走腾讯云内网。

创建 CloudBase Run 环境或服务时必须选择“已有私有网络”，并选择 MemFire PostgreSQL 实例所在的同一个 VPC；禁止选择由平台自动新建的网络。网络验收标准为：

1. CloudBase Run 与 PostgreSQL 必须位于同一地域（广州）。
2. 两端控制台显示的 VPC ID 必须完全一致；同一 VPC 内可以使用不同子网。
3. 仍需核对安全组、数据库访问控制和子网路由没有阻断 `5432`，不能把“同一 VPC”等同于所有访问控制自动放行。
4. 应用配置使用数据库私网地址，不写入公网地址，也不设置堡垒机或隧道参数。
5. 如果 CloudBase Run 服务尚未创建，则在首次创建时直接选定数据库 VPC；如果服务已经创建在其他 VPC，由于既有服务不能直接修改 VPC，本阶段优先在正确 VPC 重新创建服务，不为早期部署额外引入跨 VPC 对等连接。

在两端 VPC ID 的控制台证据保存前，003 可以继续静态审核，但不得开始真实云内连通测试。

### CloudBase Run 部署形态和顺序

当前后端是由 `src/server.js` 启动的常驻 Express 进程，应按 CloudBase Run 容器型服务部署。官方 `tcb cloudrun run` 本地运行命令只支持函数型服务，因此本项目不把它作为003的本地启动方式，也不为使用该命令而改造现有服务形态。

003采用以下顺序：

1. 本地继续使用 `npm run dev` 启动现有 Express 服务，完成003a—003d静态审核和假连接池测试；本地不连接 MemFire 真实实例，不申请数据库公网地址。
2. 在 CloudBase Run 创建容器型服务时明确配置服务端口，并通过部署参数或控制台选择 MemFire 所在的既有 VPC 和合适子网。
3. `.env.local` 或本地 `.env` 只用于本地非生产配置且必须保持在 `.gitignore` 中；它们不会作为线上密钥来源。CloudBase Run 的数据库密码、模型密钥以及后续企业微信密钥均在服务环境变量中单独配置。
4. 线上数据库主机固定使用 MemFire 私网地址，端口固定为 PostgreSQL `5432`；安全组或访问控制只允许必要的 CloudBase Run 子网来源，不开放 `0.0.0.0/0`。
5. 先通过 `/api/health`、003新增的 `/api/ready`、日志脱敏检查和真实连接池测试确认服务与数据库正常，再考虑配置企业微信公网 HTTPS 回调。
6. CloudBase Run 可以为企业微信回调开启服务的公网 HTTPS 入口，但这只代表“企业微信到后端”的入站公网访问；后端到数据库仍必须走 VPC 私网，两条链路不得混用。

部署命令的最终参数必须包含实际环境 ID、服务名、容器端口和已核验的 VPC/子网信息。003静态审核阶段只保留命令模板，不在未知 VPC ID 时执行部署。

### 连接数与弹性副本约束

CloudBase Run 会弹性扩缩容，连接池上限按“每个实例”生效。必须同时核对：

```text
每实例池上限 × CloudBase Run 最大实例数
  <= 数据库可分配给 diet_app 的连接数 - 运维保留连接数
因此不能只看到单实例默认池上限为5就直接上线。首次真实云端连接测试使用受控的小实例数和小连接池；连接预算确认前不开放业务流量。

## 9. 003d 完整测试清单

### 本地静态/假连接测试

1. 缺少任一必填配置时拒绝创建真实池。
2. 非法端口、池大小和超时值被拒绝。
3. 管理员或对象所有者账号被拒绝。
4. 连接池只创建一次。
5. 正常用户事务严格按 `BEGIN -> set_config -> SQL/RPC -> COMMIT -> release` 执行。
6. 业务失败严格按 `ROLLBACK -> release` 执行。
7. 回滚失败时销毁连接。
8. 非法 `userId` 在取得连接前即被拒绝。
9. 关闭函数可重复调用且只关闭一次。
10. 日志和错误消息不包含密码。
11. `.env`、`.env.local` 和其他真实环境文件均被 Git 忽略，`.env.example` 仍可被版本控制。

### 真实腾讯云测试

1. 以 `diet_app` 建立连接，数据库名和当前角色匹配。
2. `diet_app` 仍不能在 `app` schema 创建对象。
3. 无用户上下文时 `app.current_user_id()` 返回空，不能读取任意用户数据。
4. 用户A事务内 `app.current_user_id()` 精确返回用户A。
5. 提交并归还连接后，再次借用连接时上下文为空。
6. 在同一物理连接上先后执行用户A、用户B事务，确认不串号。
7. 用户A无法读取用户B行。
8. 调用一个已部署的只读/幂等 RPC，确认参数、返回值和权限正确。
9. 故意触发 SQL/RPC 错误后，下一次借用该连接仍可正常执行，证明已经回滚。
10. 人为占满小型测试池后，额外请求在连接超时内确定失败；释放连接后恢复。
11. `pool.end()` 后不再接受新借用。

真实测试使用专门测试用户并清理数据。原始输出至少保留：后端进程ID、数据库后端PID、事务前后 `app.current_user_id()`、错误码、等待时间和最终清理结果。

003d 的真实测试数据采用“沙箱事务 + 无条件回滚”，不要求给 `diet_app` 增加删除权限：

1. 事务包装器的真实提交、上下文清空、同一物理连接复用和错误回滚测试全部使用只读查询，不写入业务表。
2. 两个临时用户、跨用户RLS、事件RPC幂等重放和DDL拒绝测试放在同一个原始客户端沙箱事务内。
3. DDL拒绝测试单独使用保存点；预期的 `42501` 不会让后续回滚与清理验证失效。即使权限配置意外放宽、`CREATE TABLE` 意外成功，也会先回滚到保存点，再让整体验收失败，不留下对象。
4. 沙箱事务在成功和失败路径都执行 `ROLLBACK`；回滚失败时用 `release(error)` 销毁连接，并让验收失败。
5. 回滚后分别以两个临时用户上下文重新查询，要求用户与事件剩余数均为0；该清理证明也在只读事务结束时回滚。
6. 真实测试使用独立的 `max=1` 测试池，不使用或关闭线上HTTP服务的单例池；这样既能强制验证同一后端PID复用，也能确定性制造池耗尽。

真实入口的执行前置条件是：

```text
RUN_003D_CLOUD_VERIFY=CONFIRMED_PRIVATE_VPC
USER_STORE_ADAPTER=sqlite
TENCENT_PG_HOST=<已核对的RFC1918私网IPv4>
```

确认开关只在执行003d时临时设置，验收后从 CloudBase Run 环境变量中删除。脚本输出为逐行JSON，仅包含固定检查名、PASS/FAIL、时间、进程PID、数据库后端PID、白名单格式错误码、等待毫秒和清理计数；不输出主机、端口、账号、密码、连接串、SQL原文或数据库错误原文。

## 10. 不切换业务流量的判定

003通过只代表“连接基础层可靠”，不代表腾讯云 `UserStore` 已可用。以下条件满足前，`USER_STORE_ADAPTER` 必须继续保持 `sqlite`：

- 38 个 `UserStore` 方法已逐项实现或明确标记为本阶段不可用。
- 完整契约测试在腾讯云通过。
- LangGraph 真实云端读写及端到端回归通过。
- 故障回滚、并发和连接耗尽证据齐全。

## 11. 待审核决策

1. 是否同意003只做连接基础层，不在本批切换 `UserStore`。
2. 是否同意应用连接强制使用 `diet_app`，禁止管理员和 `diet_owner`。
3. 是否同意用户级数据库访问必须经过事务包装器，禁止直接 `pool.query()`。
4. 是否同意初始池上限默认 5，真实部署前再按连接预算调整。
5. 已确认真实连通测试只采用 CloudBase Run 与 PostgreSQL 同 VPC 的腾讯云内网通道；尚待保存两端 VPC ID 和端口访问控制的控制台证据。

## 12. 已知依赖审计待办

2026-08-19 在003a安装精确版本 `pg@8.23.0` 后执行依赖审计，发现3项既有问题，均不是本次 `pg` 引入：

- 2项低危来自未部署的旧 Supabase 依赖链。
- 1项高危来自开发依赖 `nodemon` 间接使用的 `brace-expansion`；生产启动不依赖 `nodemon`。

为避免在003连接密集验证期间引入无关依赖升级，本批不执行 `npm audit fix`。待003全部完成并进入依赖清理窗口后，单独评估旧 Supabase 依赖的归档/删除和 `nodemon` 升级，随后重新执行完整依赖审计并保存结果。
