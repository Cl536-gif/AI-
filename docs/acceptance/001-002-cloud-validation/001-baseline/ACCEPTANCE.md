# 001 基线真实云端验收

## 最终状态

通过。18 项基线全部 PASS，真实业务路径测试通过。

## 18 项基线检查

| # | 项目 | 结果 | 关键详情 |
|---:|---|---|---|
| 1 | `app.menstrual_profile_revisions` | PASS | exists=t, owner=diet_owner, rls=t, policies=2 |
| 2 | `app.profile_revisions` | PASS | exists=t, owner=diet_owner, rls=t, policies=2 |
| 3 | `app.user_consents` | PASS | exists=t, owner=diet_owner, rls=t, policies=2 |
| 4 | `app.user_events` | PASS | exists=t, owner=diet_owner, rls=t, policies=2 |
| 5 | `app.user_menstrual_profiles` | PASS | exists=t, owner=diet_owner, rls=t, policies=3 |
| 6 | `app.user_profiles` | PASS | exists=t, owner=diet_owner, rls=t, policies=3 |
| 7 | `app.users` | PASS | exists=t, owner=diet_owner, rls=t, policies=2 |
| 8 | `app.current_user_id()` | PASS | 函数存在 |
| 9 | `app.current_user_has_consent(varchar)` | PASS | 函数存在 |
| 10 | `vector` | PASS | 0.8.2 |
| 11 | `pgcrypto` | PASS | 1.3 |
| 12 | `diet_app` CONNECT | PASS | true |
| 13 | `diet_app` USAGE on `app` | PASS | true |
| 14 | `diet_app` cannot CREATE in `app` | PASS | false |
| 15 | `save_current_user_profile` | PASS | owner=diet_owner, SECURITY DEFINER, diet_app execute=t, PUBLIC=f |
| 16 | `save_current_user_menstrual_profile` | PASS | owner=diet_owner, SECURITY DEFINER, diet_app execute=t, PUBLIC=f |
| 17 | `record_current_user_consent` | PASS | owner=diet_owner, SECURITY DEFINER, diet_app execute=t, PUBLIC=f |
| 18 | `append_current_user_event` | PASS | owner=diet_owner, SECURITY INVOKER, diet_app execute=t, PUBLIC=f |

## 真实路径测试

- 权限/RLS 测试输出：`PASS,true,42501,1,0,true,42501,1`。
- 事件幂等与纠错测试输出：`PASS,true,23505,1,original,breakfast,0`。

## `chr(0)` 缺陷记录

静态审核阶段未发现该问题；真实腾讯云执行返回：

```text
pq: null character not permitted
```

根因是 PostgreSQL 文本/JSON 路径不允许空字符。修复方案为将参与指纹计算的值先编码为 JSON 数组，再进行哈希，避免把 `chr(0)` 作为文本分隔符。修复后真实测试通过。

这项记录说明：静态审核不能替代真实云端测试。

## 证据状态

- 完整文字原始输出：已保存于 `raw-results.txt`。
- 原始截图：当前可访问资料中不完整，见 `screenshots/README.md` 与根目录 `SOURCE_LIMITATIONS.md`。

