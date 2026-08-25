const express = require('express');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function installModuleStub(modulePath, exports) {
  const filename = require.resolve(modulePath);
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
  };
}

async function main() {
  const expectedUserId = 'anon:004p-async-http-user';
  let identityResolved = false;
  let graphInvocations = 0;
  let persistenceCalls = 0;

  installModuleStub('./src/services/identityService', {
    validateDeviceId(deviceId) {
      if (!/^device-[a-z0-9-]{8,64}$/.test(String(deviceId || ''))) {
        throw new Error('deviceId格式不正确');
      }
      return deviceId;
    },
    async resolveAnonymousUser() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      identityResolved = true;
      return expectedUserId;
    },
  });
  installModuleStub('./src/services/userService', {
    async updateTimezone() {
      throw new Error('本测试不应更新时区');
    },
  });
  installModuleStub('./src/services/graphPersistenceCoordinator', {
    async prepareGraphContext(userId) {
      assert(identityResolved, '身份Promise未完成就读取上下文');
      assert(userId === expectedUserId, '上下文读取收到未解析身份');
      return { accessMode: 'free', temporalContext: null };
    },
    async persistGraphTurn(userId, message, threadId) {
      persistenceCalls += 1;
      assert(identityResolved, '身份Promise未完成就持久化');
      assert(userId === expectedUserId, '持久化收到未解析身份');
      assert(message === '今天午餐怎么吃？', '持久化消息被错误改写');
      assert(typeof threadId === 'string' && threadId.length > 0, '没有生成threadId');
      return {
        profilePersistence: { status: 'unchanged', profile: null },
        advicePersistence: { status: 'unchanged', records: [] },
        serviceStatus: { status: 'free' },
        eventPersistence: { status: 'not_entitled', recordedEvents: [] },
        planAdjustment: { status: 'not_evaluated', action: 'none' },
        planRecovery: { status: 'not_applicable', action: 'none' },
        planRevision: { status: 'not_requested', plan: null },
        initialLongTermPlan: { status: 'not_requested', plan: null },
      };
    },
  });
  installModuleStub('./src/langgraph/graph', {
    workflow: {
      compile() {
        return {
          async invoke(input) {
            graphInvocations += 1;
            assert(identityResolved, '身份Promise未完成就调用LangGraph');
            assert(input.longTermContext?.accessMode === 'free', '未将长期上下文传入LangGraph');
            return {
              ...input,
              messages: [
                ...input.messages,
                { role: 'ai', content: '建议午餐搭配主食、蛋白质和蔬菜。' },
              ],
              slots: {},
              isComplete: false,
            };
          },
        };
      },
    },
  });

  const routePath = require.resolve('./src/routes/chatLanggraph');
  delete require.cache[routePath];
  const router = require(routePath);
  const app = express();
  app.use(express.json());
  app.use('/api/chat-langgraph', router);
  app.use((error, req, res, next) => {
    void req;
    void next;
    res.status(500).json({ error: error.message });
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/chat-langgraph`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: '今天午餐怎么吃？',
        deviceId: 'device-004p-async-http',
      }),
    });
    const body = await response.json();
    assert(response.status === 200, `异步身份HTTP请求失败: ${response.status}`);
    assert(body.identityStatus === 'anonymous_resolved', '返回结果未标记匿名身份已解析');
    assert(body.contextAccessMode === 'free', '返回结果丢失上下文权限');
    assert(body.reply.includes('午餐搭配'), '返回结果丢失LangGraph回复');
    assert(graphInvocations === 1 && persistenceCalls === 1, '图执行或持久化调用次数错误');

    const invalidResponse = await fetch(`http://127.0.0.1:${port}/api/chat-langgraph`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '你好', deviceId: 'bad' }),
    });
    const invalidBody = await invalidResponse.json();
    assert(invalidResponse.status === 400, '非法deviceId未在HTTP边界拒绝');
    assert(invalidBody.error === 'deviceId格式不正确', '非法deviceId错误形状不稳定');
    assert(graphInvocations === 1 && persistenceCalls === 1, '非法deviceId仍进入图或持久化');

    console.log(JSON.stringify({
      batch: '004p-chat-langgraph-async-http',
      status: 'PASS',
      identityAwaitedBeforeContext: true,
      identityAwaitedBeforeGraph: true,
      identityAwaitedBeforePersistence: true,
      invalidDeviceRejectedBeforeGraph: true,
    }));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    batch: '004p-chat-langgraph-async-http',
    status: 'FAIL',
    errorCode: error.code || 'UNKNOWN',
    message: error.message,
  }));
  process.exit(1);
});
