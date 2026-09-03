// model-bench.mjs — time candidate Gemini models on representative prompts.
// Usage: node dev/model-bench.mjs [apiKey]
// Prompts mirror real traffic: (a) tiny router call, (b) fat tool-result call
// (a real /api/v4/products payload fed back, like the specialist's last hop).
const key = process.argv[2];
if (!key) { console.log('usage: node dev/model-bench.mjs <apiKey>'); process.exit(1); }
const MODELS = ['models/gemini-3.6-flash', 'models/gemini-3.7-flash', 'models/gemini-3.8-flash', 'models/gemini-3.5-flash-lite', 'models/gemini-3.1-flash-lite', 'models/gemini-2.5-flash', 'models/gemini-2.5-flash-lite'];

const searchRes = await fetch('http://fastmart-pro.test/api/v4/products?keyword=vitamin%20c%20serum&limit=5').then((r) => r.text());
const TINY = { sys: 'You are a router. Reply with one word naming the specialist for the request.', user: 'customer: add the iUNIK Tea Tree Relief Serum to my cart' };
const FAT = {
  sys: 'You are a beauty store product specialist. Recommend the best matches to the customer. Answer in at most 3 short bullets with prices in ৳, then a footer line META_PRODUCT_IDS: <ids>.',
  user: 'search results json:\n' + searchRes.slice(0, 12000) + '\n\nCustomer: find me a vitamin c serum',
};

async function call(model, prompt) {
  const body = {
    systemInstruction: { parts: [{ text: prompt.sys }] },
    contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 400 },
  };
  const t0 = Date.now();
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  const txt = j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
  return { ms: Date.now() - t0, status: r.status, out: txt.length, err: j?.error?.message?.slice(0, 90) };
}

console.log(`fat prompt = real product-search payload (${searchRes.length} chars)\n`);
for (const m of MODELS) {
  const row = [m.replace('models/', '').padEnd(20)];
  for (const [label, p] of [['tiny', TINY], ['fat', FAT]]) {
    const times = [];
    let last = null;
    for (let i = 0; i < 3; i++) {
      last = await call(m, p);
      if (last.status !== 200) break;
      times.push(last.ms);
    }
    if (last.status !== 200) { row.push(`${label}: HTTP ${last.status} ${last.err}`); break; }
    times.sort((a, b) => a - b);
    row.push(`${label}: ${times[1]}ms med (${times.join(',')}) out=${last.out}c`);
  }
  console.log(row.join('  '));
}
