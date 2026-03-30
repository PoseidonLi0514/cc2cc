const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const express = require('express');
const path = require('path');
const { KeyManager } = require('./keyManager');
const { anthropicToOpenAI, openaiToAnthropic } = require('./transform');
const { OpenAIToAnthropicSSETransform } = require('./streaming');
const { estimateRequestTokens } = require('./tokenEstimator');

const app = express();
const keyManager = new KeyManager();

// 已登录的 session token 集合（token → 过期时间戳）
const sessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 小时

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [token, expiresAt] of sessions) {
    if (expiresAt < now) sessions.delete(token);
  }
}

// ============================================================
// 管理面板鉴权中间件
// 规则：
//   - 没有任何 key 时 → 无需鉴权，直接放行
//   - 有 key 时 → 需要用任意一个已存在的 key 登录获取 session token
//   - /v1/messages（代理接口）不鉴权
//   - /admin/auth-status 和 /admin/login 不鉴权
// ============================================================

function adminAuth(req, res, next) {
  // 没添加过 key → 无需鉴权
  if (!keyManager.hasAnyKeys()) {
    return next();
  }

  // 从 Authorization header 或 query 取 token
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : req.query.token;

  if (!token) {
    return res.status(401).json({ error: '需要登录', needAuth: true });
  }

  cleanExpiredSessions();
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    sessions.delete(token);
    return res.status(401).json({ error: 'token 已过期，请重新登录', needAuth: true });
  }

  next();
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ============================================================
// 鉴权相关接口（不需要 adminAuth）
// ============================================================

// 检查是否需要鉴权
app.get('/admin/auth-status', (_req, res) => {
  const needAuth = keyManager.hasAnyKeys();

  // 如果带了有效 token，告诉前端已登录
  const authHeader = _req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : _req.query.token;
  let authenticated = false;
  if (token) {
    cleanExpiredSessions();
    const expiresAt = sessions.get(token);
    authenticated = !!(expiresAt && expiresAt > Date.now());
  }

  res.json({ needAuth, authenticated });
});

// 登录：用任意一个已存在的 key 登录
app.post('/admin/login', (req, res) => {
  const { key } = req.body;

  // 没有 key 时直接放行
  if (!keyManager.hasAnyKeys()) {
    const token = generateToken();
    sessions.set(token, Date.now() + SESSION_TTL);
    return res.json({ ok: true, token });
  }

  if (!key || typeof key !== 'string') {
    return res.status(400).json({ error: '请输入 Key' });
  }

  if (!keyManager.hasKey(key.trim())) {
    return res.status(403).json({ error: 'Key 不存在，无法登录' });
  }

  const token = generateToken();
  sessions.set(token, Date.now() + SESSION_TTL);
  console.log(`[鉴权] 登录成功 (key: ${key.slice(0, 12)}...)`);
  res.json({ ok: true, token });
});

