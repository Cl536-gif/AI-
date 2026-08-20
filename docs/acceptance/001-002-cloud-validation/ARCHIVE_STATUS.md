# 归档完整性状态

归档日期：2026-08-20

## 核心证据检查

| 检查项 | 状态 | 归档位置 |
|---|---|---|
| 001 基线 18 项静态/云端验收 | 已归档 | `001-baseline/ACCEPTANCE.md`、`001-baseline/raw-results.txt` |
| 001 真实权限、幂等和冲突测试输出 | 已归档 | `001-baseline/raw-results.txt` |
| 001 `chr(0)` 缺陷与修复结论 | 已归档 | `001-baseline/ACCEPTANCE.md`、`001-baseline/raw-results.txt` |
| 002a–002d 部署与结构验收 | 已归档 | `002-identity-merge/ACCEPTANCE.md`、截图目录 |
| 002 结构验证 75/75 | 已归档 | `002-identity-merge/raw-results.txt` |
| 002 完整行为测试 PASS | 已归档 | `002-identity-merge/raw-results.txt` |
| 双会话 PID（24591、70163） | 已归档 | `002-identity-merge/ACCEPTANCE.md`、`raw-results.txt`、截图 08/09 |
| 双会话锁等待与释放时间线 | 已归档 | `002-identity-merge/ACCEPTANCE.md`、`raw-results.txt` |
| 合并 ID `f4e8e10e-8e8d-4f36-a286-2277dfaf860f` | 已归档 | `002-identity-merge/ACCEPTANCE.md`、`raw-results.txt` |
| 清理结果 `CLEANUP_PASS,0,0,0` | 已归档 | `002-identity-merge/ACCEPTANCE.md`、`raw-results.txt` |
| 原始截图固定副本 | 已归档 | `001-baseline/screenshots/`、`002-identity-merge/screenshots/` |
| 001/002 SQL 仓库快照 | 已归档 | `sql-snapshots/` |
| 文件来源与证据边界 | 已说明 | `SOURCE_LIMITATIONS.md`、`evidence-index.csv` |
| 文件哈希 | 已生成 | `MANIFEST.sha256` |

## 已知边界

- 001 大部分 DMC 页面截图在当前会话中已不存在，已保存的完整文字原始输出作为主要证据；没有伪造缺失截图。
- 双会话验证现存截图覆盖会话 A；会话 B 的 PID、开始/返回时间和 RPC 返回值来自当时保留的原始文字输出。
- SQL 文件是归档日的仓库快照，不能在没有 DMC 文件导出的情况下宣称与当时执行文件逐字节相同。
- 本档案已从系统临时截图目录复制进仓库，可抵抗临时目录清理和未来数据库操作；当前未代替用户执行 Git 提交或远程备份。
