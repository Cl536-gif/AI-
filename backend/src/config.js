require('dotenv').config();

const bailian = {
  apiKey: process.env.BAILIAN_API_KEY || '',
  appId: process.env.BAILIAN_APP_ID || '',
  baseUrl: process.env.BAILIAN_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1/apps',

  // 独立的本地知识库问答链路（/api/chat-local，仅供对比测试）用的是通用模型对话接口，
  // 跟上面绑定了知识库的百炼 App 是两回事；API Key 复用同一个（同一个阿里云账号）
  genericBaseUrl: process.env.BAILIAN_GENERIC_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  genericModel: process.env.BAILIAN_GENERIC_MODEL || 'qwen-plus',
};

if (!bailian.apiKey || !bailian.appId) {
  console.warn(
    '[警告] 未检测到 BAILIAN_API_KEY 或 BAILIAN_APP_ID，请检查 backend/.env 是否已正确配置。' +
      '在配置完成前，/api/chat 接口会返回错误。'
  );
}

// /api/chat-local 要同时查询的本地知识库名字（对应 local-kb-tool/kb-docs/<名字>/）
const localKbNames = process.env.LOCAL_KB_NAMES
  ? process.env.LOCAL_KB_NAMES.split(',').map((s) => s.trim()).filter(Boolean)
  : ['diet', 'body-composition'];

module.exports = {
  port: process.env.PORT || 3001,
  corsOrigin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
    : true,
  bailian,
  localKbNames,
};
