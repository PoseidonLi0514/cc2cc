// 请求/响应格式转换模块
// Anthropic Messages API ↔ blink.new OpenAI Chat 格式

// ============================================================
// 请求转换：Anthropic → blink.new OpenAI Chat
// ============================================================

function anthropicToOpenAI(body) {
  const result = {};

  // 模型直接透传（上游本身就是 claude 模型，用 anthropic/ 前缀）
  if (body.model) {
    result.model = body.model;
  }

  const messages = [];

  // system prompt → system role message
  if (body.system) {
    if (typeof body.system === 'string') {
      messages.push({ role: 'system', content: body.system });
    } else if (Array.isArray(body.system)) {
      for (const msg of body.system) {
        if (msg.text) {
          messages.push({ role: 'system', content: msg.text });
        }
      }
    }
  }

  // 转换 messages
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const role = msg.role || 'user';
      const converted = convertMessageToOpenAI(role, msg.content);
      messages.push(...converted);
    }
  }

  result.messages = messages;

  // max_tokens
  if (body.max_tokens !== undefined) {
    result.max_tokens = body.max_tokens;
  }

  // 直接透传的参数
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stop_sequences !== undefined) result.stop = body.stop_sequences;
  if (body.stream !== undefined) result.stream = body.stream;

  // thinking → reasoning + verbosity（blink.new 特有格式）
  const thinkingConfig = resolveThinkingConfig(body);
  if (thinkingConfig) {
    result.reasoning = thinkingConfig.reasoning;
    if (thinkingConfig.verbosity) {
      result.verbosity = thinkingConfig.verbosity;
    }
  }

  // 转换 tools
  if (Array.isArray(body.tools)) {
    const openaiTools = body.tools
      .filter(t => t.type !== 'BatchTool')
      .map(t => ({
        type: 'function',
        function: {
          name: t.name || '',
          description: t.description || undefined,
          parameters: cleanSchema(t.input_schema || {}),
        },
      }));

    if (openaiTools.length > 0) {
      result.tools = openaiTools;
    }
  }

  if (body.tool_choice !== undefined) {
    result.tool_choice = body.tool_choice;
  }

  return result;
}

// 解析 thinking 配置 → blink.new 的 reasoning + verbosity
function resolveThinkingConfig(body) {
  const thinking = body.thinking;
  const outputConfig = body.output_config;

  // 判断是否需要启用 reasoning
  let enabled = false;
  let verbosity = null;

  if (thinking) {
    const type = thinking.type;
    if (type === 'enabled' || type === 'adaptive') {
      enabled = true;
    }
  }

  // output_config.effort → verbosity 映射
  if (outputConfig && outputConfig.effort) {
    enabled = true;
    switch (outputConfig.effort) {
      case 'low': verbosity = 'low'; break;
      case 'medium': verbosity = 'medium'; break;
      case 'high': verbosity = 'high'; break;
      case 'max': verbosity = 'max'; break;
    }
  } else if (thinking) {
    // 根据 thinking 配置推断 verbosity
    const type = thinking.type;
    if (type === 'adaptive') {
      verbosity = 'max';
    } else if (type === 'enabled') {
      const budget = thinking.budget_tokens;
      if (budget !== undefined) {
        if (budget < 4000) verbosity = 'low';
        else if (budget < 16000) verbosity = 'medium';
        else verbosity = 'high';
      } else {
        verbosity = 'high';
      }
    }
  }

  if (!enabled) return null;

  return {
    reasoning: { enabled: true },
    verbosity,
  };
}

