// Anthropic Messages API  <->  OpenAI Chat Completions
// Both directions, request + response, streaming + non-streaming.
// Handles: roles, content blocks (text/image/tool_use/tool_result),
// tool definitions, tool_choice, thinking (reasoning), and usage.

// ---------------------------------------------------------------------------
// Anthropic REQUEST  ->  OpenAI REQUEST
// ---------------------------------------------------------------------------

function anthropicToOpenAIRequest(body) {
  const out = {
    model: body.model,
    stream: !!body.stream,
    messages: anthropicMessagesToOpenAI(body.messages || []),
  };

  // System prompt: Anthropic carries it as a top-level field (string or content blocks).
  if (body.system) {
    const sys = typeof body.system === 'string'
      ? body.system
      : (Array.isArray(body.system) ? blocksToText(body.system) : '');
    if (sys) out.messages.unshift({ role: 'system', content: sys });
  }

  if (body.tools && body.tools.length) {
    out.tools = body.tools.map(anthropicToolToOpenAI);
  }

  // tool_choice: {type:'auto'|'any'|'tool', name?} -> OpenAI shape
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc.type === 'auto') out.tool_choice = 'auto';
    else if (tc.type === 'any') out.tool_choice = 'required';
    else if (tc.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: tc.name } };
    else if (tc.type === 'none') out.tool_choice = 'none';
  }

  // Sampling knobs: Anthropic uses temperature + top_p + max_tokens.
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;

  // Thinking. Anthropic: { type:'enabled', budget_tokens } or { type:'disabled' }.
  // Upstream exposes this as OpenAI-style reasoning_effort (low|medium|high|xhigh).
  // Explicit enabled -> budget-mapped effort. Explicit disabled -> 'low' (some
  // upstreams reject 'none'). No thinking field at all -> default 'high', so the
  // proxy produces real reasoning by default rather than answering too fast.
  if (body.thinking && body.thinking.type === 'enabled') {
    const budget = body.thinking.budget_tokens || 0;
    out.reasoning_effort = budget >= 16000 ? 'xhigh'
      : budget >= 8000 ? 'high'
      : budget >= 2000 ? 'medium' : 'low';
  } else if (body.thinking && body.thinking.type === 'disabled') {
    out.reasoning_effort = 'low';
  } else {
    out.reasoning_effort = 'high';
  }

  // stop_sequences -> stop
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    out.stop = body.stop_sequences;
  }

  return out;
}

function anthropicMessagesToOpenAI(messages) {
  const out = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;

    // Tool-result role in Anthropic is 'user' with tool_result blocks. OpenAI wants
    // a separate 'tool' message per result. Assistant tool_use blocks become the
    // assistant message's tool_calls; text blocks stay as content.
    if (m.role === 'assistant') {
      const textParts = [];
      const toolCalls = [];
      let idx = 0;
      for (const b of m.content) {
        if (b.type === 'text') textParts.push(b.text);
        else if (b.type === 'tool_use') {
          toolCalls.push({
            index: idx++,
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}) },
          });
        } else if (b.type === 'thinking') {
          // OpenAI shape carries reasoning via delta.reasoning_content; for a
          // prefill/assistant turn we drop prior thinking (it's not replayed).
        }
      }
      const msg = { role: 'assistant' };
      msg.content = textParts.length ? textParts.join('\n\n') : null;
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
      continue;
    }

    if (m.role === 'user') {
      // Split into image/text vs tool_result blocks.
      const toolResults = m.content.filter((b) => b.type === 'tool_result');
      const other = m.content.filter((b) => b.type !== 'tool_result');

      if (toolResults.length) {
        for (const tr of toolResults) {
          let content;
          if (typeof tr.content === 'string') content = tr.content;
          else if (Array.isArray(tr.content)) content = blocksToText(tr.content);
          else content = '';
          out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: content || '' });
        }
      }
      if (other.length) {
        // Build a multimodal OpenAI content array (text + image_url).
        const parts = [];
        for (const b of other) {
          if (b.type === 'text') parts.push({ type: 'text', text: b.text });
          else if (b.type === 'image') {
            const src = b.source || {};
            if (src.type === 'base64' && src.media_type && src.data) {
              parts.push({ type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } });
            } else if (src.type === 'url' && src.url) {
              parts.push({ type: 'image_url', image_url: { url: src.url } });
            }
          }
        }
        out.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
      }
      continue;
    }

    // Passthrough any other role as plain text.
    out.push({ role: m.role, content: blocksToText(m.content) });
  }
  return out;
}

function anthropicToolToOpenAI(t) {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  };
}

function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks.map((b) => b.text || '').join('\n\n');
}

// ---------------------------------------------------------------------------
// OpenAI RESPONSE  ->  Anthropic RESPONSE (non-streaming)
// ---------------------------------------------------------------------------

function openAIToAnthropicResponse(oai) {
  const choice = oai.choices && oai.choices[0];
  const msg = choice?.message || {};
  const content = [];
  let stopReason = 'end_turn';

  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) {
    content.push({ type: 'thinking', thinking: msg.reasoning_content });
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input;
      try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function?.name,
        input,
      });
    }
    stopReason = 'tool_use';
  }

  if (typeof msg.content === 'string' && msg.content) {
    content.push({ type: 'text', text: msg.content });
  }

  if (content.length === 0) content.push({ type: 'text', text: '' });

  return {
    id: oai.id,
    type: 'message',
    role: 'assistant',
    model: oai.model,
    content,
    stop_reason: openAIToAnthropicStop(choice?.finish_reason),
    stop_sequence: null,
    usage: openAIToAnthropicUsage(oai.usage),
  };
}

