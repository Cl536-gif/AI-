# 专属饮食秘书

需求文档：`专属饮食秘书_最简后端需求文档.md`（由需求方提供，未收录进本仓库）。

## 当前进度

需求文档「二、核心功能清单」全部已实现：

- [x] 1. 对话页面（前端）—— 见 `backend/public/`
- [x] 2. 后端中间层服务 —— 见 `backend/src/routes`、`backend/src/services/bailianClient.js`
- [x] 3. 密钥安全存储 —— 密钥通过 `.env` 管理，不提交到仓库
- [x] 4. 简易用户身份 + "上次活跃时间"记录 —— 见 `backend/src/services/userStore.js`
- [x] 5. 回复内容安全检查 —— 见 `backend/src/services/contentSafety.js`

尚未验证：真实的百炼 API 对话效果（当前开发环境出站网络无法访问阿里云域名，需要在本地或有公网访问权限的环境里验证，见 `backend/README.md` 底部说明）。

## 目录

- `backend/` — Node.js + Express 服务，同时托管聊天前端页面和后端中间层。详见 `backend/README.md`。
