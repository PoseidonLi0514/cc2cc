// Token 估算模块
// 基于字符分类的状态机估算器，参考 one-api token_estimator.go
// 用于 Claude 模型的 input_tokens 本地估算

// Claude 字符权重表
const WEIGHT = {
  WORD: 1.13,         // 英文单词（每个新单词计一次）
  NUMBER: 1.63,       // 数字串（每个新序列计一次）
  CJK: 1.21,          // 中日韩字符（每字符独立计）
  PUNCT: 0.4,         // 普通标点
  MATH: 4.52,         // 数学符号 ∑∫∂√ 等
  URL_SEP: 1.26,      // URL 分隔符 / : ? & =
  AT: 2.82,           // @ 符号
  EMOJI: 2.6,         // Emoji
  NEWLINE: 0.89,      // 换行/制表
  SPACE: 0.39,        // 空格
};

// 字符分类
const CHAR_NONE = 0;
const CHAR_LETTER = 1;
const CHAR_DIGIT = 2;

function isCJK(code) {
  return (
    (code >= 0x4E00 && code <= 0x9FFF) ||   // CJK 统一汉字
    (code >= 0x3400 && code <= 0x4DBF) ||   // CJK 扩展 A
    (code >= 0x20000 && code <= 0x2A6DF) || // CJK 扩展 B
    (code >= 0x2A700 && code <= 0x2B73F) || // CJK 扩展 C
    (code >= 0x2B740 && code <= 0x2B81F) || // CJK 扩展 D
    (code >= 0xF900 && code <= 0xFAFF) ||   // CJK 兼容汉字
    (code >= 0x3000 && code <= 0x303F) ||   // CJK 标点
    (code >= 0x3040 && code <= 0x309F) ||   // 日文平假名
    (code >= 0x30A0 && code <= 0x30FF) ||   // 日文片假名
    (code >= 0xAC00 && code <= 0xD7AF)      // 韩文音节
  );
}

function isMathSymbol(code) {
  return (
    (code >= 0x2200 && code <= 0x22FF) || // 数学运算符
    (code >= 0x2100 && code <= 0x214F) || // 字母式符号
    (code >= 0x2190 && code <= 0x21FF) || // 箭头
    (code >= 0x2300 && code <= 0x23FF) || // 杂项技术符号
    (code >= 0x27C0 && code <= 0x27EF) || // 杂项数学符号 A
    (code >= 0x2980 && code <= 0x29FF) || // 杂项数学符号 B
    (code >= 0x2A00 && code <= 0x2AFF)    // 补充数学运算符
  );
}

function isEmoji(code) {
  return (
    (code >= 0x1F600 && code <= 0x1F64F) || // 表情
    (code >= 0x1F300 && code <= 0x1F5FF) || // 符号和象形文字
    (code >= 0x1F680 && code <= 0x1F6FF) || // 交通和地图
    (code >= 0x1F700 && code <= 0x1F77F) || // 炼金术符号
    (code >= 0x1F900 && code <= 0x1F9FF) || // 补充表情
    (code >= 0x1FA00 && code <= 0x1FA6F) || // 象棋符号
    (code >= 0x1FA70 && code <= 0x1FAFF) || // 扩展 A
    (code >= 0x2600 && code <= 0x26FF) ||   // 杂项符号
    (code >= 0x2700 && code <= 0x27BF) ||   // 装饰符号
    (code >= 0xFE00 && code <= 0xFE0F) ||   // 变体选择符
    code === 0x200D                          // ZWJ
  );
}

const URL_SEPARATORS = new Set(['/', ':', '?', '&', '=', '#', '%', '+']);

