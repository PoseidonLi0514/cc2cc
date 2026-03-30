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

// 管理面板密码（环境变量优先，否则从 data.json 读取）
const ENV_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

function getAdminPassword() {
  return ENV_ADMIN_PASSWORD || keyManager.getAdminPassword();
}

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
//   - 没有任何 key 且没设密码 → 无需鉴权，直接放行
//   - 有 key 或有密码 → 需要登录
//   - /v1/messages（代理接口）不鉴权
//   - /admin/auth-status 和 /admin/login 不鉴权
// ============================================================

function needsAuth() {
  return keyManager.hasAnyKeys() || !!getAdminPassword();
}

function adminAuth(req, res, next) {
  if (!needsAuth()) {
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
  const need = needsAuth();

  // 如果带了有效 token，告诉前端已登录
  const authHeader = _req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : _req.query.token;
  let authenticated = false;
  if (token) {
    cleanExpiredSessions();
    const expiresAt = sessions.get(token);
    authenticated = !!(expiresAt && expiresAt > Date.now());
  }

  res.json({ needAuth: need, authenticated });
});

// 登录：用密码或任意一个已存在的 key 登录
app.post('/admin/login', (req, res) => {
  const { key, password } = req.body;

  // 没有 key 也没设密码 → 直接放行
  if (!needsAuth()) {
    const token = generateToken();
    sessions.set(token, Date.now() + SESSION_TTL);
    return res.json({ ok: true, token });
  }

  // 密码登录
  if (password && typeof password === 'string' && getAdminPassword()) {
    if (password === getAdminPassword()) {
      const token = generateToken();
      sessions.set(token, Date.now() + SESSION_TTL);
      console.log('[鉴权] 密码登录成功');
      return res.json({ ok: true, token });
    }
  }

  // Key 登录
  if (key && typeof key === 'string') {
    if (keyManager.hasKey(key.trim())) {
      const token = generateToken();
      sessions.set(token, Date.now() + SESSION_TTL);
      console.log(`[鉴权] Key 登录成功 (key: ${key.slice(0, 12)}...)`);
      return res.json({ ok: true, token });
    }
  }

  // 密码登录失败
  if (password && getAdminPassword()) {
    return res.status(403).json({ error: '密码错误' });
  }

  if (!key && !password) {
    return res.status(400).json({ error: '请输入密码或 Key' });
  }

  return res.status(403).json({ error: 'Key 不存在，无法登录' });
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
  res.json({
    upstreamBaseUrl: keyManager.getUpstreamUrl(),
    hasPassword: !!getAdminPassword(),
  });
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

// 设置管理密码
app.post('/admin/password', adminAuth, (req, res) => {
  const { password } = req.body;
  if (typeof password !== 'string') {
    return res.status(400).json({ error: '密码格式错误' });
  }
  keyManager.setAdminPassword(password);
  console.log(`[配置] 管理密码已${password ? '设置' : '清除'}`);
  res.json({ ok: true, hasPassword: !!password });
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
// 402/insufficient 自动换 key 重试，对用户透明
// ============================================================

const MAX_RETRIES = 3;

// 发送一次上游请求，返回 Promise
// resolve({ statusCode, headers, body }) 或 reject(err)
function sendUpstreamRequest(apiKey, bodyStr, upstreamBaseUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(upstreamBaseUrl);
    const transport = parsed.protocol === 'https:' ? https : http;

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
          resolve({ statusCode, errorBody, isError: true });
        });
        return;
      }

      // 成功，返回 proxyRes 流供调用方处理
      resolve({ statusCode, proxyRes, isError: false });
    });

    proxyReq.on('error', reject);
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// 判断是否应该自动重试的错误
function isRetryableError(statusCode, errorBody) {
  if (statusCode === 402) return true;
  if (errorBody && errorBody.toLowerCase().includes('insufficient')) return true;
  return false;
}

app.post('/v1/messages', async (req, res) => {
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

  const bodyStr = JSON.stringify(openaiBody);
  const upstreamBaseUrl = keyManager.getUpstreamUrl();
  const triedKeys = new Set();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const apiKey = keyManager.getNextKey();
    if (!apiKey) {
      return res.status(503).json({
        type: 'error',
        error: { type: 'overloaded_error', message: '没有可用的 API Key' },
      });
    }

    // 避免同一个 key 重试多次
    if (triedKeys.has(apiKey)) {
      // 所有 key 都试过了
      return res.status(503).json({
        type: 'error',
        error: { type: 'overloaded_error', message: '所有可用 Key 均额度不足' },
      });
    }
    triedKeys.add(apiKey);

    console.log(`[代理] ${isStream ? 'SSE' : '普通'} 请求 → ${upstreamBaseUrl} (key: ${apiKey.slice(0, 12)}... 第${attempt + 1}次)`);

    try {
      const result = await sendUpstreamRequest(apiKey, bodyStr, upstreamBaseUrl);

      if (result.isError) {
        const { statusCode, errorBody } = result;
        console.error(`[代理] 上游返回 ${statusCode}: ${errorBody.slice(0, 500)}`);

        // 可重试的错误：禁用 key，换一个继续
        if (isRetryableError(statusCode, errorBody)) {
          keyManager.disableKey(apiKey, `上游返回 HTTP ${statusCode} (insufficient)`);
          console.warn(`[Key] 自动禁用: ${apiKey.slice(0, 12)}... → 换 key 重试`);
          continue;
        }

        // 不可重试的错误直接返回
        if (errorBody.toLowerCase().includes('insufficient')) {
          keyManager.disableKey(apiKey, `上游返回 insufficient (HTTP ${statusCode})`);
        }

        return res.status(statusCode).json({
          type: 'error',
          error: {
            type: statusCode === 429 ? 'rate_limit_error' : 'api_error',
            message: errorBody.slice(0, 1000),
          },
        });
      }

      // 成功响应
      const { proxyRes } = result;

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

      return; // 成功处理，退出重试循环

    } catch (err) {
      console.error('[代理] 请求失败:', err.message);
      // 网络错误不重试，直接返回
      return res.status(502).json({
        type: 'error',
        error: { type: 'api_error', message: `上游连接失败: ${err.message}` },
      });
    }
  }

  // 所有重试都用完了
  res.status(503).json({
    type: 'error',
    error: { type: 'overloaded_error', message: '所有可用 Key 均额度不足' },
  });
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
