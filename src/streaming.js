// 流式响应转换模块
// OpenAI SSE → Anthropic SSE 格式转换
// 参考 cc-switch/src-tauri/src/proxy/providers/streaming.rs

const { Transform } = require('stream');

// 错误关键词列表，命中则标记 key 为不可用
const ERROR_KEYWORDS = ['insufficient'];

class OpenAIToAnthropicSSETransform extends Transform {
  constructor(options = {}) {
    super({ ...options, readableObjectMode: false, writableObjectMode: false });
    this.buffer = '';
    this.messageId = null;
    this.currentModel = null;
    this.nextContentIndex = 0;
    this.hasSentMessageStart = false;
    this.currentNonToolBlockType = null;   // 'text' | 'thinking' | null
    this.currentNonToolBlockIndex = null;
    this.toolBlocksByIndex = new Map();     // openai index → ToolBlockState
    this.openToolBlockIndices = new Set();

    // 错误检测回调
    this.onError = options.onError || null;
    this.detectedError = false;
    this.fullResponseForErrorCheck = '';

    // 本地估算的 input_tokens（由调用方传入）
    this.estimatedInputTokens = options.estimatedInputTokens || 0;
  }

  _transform(chunk, encoding, callback) {
    const text = chunk.toString();
    this.buffer += text;
    this.fullResponseForErrorCheck += text;

    // 检测错误关键词
    if (!this.detectedError) {
      for (const keyword of ERROR_KEYWORDS) {
        if (this.fullResponseForErrorCheck.toLowerCase().includes(keyword)) {
          this.detectedError = true;
          if (this.onError) {
            this.onError(keyword, this.fullResponseForErrorCheck);
          }
          break;
        }
      }
    }

    while (true) {
      const pos = this.buffer.indexOf('\n\n');
      if (pos === -1) break;

      const line = this.buffer.slice(0, pos);
      this.buffer = this.buffer.slice(pos + 2);

      if (!line.trim()) continue;

      for (const l of line.split('\n')) {
        const data = stripSSEField(l, 'data');
        if (data === null) continue;

        if (data.trim() === '[DONE]') {
          // 发送 message_stop
          this._emitSSE('message_stop', { type: 'message_stop' });
          continue;
        }

        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }

        this._processChunk(chunk);
      }
    }

