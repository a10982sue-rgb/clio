// Static model roster — the upstream is OpenAI-shaped and accepts Claude model IDs.
// We expose this list at /v1/models (both OpenAI and Anthropic shapes). Unknown
// model IDs are still passed through verbatim; the upstream will reject and we
// relay the error, so this list is advisory, not a gate.
const MODELS = [
  { id: 'claude-fable-5',      label: 'Claude Fable 5' },
  { id: 'claude-opus-4-8',     label: 'Claude Opus 4.8' },
  { id: 'claude-sonnet-5',     label: 'Claude Sonnet 5' },
  { id: 'claude-haiku-4-5',    label: 'Claude Haiku 4.5' },
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