// 转换单条消息到 OpenAI 格式
function convertMessageToOpenAI(role, content) {
  const result = [];

  if (content === undefined || content === null) {
    result.push({ role, content: null });
    return result;
  }

  // 字符串内容
  if (typeof content === 'string') {
    result.push({ role, content });
    return result;
  }

  // 数组内容（多模态/工具调用）
  if (Array.isArray(content)) {
    const contentParts = [];
    const toolCalls = [];

    for (const block of content) {
      const blockType = block.type || '';

      switch (blockType) {
        case 'text':
          if (block.text) {
            contentParts.push({ type: 'text', text: block.text });
          }
          break;

        case 'image':
          if (block.source) {
            const mediaType = block.source.media_type || 'image/png';
            const data = block.source.data || '';
            contentParts.push({
              type: 'image_url',
              image_url: { url: `data:${mediaType};base64,${data}` },
            });
          }
          break;

        case 'tool_use':
          toolCalls.push({
            id: block.id || '',
            type: 'function',
            function: {
              name: block.name || '',
              arguments: JSON.stringify(block.input || {}),
            },
          });
          break;

        case 'tool_result': {
          const toolUseId = block.tool_use_id || '';
          let contentStr;
          if (typeof block.content === 'string') {
            contentStr = block.content;
          } else if (block.content !== undefined) {
            contentStr = JSON.stringify(block.content);
          } else {
            contentStr = '';
          }
          result.push({
            role: 'tool',
            tool_call_id: toolUseId,
            content: contentStr,
          });
          break;
        }

        case 'thinking':
          // 跳过 thinking blocks
          break;

        default:
          break;
      }
    }

    // 添加带内容和/或工具调用的消息
    if (contentParts.length > 0 || toolCalls.length > 0) {
      const msg = { role };

      if (contentParts.length === 0) {
        msg.content = null;
      } else if (contentParts.length === 1 && contentParts[0].type === 'text') {
        msg.content = contentParts[0].text;
      } else {
        msg.content = contentParts;
      }

      if (toolCalls.length > 0) {
        msg.tool_calls = toolCalls;
      }

      result.push(msg);
    }

    return result;
  }

  // 其他情况直接透传
  result.push({ role, content });
  return result;
}

// 清理 JSON schema（移除不支持的 format）
function cleanSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const result = { ...schema };

  if (result.format === 'uri') {
    delete result.format;
  }

  if (result.properties && typeof result.properties === 'object') {
    const cleaned = {};
    for (const [key, value] of Object.entries(result.properties)) {
      cleaned[key] = cleanSchema(value);
    }
    result.properties = cleaned;
  }

  if (result.items) {
    result.items = cleanSchema(result.items);
  }

  return result;
}

// ============================================================
// 非流式响应转换：OpenAI Chat → Anthropic
// ============================================================

function openaiToAnthropic(body) {
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('No choices in response');
  }

  const choice = choices[0];
  const message = choice.message;
  if (!message) {
    throw new Error('No message in choice');
  }

  const content = [];
  let hasToolUse = false;

  // 文本内容
  if (message.content) {
    if (typeof message.content === 'string') {
      if (message.content) {
        content.push({ type: 'text', text: message.content });
      }
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'text' || part.type === 'output_text') {
          if (part.text) content.push({ type: 'text', text: part.text });
        } else if (part.type === 'refusal') {
          if (part.refusal) content.push({ type: 'text', text: part.refusal });
        }
      }
    }
  }

  // refusal（消息级别）
  if (message.refusal && typeof message.refusal === 'string') {
    content.push({ type: 'text', text: message.refusal });
  }

  // 工具调用
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    hasToolUse = true;
    for (const tc of message.tool_calls) {
      const func = tc.function || {};
      let input;
      try {
        input = JSON.parse(func.arguments || '{}');
      } catch {
        input = {};
      }
      content.push({
        type: 'tool_use',
        id: tc.id || '',
        name: func.name || '',
        input,
      });
    }
  }

  // finish_reason → stop_reason
  const stopReason = mapStopReason(choice.finish_reason, hasToolUse);

  // usage
  const usage = body.usage || {};
  const inputTokens = usage.prompt_tokens || 0;
  const outputTokens = usage.completion_tokens || 0;
  const usageJson = { input_tokens: inputTokens, output_tokens: outputTokens };

  if (usage.prompt_tokens_details?.cached_tokens) {
    usageJson.cache_read_input_tokens = usage.prompt_tokens_details.cached_tokens;
  }
  if (usage.cache_read_input_tokens !== undefined) {
    usageJson.cache_read_input_tokens = usage.cache_read_input_tokens;
  }
  if (usage.cache_creation_input_tokens !== undefined) {
    usageJson.cache_creation_input_tokens = usage.cache_creation_input_tokens;
  }

  return {
    id: body.id || '',
    type: 'message',
    role: 'assistant',
    content,
    model: body.model || '',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: usageJson,
  };
}

function mapStopReason(finishReason, hasToolUse) {
  if (!finishReason) return hasToolUse ? 'tool_use' : null;
  switch (finishReason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls':
    case 'function_call': return 'tool_use';
    case 'content_filter': return 'end_turn';
    default: return 'end_turn';
  }
}

module.exports = {
  anthropicToOpenAI,
  openaiToAnthropic,
  resolveThinkingConfig,
  mapStopReason,
};