    callback();
  }

  _flush(callback) {
    // 处理缓冲区中残留的数据
    if (this.buffer.trim()) {
      for (const l of this.buffer.split('\n')) {
        const data = stripSSEField(l, 'data');
        if (data === null) continue;
        if (data.trim() === '[DONE]') {
          this._emitSSE('message_stop', { type: 'message_stop' });
          continue;
        }
        try {
          const chunk = JSON.parse(data);
          this._processChunk(chunk);
        } catch {}
      }
    }
    callback();
  }

  _processChunk(chunk) {
    if (!this.messageId) this.messageId = chunk.id;
    if (!this.currentModel) this.currentModel = chunk.model;

    const choice = chunk.choices?.[0];
    if (!choice) return;

    if (!this.hasSentMessageStart) {
      const startUsage = {
        input_tokens: this.estimatedInputTokens,
        output_tokens: 0,
      };
      if (chunk.usage) {
        // 上游有返回就用上游的，否则用估算值
        if (chunk.usage.prompt_tokens) {
          startUsage.input_tokens = chunk.usage.prompt_tokens;
        }
        const cached = extractCacheReadTokens(chunk.usage);
        if (cached !== null) startUsage.cache_read_input_tokens = cached;
        if (chunk.usage.cache_creation_input_tokens !== undefined) {
          startUsage.cache_creation_input_tokens = chunk.usage.cache_creation_input_tokens;
        }
      }

      this._emitSSE('message_start', {
        type: 'message_start',
        message: {
          id: this.messageId || '',
          type: 'message',
          role: 'assistant',
          model: this.currentModel || '',
          usage: startUsage,
        },
      });
      this.hasSentMessageStart = true;
    }

    const delta = choice.delta || {};

    // 处理 reasoning（thinking）
    if (delta.reasoning) {
      if (this.currentNonToolBlockType !== 'thinking') {
        this._closeCurrentNonToolBlock();
        const index = this.nextContentIndex++;
        this._emitSSE('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'thinking', thinking: '' },
        });
        this.currentNonToolBlockType = 'thinking';
        this.currentNonToolBlockIndex = index;
      }

      if (this.currentNonToolBlockIndex !== null) {
        this._emitSSE('content_block_delta', {
          type: 'content_block_delta',
          index: this.currentNonToolBlockIndex,
          delta: { type: 'thinking_delta', thinking: delta.reasoning },
        });
      }
    }

    // 处理文本内容
    if (delta.content && delta.content.length > 0) {
      if (this.currentNonToolBlockType !== 'text') {
        this._closeCurrentNonToolBlock();
        const index = this.nextContentIndex++;
        this._emitSSE('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' },
        });
        this.currentNonToolBlockType = 'text';
        this.currentNonToolBlockIndex = index;
      }

      if (this.currentNonToolBlockIndex !== null) {
        this._emitSSE('content_block_delta', {
          type: 'content_block_delta',
          index: this.currentNonToolBlockIndex,
          delta: { type: 'text_delta', text: delta.content },
        });
      }
    }

    // 处理工具调用
    if (Array.isArray(delta.tool_calls)) {
      this._closeCurrentNonToolBlock();
      this.currentNonToolBlockType = null;

      for (const toolCall of delta.tool_calls) {
        let state = this.toolBlocksByIndex.get(toolCall.index);
        if (!state) {
          state = {
            anthropicIndex: this.nextContentIndex++,
            id: '',
            name: '',
            started: false,
            pendingArgs: '',
          };
          this.toolBlocksByIndex.set(toolCall.index, state);
        }

        if (toolCall.id) state.id = toolCall.id;
        if (toolCall.function?.name) state.name = toolCall.function.name;

        const shouldStart = !state.started && state.id && state.name;
        if (shouldStart) {
          state.started = true;

          this._emitSSE('content_block_start', {
            type: 'content_block_start',
            index: state.anthropicIndex,
            content_block: { type: 'tool_use', id: state.id, name: state.name },
          });
          this.openToolBlockIndices.add(state.anthropicIndex);

          // 刷新已缓冲的 args
          if (state.pendingArgs) {
            this._emitSSE('content_block_delta', {
              type: 'content_block_delta',
              index: state.anthropicIndex,
              delta: { type: 'input_json_delta', partial_json: state.pendingArgs },
            });
            state.pendingArgs = '';
          }
        }

        if (toolCall.function?.arguments) {
          if (state.started) {
            this._emitSSE('content_block_delta', {
              type: 'content_block_delta',
              index: state.anthropicIndex,
              delta: { type: 'input_json_delta', partial_json: toolCall.function.arguments },
            });
          } else {
            state.pendingArgs += toolCall.function.arguments;
          }
        }
      }
    }

    // 处理 finish_reason
    if (choice.finish_reason) {
      this._closeCurrentNonToolBlock();
      this.currentNonToolBlockType = null;

      // 延迟启动未完成的工具块
      for (const [, state] of this.toolBlocksByIndex) {
        if (state.started) continue;
        if (!state.pendingArgs && !state.id && !state.name) continue;

        state.started = true;
        const fallbackId = state.id || `tool_call_${state.anthropicIndex}`;
        const fallbackName = state.name || 'unknown_tool';

        this._emitSSE('content_block_start', {
          type: 'content_block_start',
          index: state.anthropicIndex,
          content_block: { type: 'tool_use', id: fallbackId, name: fallbackName },
        });
        this.openToolBlockIndices.add(state.anthropicIndex);

        if (state.pendingArgs) {
          this._emitSSE('content_block_delta', {
            type: 'content_block_delta',
            index: state.anthropicIndex,
            delta: { type: 'input_json_delta', partial_json: state.pendingArgs },
          });
        }
      }

      // 关闭所有打开的工具块
      const sortedIndices = [...this.openToolBlockIndices].sort((a, b) => a - b);
      for (const index of sortedIndices) {
        this._emitSSE('content_block_stop', { type: 'content_block_stop', index });
      }
      this.openToolBlockIndices.clear();

      // message_delta
      const stopReason = mapStreamStopReason(choice.finish_reason);
      const usageJson = chunk.usage ? buildStreamUsage(chunk.usage) : undefined;

      this._emitSSE('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: usageJson || undefined,
      });
    }
  }

  _closeCurrentNonToolBlock() {
    if (this.currentNonToolBlockIndex !== null) {
      this._emitSSE('content_block_stop', {
        type: 'content_block_stop',
        index: this.currentNonToolBlockIndex,
      });
      this.currentNonToolBlockIndex = null;
    }
  }

  _emitSSE(event, data) {
    this.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

function stripSSEField(line, field) {
  const prefix = `${field}: `;
  if (line.startsWith(prefix)) {
    return line.slice(prefix.length);
  }
  if (line === `${field}:`) {
    return '';
  }
  return null;
}

function mapStreamStopReason(finishReason) {
  switch (finishReason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls':
    case 'function_call': return 'tool_use';
    case 'content_filter': return 'end_turn';
    default: return 'end_turn';
  }
}

function extractCacheReadTokens(usage) {
  if (usage.cache_read_input_tokens !== undefined) return usage.cache_read_input_tokens;
  if (usage.prompt_tokens_details?.cached_tokens) return usage.prompt_tokens_details.cached_tokens;
  return null;
}

function buildStreamUsage(usage) {
  const result = {
    input_tokens: usage.prompt_tokens || 0,
    output_tokens: usage.completion_tokens || 0,
  };
  const cached = extractCacheReadTokens(usage);
  if (cached !== null) result.cache_read_input_tokens = cached;
  if (usage.cache_creation_input_tokens !== undefined) {
    result.cache_creation_input_tokens = usage.cache_creation_input_tokens;
  }
  return result;
}

module.exports = { OpenAIToAnthropicSSETransform, ERROR_KEYWORDS };
