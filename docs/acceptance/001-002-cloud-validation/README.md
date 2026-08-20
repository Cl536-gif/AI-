# 001–002 腾讯云 PostgreSQL 真实云端验收档案

归档日期：2026-08-20（Asia/Shanghai）

## 归档目的

本目录持久化保存 001 基线与 002 身份合并批次的真实云端验收证据。即使后续重建上海数据库、停用广州实例或清理测试数据，本档案也应继续保留。

本次归档仅整理仓库文件，不对数据库、VPC、安全组或其他云资源执行任何修改。

## 结论

- 001 基线：18 项结构与权限验收全部 PASS；真实云端测试发现并修复 `chr(0)` 哈希缺陷。
- 002 身份合并：002a–002d 部署与完整验证通过。
- 002d 结构检查：75/75 PASS，0 FAIL。
- 002d 行为检查：PASS。
- `FOR KEY SHARE` 双会话验证：真实阻塞与释放顺序成立。
- 合并 ID：`f4e8e10e-8e8d-4f36-a286-2277dfaf860f`。
- 最终清理：`CLEANUP_PASS,0,0,0`。
- 2026-08-20 后续只读盘点确认 `app` 下 13 张业务表均为空，因此不存在需要迁移的正式业务数据；001/002 验收证据以本目录为长期留档载体。

## 证据分层

1. `ACCEPTANCE.md`：便于人工审核的结论、检查项和时间线。
2. `raw-results.txt`：按当时对话记录原样固化的 DMC/SQL 输出。
3. `screenshots/`：仍可读取的原始截图文件副本。
4. `sql-snapshots/`：归档时仓库中的 001/002 SQL 文件快照；它们用于复核设计，不声明与当时云端执行字节完全一致。
5. `MANIFEST.sha256`：档案文件的 SHA-256 完整性清单。

## 目录

- `001-baseline/ACCEPTANCE.md`：001 的 18 项基线、真实测试结果和 `chr(0)` 缺陷记录。
- `001-baseline/raw-results.txt`：001 原始文字输出。
- `001-baseline/screenshots/README.md`：001 截图可用性说明。
- `002-identity-merge/ACCEPTANCE.md`：002a–002d、双会话并发及清理证据。
- `002-identity-merge/raw-results.txt`：002 原始文字输出。
- `002-identity-merge/screenshots/`：002 现存原始截图副本。
- `evidence-index.csv`：逐项证据索引、来源与证明内容。
- `SOURCE_LIMITATIONS.md`：证据来源边界与已知缺口。
- `TREE.txt`：归档文件树。
- `MANIFEST.sha256`：完整性校验值。

## 完整性验证

在本目录执行：

```bash
shasum -a 256 -c MANIFEST.sha256
```

全部显示 `OK` 才能确认归档文件自生成清单后未被改写。

