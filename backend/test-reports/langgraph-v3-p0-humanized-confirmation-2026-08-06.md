# LangGraph V3 P0：自然确认与清晰信息整体接收

- 日期：2026-08-06
- 目标：清除机械确认开场、避免明确资料被拆成问卷、阻止同字段重复确认
- 结论：代码级与真实接口回归通过

## 主要修改

1. 清晰原文证据优先：食堂/外卖、食堂模式、带单位预算、明确忌口、目标、运动频率和明确口味可一次接收。
2. 长句漏抽兜底：模型漏掉“没有忌口”“每周跑步两次”等明确表达时，由确定性规则恢复。
3. 真正需要确认的情况改用确定性模板：
   - 首次推断：`这里我理解成“___”，对吗？`
   - 信息改口：`___前面记录的是“___”，现在需要改成“___”，对吗？`
   - 菜品口味推断继续说明推断依据后确认。
4. 同字段确认完成、拒绝或超限后，从当前确认项及队列一起清除，并阻止同轮重新抽取。
5. 通用格式守卫新增机械开场检测：`诶、哎、你刚说、你刚才、刚看到、刚听你说`。
6. 普通提问生成失败时使用字段专属自然兜底问题，不再显示“回到咱们刚才的话题，某项还没确认清楚”。
7. 首次身份介绍移至统一入口，用户首句一次说完资料也不会漏掉自我介绍。

## 自动化回归

通过：

```text
manual-test-humanized-confirmation.js
manual-test-direct-question-priority.js
manual-test-returning-user-context.js
scenario26-multi-slot-queue.js
scenario30-explicit-addition-not-correction.js
scenario29-confirmation-with-supplement.js
scenario43-food-rejection-transition.js
manual-test-initial-long-term-lifecycle.js
manual-test-long-term-sex-eligibility.js
manual-test-stage-plan-service.js
manual-test-graph-persistence-coordinator.js
manual-test-renewal-reminder-service.js
```

## 最终真实接口记录

用户：

```text
你好，我是女大学生，目标减脂，平时主要在食堂吃，食堂是自选，每顿预算20元，喜欢酸甜和辣，没有忌口，每周跑步两次。
```

秘书第一条：

```text
你好～我是你的私人健康饮食管理秘书，会先了解你的真实饮食习惯，再陪你一点点找到更适合自己的吃法。
```

秘书第二条直接进入免费问答与长期规划的服务选择，没有逐项复核七项资料。

最终状态：

```text
scene=食堂，confirmed=true
cafeteriaMode=自己挑菜，confirmed=true
budget=每顿20元，confirmed=true
taste=喜欢酸甜和辣，confirmed=true
restrictions=没有忌口或已知过敏，confirmed=true
goal=减脂，confirmed=true
exercise=每周跑步两次，confirmed=true
isComplete=true
```

会话编号：`d60ad0a1-8c61-4d8f-8984-ee85285cf286`

核验结果：

- 没有出现机械确认开场。
- 没有擅自加入“最近”。
- 没有把七项拆成逐轮确认。
- 没有重复询问食堂模式。
- 首次身份介绍只发送一次。
- 长期方案资格、首个正式方案、14天体验和第13天提醒回归无异常。