// 登出
app.post('/admin/logout', (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

// ============================================================
// 管理接口（需要 adminAuth）
// ============================================================

// 获取配置
app.get('/admin/config', adminAuth, (_req, res) => {
  res.json({ upstreamBaseUrl: keyManager.getUpstreamUrl() });
});

// 更新上游地址
app.post('/admin/config', adminAuth, (req, res) => {
  const { upstreamBaseUrl: url } = req.body;
  if (url && typeof url === 'string') {
    keyManager.setUpstreamUrl(url.trim());
    console.log(`[配置] 上游地址更新为: ${keyManager.getUpstreamUrl()}`);
    res.json({ ok: true, upstreamBaseUrl: keyManager.getUpstreamUrl() });
  } else {
    res.status(400).json({ error: '缺少 upstreamBaseUrl' });
  }
});

// 列出所有 key
app.get('/admin/keys', adminAuth, (_req, res) => {
  res.json({ keys: keyManager.listKeys(), stats: keyManager.stats() });
});

// 批量添加 key
app.post('/admin/keys', adminAuth, (req, res) => {
  const { keys } = req.body;
  if (!Array.isArray(keys)) {
    return res.status(400).json({ error: 'keys 必须是数组' });
  }
  const added = keyManager.addKeys(keys);
  console.log(`[Key] 批量添加 ${added.length} 个 key`);
  res.json({ added: added.length, stats: keyManager.stats() });
});

// 批量删除 key
app.delete('/admin/keys', adminAuth, (req, res) => {
  const { keys } = req.body;
  if (!Array.isArray(keys)) {
    return res.status(400).json({ error: 'keys 必须是数组' });
  }
  const removed = keyManager.removeKeys(keys);
  console.log(`[Key] 批量删除 ${removed} 个 key`);
  res.json({ removed, stats: keyManager.stats() });
});

// 启用 key
app.post('/admin/keys/enable', adminAuth, (req, res) => {
  const { key } = req.body;
  const ok = keyManager.enableKey(key);
  console.log(`[Key] 启用 key: ${key?.slice(0, 12)}... => ${ok}`);
  res.json({ ok, stats: keyManager.stats() });
});

// 禁用 key
app.post('/admin/keys/disable', adminAuth, (req, res) => {
  const { key, reason } = req.body;
  const ok = keyManager.disableKey(key, reason || '手动禁用');
  console.log(`[Key] 禁用 key: ${key?.slice(0, 12)}... => ${ok}`);
  res.json({ ok, stats: keyManager.stats() });
});

// ============================================================
// 代理核心：Anthropic /v1/messages → blink.new OpenAI Chat
// （不鉴权，始终轮询所有 key）
// ============================================================

app.post('/v1/messages', async (req, res) => {
  const apiKey = keyManager.getNextKey();
  if (!apiKey) {
    return res.status(503).json({
      type: 'error',
      error: { type: 'overloaded_error', message: '没有可用的 API Key' },
    });
  }

  const anthropicBody = req.body;
  const isStream = anthropicBody.stream === true;

  // 本地估算 input_tokens（用于 message_start）
  const estimatedInputTokens = estimateRequestTokens(anthropicBody);

  // 转换请求体
  let openaiBody;
  try {
    openaiBody = anthropicToOpenAI(anthropicBody);
  } catch (err) {
    console.error('[转换] 请求转换失败:', err.message);
    return res.status(400).json({
      type: 'error',
      error: { type: 'invalid_request_error', message: err.message },
    });
  }

  const upstreamBaseUrl = keyManager.getUpstreamUrl();
  console.log(`[代理] ${isStream ? 'SSE' : '普通'} 请求 → ${upstreamBaseUrl} (key: ${apiKey.slice(0, 12)}...)`);

  try {
    const parsed = new URL(upstreamBaseUrl);
    const transport = parsed.protocol === 'https:' ? https : http;

    const bodyStr = JSON.stringify(openaiBody);

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'Authorization': `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
      },
    };

    const proxyReq = transport.request(options, (proxyRes) => {
      const statusCode = proxyRes.statusCode;

      if (statusCode >= 400) {
        let errorBody = '';
        proxyRes.on('data', (chunk) => { errorBody += chunk.toString(); });
        proxyRes.on('end', () => {
          console.error(`[代理] 上游返回 ${statusCode}: ${errorBody.slice(0, 500)}`);

          if (errorBody.toLowerCase().includes('insufficient')) {
            keyManager.disableKey(apiKey, `上游返回 insufficient (HTTP ${statusCode})`);
            console.warn(`[Key] 自动禁用: ${apiKey.slice(0, 12)}... (insufficient)`);
          }

          res.status(statusCode).json({
            type: 'error',
            error: {
              type: statusCode === 429 ? 'rate_limit_error' : 'api_error',
              message: errorBody.slice(0, 1000),
            },
          });
        });
        return;
      }

      if (isStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        const transform = new OpenAIToAnthropicSSETransform({
          estimatedInputTokens,
          onError: (keyword) => {
            console.warn(`[Key] 流中检测到错误关键词 "${keyword}"，自动禁用: ${apiKey.slice(0, 12)}...`);
            keyManager.disableKey(apiKey, `流中检测到 "${keyword}"`);
          },
        });

        proxyRes.pipe(transform).pipe(res);

        proxyRes.on('error', (err) => {
          console.error('[代理] 上游流错误:', err.message);
          res.end();
        });
      } else {
        let body = '';
        proxyRes.on('data', (chunk) => { body += chunk.toString(); });
        proxyRes.on('end', () => {
          try {
            const openaiResponse = JSON.parse(body);

            if (body.toLowerCase().includes('insufficient')) {
              keyManager.disableKey(apiKey, '响应包含 insufficient');
              console.warn(`[Key] 自动禁用: ${apiKey.slice(0, 12)}... (insufficient in response)`);
            }

            const anthropicResponse = openaiToAnthropic(openaiResponse);
            // 如果上游没返回 input_tokens，用本地估算值填充
            if (anthropicResponse.usage && !anthropicResponse.usage.input_tokens) {
              anthropicResponse.usage.input_tokens = estimatedInputTokens;
            }
            res.json(anthropicResponse);
          } catch (err) {
            console.error('[转换] 响应转换失败:', err.message);
            res.status(502).json({
              type: 'error',
              error: { type: 'api_error', message: '上游响应解析失败' },
            });
          }
        });
      }
    });

    proxyReq.on('error', (err) => {
      console.error('[代理] 请求失败:', err.message);
      res.status(502).json({
        type: 'error',
        error: { type: 'api_error', message: `上游连接失败: ${err.message}` },
      });
    });

    proxyReq.write(bodyStr);
    proxyReq.end();
  } catch (err) {
    console.error('[代理] 未知错误:', err.message);
    res.status(500).json({
      type: 'error',
      error: { type: 'api_error', message: err.message },
    });
  }
});

// ============================================================
// 启动
// ============================================================

const PORT = process.env.PORT || 3456;
app.listen(PORT, () => {
  console.log(`[cc2cc] 代理服务启动在 http://localhost:${PORT}`);
  console.log(`[cc2cc] 管理页面: http://localhost:${PORT}/`);
  console.log(`[cc2cc] Anthropic 代理: http://localhost:${PORT}/v1/messages`);
  console.log(`[cc2cc] 上游地址: ${keyManager.getUpstreamUrl()}`);
});
