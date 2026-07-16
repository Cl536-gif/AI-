require('dotenv').config();

const bailian = {
  apiKey: process.env.BAILIAN_API_KEY || '',
  appId: process.env.BAILIAN_APP_ID || '',
  baseUrl: process.env.BAILIAN_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1/apps',
};

if (!bailian.apiKey || !bailian.appId) {
  console.warn(
    '[警告] 未检测到 BAILIAN_API_KEY 或 BAILIAN_APP_ID，请检查 backend/.env 是否已正确配置。' +
      '在配置完成前，/api/chat 接口会返回错误。'
  );
}

module.exports = {
  port: process.env.PORT || 3001,
  corsOrigin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
    : true,
  bailian,
};
