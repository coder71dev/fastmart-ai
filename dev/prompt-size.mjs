// dev/prompt-size.mjs — how big is the fixed base each agent re-sends on EVERY
// LLM call? That base (system prompt + tool descriptions), not the routing, is
// what dominates a turn: the orchestrator makes 2-3 calls, so every 100 tokens
// added here is charged 2-3 times.
//
//   node dev/prompt-size.mjs
//
// Token counts are an estimate (characters / 4 for English). Where a real
// measurement exists it is noted, so the estimate can be checked against it.
import * as P from './prompts.js';

const tok = (s) => Math.round(String(s).length / 4);
const row = (label, s, calls = 1) => {
  const t = tok(s);
  console.log(`  ${String(label).padEnd(26)} ${String(String(s).length).padStart(6)} chars  ~${String(t).padStart(5)} tokens  x${calls}`);
  return t;
};

// Only these five tools are attached to the orchestrator's agent (see
// dev/build-main.mjs: SPECIALIST_TOOLS + CART_ADD_TOOL). P.TOOL also holds the
// descriptions the SPECIALISTS use for their own tools (searchProducts,
// productDetail, getCart, cartSummary, policyLookup) - counting those here would
// inflate the orchestrator's base by ~250 tokens it never sends.
const ORCHESTRATOR_TOOLS = ['productDiscovery', 'supportSpecialist', 'cartSpecialist', 'orderManagement', 'cartAdd'];
const SPECIALIST_TOOLS = ['searchProducts', 'productDetail', 'getCart', 'cartSummary', 'policyLookup'];

console.log('orchestrator (1 call, re-sent on every orchestrator call)');
const orch = row('ORCHESTRATOR system prompt', P.ORCHESTRATOR);
const toolDescs = ORCHESTRATOR_TOOLS.map((k) => row(`tool: ${k}`, P.TOOL[k]));
const orchBase = orch + toolDescs.reduce((a, b) => a + b, 0);
console.log(`  ${'─'.repeat(52)}`);
console.log(`  fixed base per orchestrator call   ~${orchBase} tokens`);
console.log(`  a product turn makes 2-3 of them  => ~${orchBase * 2}-${orchBase * 3} tokens/turn`);
console.log('  (measured reference: turn 1610, orchestrator call 1 = 2,672 prompt tokens');
console.log('   including this base + the shopping context + the customer message)');

console.log('\nspecialist-side tool descriptions (sent inside the specialists, not here)');
const specToolDescs = SPECIALIST_TOOLS.reduce((a, k) => a + row(`tool: ${k}`, P.TOOL[k]), 0);
console.log(`  ${'─'.repeat(52)}`);
console.log(`  specialist tool descriptions        ~${specToolDescs} tokens`);

console.log('\nspecialists (the first call of each is the pure base)');
const specs = [
  ['PRODUCT_DISCOVERY', P.PRODUCT_DISCOVERY],
  ['SUPPORT_SPECIALIST', P.SUPPORT_SPECIALIST],
  ['CART_SPECIALIST', P.CART_SPECIALIST],
  ['ORDER_MANAGEMENT', P.ORDER_MANAGEMENT],
];
for (const [name, text] of specs) row(name, text, 2);

console.log('\nnot measured here: the runtime shopping-context block (categories, cart,');
console.log('profile) built in dev/build-main.mjs, and the search-result text a');
console.log('specialist accumulates. Both come from the token table instead.');
