// Single source of truth for WHICH model the built workflows talk to.
//
// Switching provider is an env change, not a code edit:
//
//   node dev/build-main.mjs                                  # Command Code (default)
//   MODEL_PROVIDER=gemini node dev/build-main.mjs             # back to Gemini
//   MODEL_PROVIDER=openrouter MODEL_CRED_ID=xxx \
//     MODEL_CRED_NAME=OpenRouter node dev/build-main.mjs      # any openAiApi credential
//
// MODEL overrides just the model id inside the chosen provider (e.g.
// MODEL=google/gemini-3.7-flash keeps Command Code but changes the model).
//
// NOTE: n8n credential ids are per-instance. The ids below are this instance's;
// on a fresh install take them from the n8n UI and pass MODEL_CRED_ID/_NAME.
const PROVIDERS = {
  // Command Code's gateway. OpenAI wire, so the endpoint lives in the
  // credential's "Base URL" field (https://api.commandcode.ai/provider/v1) —
  // never in the node, so nothing here has to know the URL.
  commandcode: {
    nodeName: 'OpenAI Chat Model',
    type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
    param: 'model',
    model: 'deepseek/deepseek-v4.1-flash',
    credKey: 'openAiApi',
    cred: { id: 'mlmhRJXXejblFl1S', name: 'OpenAI compatible Commandcode' },
  },
  // Gemini direct via n8n's own Google Gemini node.
  gemini: {
    nodeName: 'Gemini Model',
    type: '@n8n/n8n-nodes-langchain.lmChatGoogleGemini',
    param: 'modelName',
    model: 'models/gemini-3.7-flash',
    credKey: 'googlePalmApi',
    cred: { id: 'NZ6P1UaAuMYlAFa1', name: 'Gemini API Palm v3' },
  },
  // Any other OpenAI-compatible gateway. Model + credential come from env
  // because neither is knowable ahead of time.
  openrouter: {
    nodeName: 'OpenAI Chat Model',
    type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
    param: 'model',
    model: 'openrouter/google/gemini-2.5-pro',
    credKey: 'openAiApi',
    cred: { id: '', name: 'OpenRouter' },
  },
};

function resolve() {
  const key = (process.env.MODEL_PROVIDER || 'commandcode').toLowerCase();
  const p = PROVIDERS[key];
  if (!p) {
    throw new Error(`unknown MODEL_PROVIDER "${key}" — known: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  const id = process.env.MODEL_CRED_ID || p.cred.id;
  const name = process.env.MODEL_CRED_NAME || p.cred.name;
  if (!id) throw new Error(`MODEL_PROVIDER=${key} needs MODEL_CRED_ID (the n8n credential id)`);
  return {
    nodeName: p.nodeName,
    type: p.type,
    provider: key,
    model: process.env.MODEL || p.model,
    credentials: { [p.credKey]: { id, name } },
    param: p.param,
  };
}

export const MODEL_NODE = resolve();

// The fields the model node needs, minus its id/position (the builders add those).
export function modelNodeFields() {
  return {
    name: MODEL_NODE.nodeName,
    type: MODEL_NODE.type,
    typeVersion: 1,
    parameters: { [MODEL_NODE.param]: MODEL_NODE.model, options: { temperature: 0.2 } },
    credentials: MODEL_NODE.credentials,
  };
}
