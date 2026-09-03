// Step 5 verify — sends test messages to your imported agent-chat webhook.
// Usage:  node scratchpad-verify.mjs [webhook-url]
// Default URL: http://localhost:5678/webhook/spike/agent-chat
// (Always trust the "Production URL" shown inside n8n's Webhook node over any guess.)

const url = process.argv[2] || "http://localhost:5678/webhook/spike/agent-chat";
const stripSalesHtml = (s) => {
  const i = s.indexOf("{");
  return i > 0 ? s.slice(i) : s;
};
const cases = [
  { label: "1. product search", body: { message: "find me a serum under 2000 taka" } },
  { label: "2. product grid blocks", body: { message: "show me 2 sunscreens in a product grid" } },
  { label: "3. cart view (real cart)", body: { message: "what is in my cart", conversation_id: "tmp_cartfix1" } },
  { label: "4. plain hello", body: { message: "hi" } },
];

console.log("Sending test messages to:", url);
console.log("(each turn takes 10-60s — the agent calls the store + Gemini; no streaming, we wait)\n");

for (const c of cases) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c.body) });
    const raw = await r.text();
    const cleaned = stripSalesHtml(raw);
    let j = null;
    try { j = JSON.parse(cleaned); } catch {}
    console.log(`\n### ${c.label} — HTTP ${r.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (j) {
      console.log("conversation_id:", j.conversation_id);
      console.log("reply :", (j.reply || "").slice(0, 300));
      console.log("blocks:", JSON.stringify(j.blocks));
    } else {
      console.log("raw   :", cleaned.slice(0, 250));
    }
    if (r.status !== 200) { console.log("NON-200 — stopping. Check n8n Executions for the error."); break; }
  } catch (e) {
    console.log(`\n### ${c.label} — ERROR: ${e.message}`);
    console.log("(is n8n running? is the workflow Active?)");
    break;
  }
  await new Promise((r) => setTimeout(r, 1500));
}