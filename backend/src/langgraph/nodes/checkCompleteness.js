// 完整性判断节点：检查六项信息是不是都已经 confirmed，决定接下来是
// "继续问下一项"还是"信息齐了，可以出方案"。
//
// 这个节点本身不调用模型——纯粹是读 state.slots 做判断，不涉及自然
// 语言生成，所以不会有"模型理解偏差"的问题，只要 slots 的状态本身是
// 准确的（这是 extractSlots/conflictRouter 的职责），这里的判断就
// 100%可靠。这正是把"六项收集到哪一步了"这件事从纯提示词挪到代码里
// 管理的意义所在。
//
// "该问哪一项"目前按 SLOT_KEYS 里定义的固定顺序（场景→口味→预算→
// 忌口→身材目标→是否运动）选第一个还没确认的——场景排第一是延续了
// 系统提示词第4条"第一个问题固定问场景"的要求，后面几项目前按列表
// 顺序来，不做更复杂的优先级判断。真正问出来的自然语言问题（包括
// 语气、格式这些要求）交给 askNextQuestion 节点处理，这里只负责
// "该问哪一项"这个决策本身。
const { SLOT_KEYS } = require('../state');

function checkCompleteness(state) {
  const nextSlotToAsk = SLOT_KEYS.find((key) => !state.slots[key]?.confirmed) || null;
  const isComplete = nextSlotToAsk === null;

  if (process.env.LANGGRAPH_DEBUG) {
    // eslint-disable-next-line no-console
    console.log(
      '[checkCompleteness]',
      isComplete ? '六项已全部确认' : `还缺: ${nextSlotToAsk}`
    );
  }

  return { isComplete, nextSlotToAsk };
}

module.exports = { checkCompleteness };
