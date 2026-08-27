# 005n CloudBase发布控制面回滚演练

## 目标

把005i已验证的`rollback`信号与005k稳定SQLite修订连接起来，真实证明CloudBase同一服务能够从灰度修订回退到原稳定修订。演练只允许在独立临时服务执行，不改变正式`diet-secretary-api`，也不读写PostgreSQL。

## 固定边界

- 临时服务名：`diet-secretary-rollback-control-005n`；构建目录为`backend`。
- 所有修订必须保持`USER_STORE_ADAPTER=sqlite`、`LANGGRAPH_CHECKPOINTER_BACKEND=memory`。
- 稳定与灰度必须是同一服务的两个不同部署修订；不允许用两个服务替代。
- `signal`仅输出控制面动作要求，不调用腾讯云API；回退动作由CloudBase部署版本页面人工执行并保留操作记录。
- 不配置PostgreSQL地址、用户、密码、证书或百炼凭据；不接入真实流量。

## 稳定修订环境

```text
NODE_ENV=production
PORT=3001
USER_STORE_ADAPTER=sqlite
LANGGRAPH_CHECKPOINTER_BACKEND=memory
RUN_005N_ROLLBACK_CONTROL_VERIFY=CONFIRMED_005N_CLOUDBASE_ROLLBACK_CONTROL
RUN_005N_DEDICATED_SERVICE=CONFIRMED_005N_DEDICATED_ROLLBACK_SERVICE
CLOUDBASE_ROLLBACK_RUN_ID=005n-cloud-20260827-01
CLOUDBASE_ROLLBACK_REHEARSAL_ROLE=stable
```

部署后运行：

```sh
node manual-test-cloudbase-rollback-control-cloud-guard.js
node manual-test-cloudbase-rollback-control-cloud.js baseline
```

保存`revisionFingerprint`，不得保存Pod名或原始修订ID。

## 灰度修订环境

在同一服务更新环境变量：

```text
CLOUDBASE_ROLLBACK_REHEARSAL_ROLE=canary
```

部署新修订。在WebShell中以会话变量加入基线摘要和005i策略：

```sh
export CLOUDBASE_005N_STABLE_REVISION_FINGERPRINT='<baseline revisionFingerprint>'
export RUN_005I_ROLLBACK_POLICY=CONFIRMED_005I_AUTOMATIC_ROLLBACK_SIGNALS
export TENCENT_PG_ROLLBACK_MIN_SAMPLES=100
export TENCENT_PG_ROLLBACK_POOL_SATURATION_PCT=90
export TENCENT_PG_ROLLBACK_WAITING_CLIENTS=2
export TENCENT_PG_ROLLBACK_READINESS_FAILURES=3
export TENCENT_PG_ROLLBACK_CONNECTION_TIMEOUT_RATE_PCT=5
export TENCENT_PG_ROLLBACK_TRANSACTION_FAILURE_RATE_PCT=5
export TENCENT_PG_ROLLBACK_HTTP_SIDE_EFFECT_FAILURE_RATE_PCT=5
export TENCENT_PG_ROLLBACK_IDENTITY_FAILURE_RATE_PCT=5
node manual-test-cloudbase-rollback-control-cloud.js signal
```

必须得到`rollbackSignal=rollback`、`controlPlaneActionRequired=true`，并保存灰度`revisionFingerprint`。

## 控制面回退与验证

1. 打开临时服务的“部署版本”。
2. 对稳定修订执行“回退”，确认流量100%回到稳定修订并等待实例Running。
3. 进入回退后的稳定Pod WebShell：

```sh
export CLOUDBASE_005N_STABLE_REVISION_FINGERPRINT='<baseline revisionFingerprint>'
export CLOUDBASE_005N_CANARY_REVISION_FINGERPRINT='<signal revisionFingerprint>'
export RUN_005N_CONTROL_PLANE_ACTION=CONFIRMED_005N_MANUAL_CLOUDBASE_ROLLBACK
node manual-test-cloudbase-rollback-control-cloud.js verify
```

只有`stableRevisionRestored=true`、`canaryRevisionReplaced=true`、`controlPlaneActionConfirmed=true`同时成立才通过。随后保存部署版本操作截图、归档脱敏输出并删除临时服务。

## 失败关闭

任一确认缺失、两个修订摘要相同、回退后摘要不等于基线、环境不是SQLite/memory、健康检查失败或修订身份不可解析，均输出`FAIL`且不得计入最终Go/No-Go证据。
