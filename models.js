// Static model roster — the upstream is OpenAI-shaped and accepts Claude model IDs.
// We expose this list at /v1/models (both OpenAI and Anthropic shapes). Unknown
// model IDs are still passed through verbatim; the upstream will reject and we
// relay the error, so this list is advisory, not a gate.
const MODELS = [
  { id: 'claude-fable-5',      label: 'Claude Fable 5' },
  { id: 'claude-sonnet-5',    label: 'Claude Sonnet 5' },
  { id: 'claude-opus-4-8',    label: 'Claude Opus 4.8' },
  { id: 'claude-haiku-4-5',   label: 'Claude Haiku 4.5' },
  { id: 'glm-5.2',            label: 'Zhipu GLM 5.2' },
  { id: 'glm-5.2-fast',       label: 'Zhipu GLM 5.2 Fast' },
  { id: 'kimi-k2.7-code',     label: 'Moonshot Kimi K2.7 Code' },
  { id: 'minimax-m3',         label: 'MiniMax M3' },
  { id: 'qwen-3.7-plus',      label: 'Alibaba Qwen 3.7 Plus' },
  { id: 'gpt-4o',             label: 'OpenAI GPT-4o' },
];

function openaiModelsList() {
  return {
    object: 'list',
    data: MODELS.map((m, i) => ({
      id: m.id,
      object: 'model',
      created: 1700000000 + i,
      owned_by: 'ollie-proxy',
    })),
  };
}

function anthropicModelsList() {
  return {
    data: MODELS.map((m) => ({
      type: 'model',
      id: m.id,
      display_name: m.label,
      created_at: '2025-01-01T00:00:00Z',
    })),
    has_more: false,
    first_id: MODELS[0]?.id ?? null,
    last_id: MODELS[MODELS.length - 1]?.id ?? null,
  };
}

module.exports = { MODELS, openaiModelsList, anthropicModelsList };