function openAIToAnthropicStop(fr) {
  switch (fr) {
    case 'stop': return 'end_turn';
    case 'tool_calls': return 'tool_use';
    case 'length': return 'max_tokens';
    case 'content_filter': return 'end_turn';
    default: return 'end_turn';
  }
}

function openAIToAnthropicUsage(u) {
  if (!u) return { input_tokens: 0, output_tokens: 0 };
  return {
    input_tokens: u.prompt_tokens || 0,
    output_tokens: u.completion_tokens || 0,
    cache_creation_input_tokens: u.prompt_tokens_details?.cached_tokens ? 0 : 0,
    cache_read_input_tokens: u.prompt_tokens_details?.cached_tokens || 0,
  };
}

// ---------------------------------------------------------------------------
// OpenAI SSE  ->  Anthropic SSE  (streaming)
// ---------------------------------------------------------------------------
// Anthropic streaming event sequence:
//   message_start -> a series of content_block_start/content_block_delta/
//   content_block_stop -> message_delta (with stop_reason/usage) -> message_stop
//
// We synthesize this from OpenAI chunk deltas. Thinking becomes a thinking
// block; tool_calls become tool_use blocks (one per tool index); text becomes
// a text block.

function createAnthropicStreamEncoder(model) {
  const state = {
    started: false,
    blockIdx: 0,
    blockType: null,        // 'text' | 'thinking' | 'tool_use'
    toolIndexToBlock: {},   // openai tool-call index -> anthropic block index
    blockOpen: false,
    messageId: 'msg_' + randomId(),
  };
  const out = [];

  function openText() { return blockStart('text', { text: '' }); }
  function openThinking() { return blockStart('thinking', { thinking: '' }); }
  function openToolUse(id, name) { return blockStart('tool_use', { id, name, input: '' }); }

  function blockStart(type, extra) {
    state.blockType = type;
    state.blockOpen = true;
    const evt = {
      type: 'content_block_start',
      index: state.blockIdx,
      content_block: { type, ...extra },
    };
    return evt;
  }

  function closeCurrent() {
    if (!state.blockOpen) return null;
    state.blockOpen = false;
    const evt = { type: 'content_block_stop', index: state.blockIdx };
    state.blockIdx++;
    state.blockType = null;
    return evt;
  }

  function startMessage() {
    state.started = true;
    return {
      type: 'message_start',
      message: {
        id: state.messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    };
  }

  function feedChunk(oaiChunk) {
    const evs = [];
    if (!state.started) evs.push(startMessage());

    const choice = oaiChunk.choices && oaiChunk.choices[0];
    const delta = choice?.delta || {};

    // reasoning -> thinking block
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      if (state.blockType !== 'thinking') {
        const c = closeCurrent(); if (c) evs.push(c);
        evs.push(openThinking());
      }
      evs.push({ type: 'content_block_delta', index: state.blockIdx, delta: { type: 'thinking_delta', thinking: delta.reasoning_content } });
    }

    // text -> text block
    if (typeof delta.content === 'string' && delta.content) {
      if (state.blockType !== 'text') {
        const c = closeCurrent(); if (c) evs.push(c);
        evs.push(openText());
      }
      evs.push({ type: 'content_block_delta', index: state.blockIdx, delta: { type: 'text_delta', text: delta.content } });
    }

    // tool_calls -> tool_use blocks
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (state.toolIndexToBlock[idx] === undefined) {
          const c = closeCurrent(); if (c) evs.push(c);
          state.toolIndexToBlock[idx] = state.blockIdx;
          evs.push(openToolUse(tc.id || ('call_' + idx), tc.function?.name || ''));
          // first argument fragment, if any
          if (tc.function?.arguments) {
            evs.push({ type: 'content_block_delta', index: state.blockIdx, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
          }
        } else {
          const bi = state.toolIndexToBlock[idx];
          if (tc.function?.name) {
            evs.push({ type: 'content_block_delta', index: bi, delta: { type: 'input_json_delta', partial_json: '' } });
          }
          if (tc.function?.arguments) {
            evs.push({ type: 'content_block_delta', index: bi, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
          }
        }
      }
    }

    // finish_reason -> message_delta + close
    if (choice?.finish_reason) {
      const c = closeCurrent(); if (c) evs.push(c);
      evs.push({
        type: 'message_delta',
        delta: { stop_reason: openAIToAnthropicStop(choice.finish_reason), stop_sequence: null },
        usage: { output_tokens: 0 },
      });
      evs.push({ type: 'message_stop' });
    }

    // usage often arrives on the final chunk with finish_reason
    if (oaiChunk.usage) {
      evs.push({
        type: 'message_delta',
        delta: {},
        usage: openAIToAnthropicUsage(oaiChunk.usage),
      });
    }

    return evs;
  }

  function flushEnd() {
    const evs = [];
    if (!state.started) evs.push(startMessage());
    if (state.blockOpen) { evs.push(closeCurrent()); }
    evs.push({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } });
    evs.push({ type: 'message_stop' });
    return evs;
  }

  return { feedChunk, flushEnd, out };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomId() {
  // crypto-safe enough for a correlation id; no Date/random reliance beyond this.
  return require('crypto').randomBytes(12).toString('hex');
}

module.exports = {
  anthropicToOpenAIRequest,
  openAIToAnthropicResponse,
  createAnthropicStreamEncoder,
  openAIToAnthropicStop,
  openAIToAnthropicUsage,
};
