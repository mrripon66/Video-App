'use strict';
const { FREE_MODELS } = require('./free-provider');
const { MODELS: LEGACY_PAID_MODELS } = require('./providers');

const hiddenIds = new Set(['ltx-free', 'cogvideo2-free']);
const publicModels = FREE_MODELS.filter(model => !hiddenIds.has(model.id));
if (!publicModels.some(model => model.id === 'wan-free')) publicModels.push({ id: 'wan', name: 'Wan — Not configured', provider: 'huggingface', available: false,
  description: 'A working free prompt-to-video service is being verified.', reason: 'No working anonymous prompt-to-video backend is configured for Wan.', docsUrl: null });
publicModels.push({ id: 'hunyuan', name: 'Hunyuan Video — Image required', provider: 'huggingface', available: false,
  description: 'The verified free demo needs a reference image.',
  reason: 'The publisher-endorsed free Hunyuan demo requires a reference image. A working anonymous prompt-only route is not configured.',
  docsUrl: 'https://huggingface.co/spaces/multimodalart/Hunyuan-Video-1-5' });
const priority = { 'ltx2-story-free': 0, 'ltx2-free': 1, 'wan-free': 2, 'animatediff-free': 3, 'cogvideo-free': 4, wan: 5, hunyuan: 6 };
publicModels.sort((a, b) => (priority[a.id] ?? 10) - (priority[b.id] ?? 10));
const PUBLIC_MODELS = Object.freeze(publicModels.map(model => Object.freeze(model)));
const byId = new Map([...FREE_MODELS, ...PUBLIC_MODELS].map(model => [model.id, model]));
for (const model of LEGACY_PAID_MODELS) {
  if (!byId.has(model.id)) byId.set(model.id, { ...model, available: false, description: 'Historical paid integration, disabled.',
    reason: 'Paid providers are disabled in this free-only application.', docsUrl: null });
}
const MODELS = Object.freeze([...byId.values()]);
const MODEL_ALIASES = Object.freeze(Object.fromEntries(MODELS.map(model => [model.id, model.name])));
module.exports = { PUBLIC_MODELS, MODELS, MODEL_ALIASES };
