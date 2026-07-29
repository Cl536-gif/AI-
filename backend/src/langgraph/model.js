// DashScope OpenAI 兼容接口配置
// 复用 backend/.env 中的 BAILIAN_API_KEY
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const { ChatOpenAI } = require('@langchain/openai');

// 跟用户对话、生成自然回复用这个——temperature调高一些是故意的，
// 需要语气有变化、不machine化。
const model = new ChatOpenAI({
  model: 'qwen-plus',
  temperature: 0.7,
  apiKey: process.env.BAILIAN_API_KEY,
  configuration: {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
});

// 真实测试发现：extractSlots（孤立数字"20"该不该填budget，连续5次跑
// 5次都错）、checkAsksTargetSlot（首轮"你好"这种明显合格的开场白，
// 偶尔被判成"没有实质提问"）这类"分类型判断"任务，如果复用上面那个
// temperature:0.7的model实例，判断结果会带着不必要的随机噪音——
// 0.7是为了让对话回复更自然多变而调高的，用在"这段话到底符不符合
// 某个二选一标准"这种应该趋于确定性的判断上，纯粹是噪音，不是特性。
// 这类任务（extractSlots抽取候选值、conflictRouter判断改口/顺嘴提及、
// resolvePendingConfirmation解析待确认回应、checkAsksTargetSlot判断
// 有没有问到目标字段）统一改用这个低temperature实例，跟对话生成的
// model分开，互不影响各自需要的特性。
const classifierModel = new ChatOpenAI({
  model: 'qwen-plus',
  temperature: 0,
  apiKey: process.env.BAILIAN_API_KEY,
  configuration: {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
});

module.exports = { model, classifierModel };
