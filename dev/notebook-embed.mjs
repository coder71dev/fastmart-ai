// notebook-embed.mjs — ask notebook-tools to (re)compute meaning vectors for
// notebook rows that are new or changed. sync.mjs runs it after deploying;
// perfecto-ai-ops does the same call after a staff edit.
//
// Usage: node dev/notebook-embed.mjs
//
// The webhook is gated by the same jwtAuth credential as agent-chat, whose
// secret is the container's N8N_WEBHOOK_JWT_SECRET, so a short-lived token is
// minted here instead of copying a long-lived one into the repo.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

const URL_ = process.env.NOTEBOOK_TOOLS_URL || 'http://localhost:5678/webhook/notebook-tools';

function token() {
  const r = spawnSync('docker', ['exec', 'fastmart-n8n', 'printenv', 'N8N_WEBHOOK_JWT_SECRET'], { encoding: 'utf8' });
  const secret = (r.stdout || '').trim();
  if (!secret) throw new Error('N8N_WEBHOOK_JWT_SECRET is empty in the fastmart-n8n container');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const si = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: 'notebook-embed', iat: now, exp: now + 600 });
  return si + '.' + crypto.createHmac('sha256', secret).update(si).digest('base64url');
}

const res = await fetch(URL_, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
  body: JSON.stringify({ action: 'embed-missing' }),
  signal: AbortSignal.timeout(300000),
});
const j = await res.json().catch(() => ({}));
if (!res.ok || !j.done) {
  console.error('embed-missing failed:', res.status, JSON.stringify(j).slice(0, 300));
  process.exit(1);
}
console.log(`notebook embeddings: ${j.embedded} updated${j.failed ? `, ${j.failed} failed (retried next run)` : ''}`);
