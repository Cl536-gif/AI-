# 005j SQLite 数据盘点与空库启动处置验收

验收日期：2026-08-26（Asia/Shanghai）

## 结论

005j 已完成本机SQLite、当前正式CloudBase SQLite及PostgreSQL目标库的只读盘点，并取得本机开发测试数据不迁移的显式批准。

- 本机SQLite：17张预期业务表、83个用户根记录、410行总记录，完整性`ok`、外键违规0、无效JSON 0；
- 当前正式CloudBase唯一Running Pod：17张SQLite业务表逐表均为0；
- PostgreSQL目标库：23张目标业务表逐表均为0；
- 本机410行经项目负责人确认属于开发测试痕迹，不包含需要保留的正式用户资料；
- 正式启用PostgreSQL时采用空库启动，不把本机SQLite数据迁入目标库；
- 本机SQLite文件保留原样备份，不删除、不覆盖、不提交Git、不上传。

## 已验证能力

1. SQLite盘点入口缺少显式确认或文件缺失时失败关闭。
2. 盘点只输出表级计数、完整性、外键和JSON合法性聚合，不输出原始ID、身份摘要或业务正文。
3. 非空SQLite默认返回`MIGRATION_OR_EXPLICIT_DISCARD_REQUIRED`，不会自动选择空库启动。
4. 当前正式CloudBase唯一Pod的SQLite已逐表确认全空。
5. PostgreSQL目标23张业务表已通过DMS只读查询逐表确认全空。
6. 本机唯一非空源已取得明确的不迁移批准，批准边界仅覆盖当前已盘点文件。

## 数据处置边界

- “丢弃”仅指不迁移到正式PostgreSQL，不授权删除或修改本机SQLite文件。
- 若以后发现其他SQLite副本、旧Pod或人工备份，必须重新只读盘点并单独决策。
- PostgreSQL目标在正式启用前必须再次只读确认全空；出现无法解释的行时失败关闭。
- 本验收不授权全量PostgreSQL切换；005k稳定回滚制品、005l备份恢复和005m最终Go/No-Go仍未完成。
- 验收档案不保存连接信息、凭据、原始身份、用户档案、事件、建议或计划正文。

## 完整性校验

在本目录运行：

```sh
shasum -a 256 -c MANIFEST.sha256
```
