const path = require('path');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const chatRouter = require('./routes/chat');
const chatLocalRouter = require('./routes/chatLocal');
const chatLanggraphRouter = require('./routes/chatLanggraph');
const debugUserDataRouter = require('./routes/debugUserData');
const { createWecomCallbackRouter } = require('./routes/wecomCallback');
const { createWecomRuntime } = require('./wecom/wecomRuntime');
const { configureUserStoreFromEnv } = require('./stores/userStoreProvider');
const { createPostgresReadinessHandler } = require('./db/postgresReadiness');
const { createGracefulShutdown } = require('./serverLifecycle');
const { closePostgresPool } = require('./db/postgresPool');

// SQLite remains the default. Tencent PostgreSQL is selected only when the
// deployment explicitly sets USER_STORE_ADAPTER=tencent-postgres.
configureUserStoreFromEnv();

const app = express();
const wecomRuntime = createWecomRuntime();

app.use(cors({ origin: config.corsOrigin }));

// 企业微信回调是 XML，必须在全局 JSON parser 之前保留原始正文。
app.use(
  '/api/wechat-callback',
  express.text({ type: ['text/xml', 'application/xml'], limit: '256kb' }),
  createWecomCallbackRouter({ config: wecomRuntime.config, store: wecomRuntime.store })
);
// 回调端点不向企业微信泄露内部堆栈或配置信息。
// eslint-disable-next-line no-unused-vars
app.use('/api/wechat-callback', (err, req, res, next) => {
  console.error(err);
  const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
  res.status(status).type('text/plain').send(status >= 500 ? 'Internal Server Error' : err.message);
});

app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/ready', createPostgresReadinessHandler());

app.use('/api/chat', chatRouter);
app.use('/api/chat-local', chatLocalRouter);
app.use('/api/chat-langgraph', chatLanggraphRouter);
app.use('/api/debug/user-data', debugUserDataRouter);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

const server = app.listen(config.port, () => {
  console.log(`后端服务已启动: http://localhost:${config.port}`);
  wecomRuntime.start();
});

createGracefulShutdown({
  server,
  closeResources: async () => {
    await wecomRuntime.stop();
    await closePostgresPool();
  },
});
