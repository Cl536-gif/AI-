// Node.js 的全局 fetch（embedder.js 下载本地 embedding 模型权重用的就是它，
// 底层是 undici）默认不会读取 ALL_PROXY / HTTPS_PROXY 这类环境变量——
// 这跟 curl 等命令行工具的行为不一样，curl 会自动识别系统代理，Node 不会，
// 除非显式配置。真实环境里撞见过"curl测两个站点都是200，但build-index
// 下载模型时两个站点都connect timeout"这种看起来矛盾的情况，根因就是
// 这个：Node绕过了代理直连，而直连这两个站点本身是不通的。
//
// 用法：在跑 build-index / query 这类会触发下载模型的命令前，通过
// NODE_OPTIONS 预加载这个文件，把系统里已经配置好的代理接到 Node 的
// 全局 fetch 上，不需要改动 embedder.js 或者任何业务逻辑代码。
//
//   NODE_OPTIONS="--require ./scripts/proxy-preload.js" npm run build-index -- --kb diet
const { setGlobalDispatcher, ProxyAgent } = require('undici');

const proxyUrl = process.env.ALL_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy
  || process.env.HTTP_PROXY || process.env.http_proxy;

if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  // eslint-disable-next-line no-console
  console.log(`[proxy-preload] Node的fetch请求这次会通过代理: ${proxyUrl}`);
} else {
  // eslint-disable-next-line no-console
  console.log('[proxy-preload] 没有检测到 ALL_PROXY/HTTPS_PROXY/HTTP_PROXY 环境变量，跳过代理配置');
}