// 核心估算器：逐字符遍历文本，按字符类型乘权重累加
function estimateTextTokens(text) {
  if (!text) return 0;

  let tokens = 0;
  let prevType = CHAR_NONE;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.codePointAt(i);

    // 跳过代理对的第二个 code unit
    if (code > 0xFFFF) {
      i++;
    }

    // 空格
    if (ch === ' ') {
      tokens += WEIGHT.SPACE;
      prevType = CHAR_NONE;
      continue;
    }

    // 换行/制表
    if (ch === '\n' || ch === '\r' || ch === '\t') {
      tokens += WEIGHT.NEWLINE;
      prevType = CHAR_NONE;
      continue;
    }

    // CJK
    if (isCJK(code)) {
      tokens += WEIGHT.CJK;
      prevType = CHAR_NONE;
      continue;
    }

    // Emoji
    if (isEmoji(code)) {
      tokens += WEIGHT.EMOJI;
      prevType = CHAR_NONE;
      continue;
    }

    // 数学符号
    if (isMathSymbol(code)) {
      tokens += WEIGHT.MATH;
      prevType = CHAR_NONE;
      continue;
    }

    // @ 符号
    if (ch === '@') {
      tokens += WEIGHT.AT;
      prevType = CHAR_NONE;
      continue;
    }

    // URL 分隔符
    if (URL_SEPARATORS.has(ch)) {
      tokens += WEIGHT.URL_SEP;
      prevType = CHAR_NONE;
      continue;
    }

    // 英文字母
    if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) {
      if (prevType !== CHAR_LETTER) {
        // 新单词开始
        tokens += WEIGHT.WORD;
      }
      // 单词内部连续字母不额外计费
      prevType = CHAR_LETTER;
      continue;
    }

    // 数字
    if (code >= 0x30 && code <= 0x39) {
      if (prevType !== CHAR_DIGIT) {
        // 新数字序列开始
        tokens += WEIGHT.NUMBER;
      }
      prevType = CHAR_DIGIT;
      continue;
    }

    // 其他标点/符号
    tokens += WEIGHT.PUNCT;
    prevType = CHAR_NONE;
  }

  return Math.ceil(tokens);
}

// 从 Anthropic 请求体中提取所有文本并合并
function combineRequestText(body) {
  const parts = [];

  // system prompt
  if (body.system) {
    if (typeof body.system === 'string') {
      parts.push(body.system);
    } else if (Array.isArray(body.system)) {
      for (const msg of body.system) {
        if (msg.text) parts.push(msg.text);
      }
    }
  }

  // messages
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (typeof msg.content === 'string') {
        parts.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            parts.push(block.text);
          } else if (block.type === 'tool_result') {
            if (typeof block.content === 'string') {
              parts.push(block.content);
            } else if (block.content) {
              parts.push(JSON.stringify(block.content));
            }
          } else if (block.type === 'tool_use' && block.input) {
            parts.push(JSON.stringify(block.input));
          }
        }
      }
    }
  }

  return parts.join('\n');
}

// 统计媒体文件 token（图片/音频/视频/文件）
function estimateMediaTokens(body) {
  let tokens = 0;

  if (!Array.isArray(body.messages)) return 0;

  for (const msg of body.messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'image') {
        tokens += 520; // Claude 模型固定值
      } else if (block.type === 'audio') {
        tokens += 256;
      } else if (block.type === 'video') {
        tokens += 4096 * 2;
      } else if (block.type === 'file' || block.type === 'document') {
        tokens += 4096;
      }
    }
  }

  return tokens;
}

// 统计 OpenAI 格式额外开销
function estimateFormatOverhead(body) {
  let overhead = 3; // 固定基础开销

  // 每条消息的格式化开销
  const messagesCount = Array.isArray(body.messages) ? body.messages.length : 0;
  overhead += messagesCount * 3;

  // system 也算消息
  if (body.system) {
    if (typeof body.system === 'string') {
      overhead += 3;
    } else if (Array.isArray(body.system)) {
      overhead += body.system.length * 3;
    }
  }

  // 每个 tool 定义约 8 token
  if (Array.isArray(body.tools)) {
    overhead += body.tools.length * 8;

    // tool 的 schema 文本也需要估算
    for (const tool of body.tools) {
      if (tool.name) overhead += estimateTextTokens(tool.name);
      if (tool.description) overhead += estimateTextTokens(tool.description);
      if (tool.input_schema) {
        overhead += estimateTextTokens(JSON.stringify(tool.input_schema));
      }
    }
  }

  // 带 name 字段的消息额外开销
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg.name) overhead += 3;
    }
  }

  return overhead;
}

// 完整的请求 token 估算入口
function estimateRequestTokens(body) {
  const text = combineRequestText(body);
  const textTokens = estimateTextTokens(text);
  const mediaTokens = estimateMediaTokens(body);
  const formatOverhead = estimateFormatOverhead(body);

  return textTokens + mediaTokens + formatOverhead;
}

module.exports = {
  estimateTextTokens,
  estimateRequestTokens,
  combineRequestText,
};
