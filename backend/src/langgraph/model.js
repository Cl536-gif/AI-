// DashScope OpenAI 兼容接口配置
// 复用 backend/.env 中的 BAILIAN_API_KEY
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const { ChatOpenAI } = require('@langchain/openai');

const model = new ChatOpenAI({
  model: 'qwen-plus',
  temperature: 0.7,
  apiKey: process.env.BAILIAN_API_KEY,
  configuration: {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
});

module.exports = { model };
