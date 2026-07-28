const path = require('path');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const chatRouter = require('./routes/chat');
const chatLocalRouter = require('./routes/chatLocal');
const chatLanggraphRouter = require('./routes/chatLanggraph');

const app = express();

app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/chat', chatRouter);
app.use('/api/chat-local', chatLocalRouter);
app.use('/api/chat-langgraph', chatLanggraphRouter);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

app.listen(config.port, () => {
  console.log(`后端服务已启动: http://localhost:${config.port}`);
});
