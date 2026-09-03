// node dev/dump-node.mjs <workflowId> <nodeName> <outFile> — writes node jsCode (UTF-8, no console mangling)
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

const [wfId, nodeName, outFile] = process.argv.slice(2);
const REST = 'http://localhost:5678/rest';
const OWNER_ID = '05933423-6fe4-4741-8988-8e28fd173da7';
const docker = (...a) => spawnSync('docker', a, { encoding: 'utf8' });
const secret = docker('exec', 'fastmart-n8n', 'printenv', 'N8N_USER_MANAGEMENT_JWT_SECRET').stdout.trim();
const owner = docker('exec', '-i', 'fastmart-n8n-postgres', 'psql', '-U', 'n8n', '-d', 'fastmart_n8n', '-t', '-A', '-F', '\u0001', '-c', `SELECT email, password, "mfaEnabled" FROM "user" WHERE id='${OWNER_ID}'`).stdout.trim().split('\u0001');
const b64 = (b) => Buffer.from(b).toString('base64url');
const hash = crypto.createHash('sha256').update([owner[0], owner[1]].join(':')).digest('base64').substring(0, 10);
const payload = { id: OWNER_ID, hash, usedMfa: false, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
const si = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) + '.' + b64(JSON.stringify(payload));
const token = si + '.' + crypto.createHmac('sha256', secret).update(si).digest('base64url');
const res = await fetch(`${REST}/workflows/${wfId}`, { headers: { Cookie: `n8n-auth=${token}` } });
const j = await res.json();
const node = j?.data?.nodes?.find((n) => n.name === nodeName);
if (!node) { console.log('node not found'); process.exit(1); }
fs.writeFileSync(outFile, node.parameters.jsCode ?? '', 'utf8');
console.log('wrote', outFile, (node.parameters.jsCode ?? '').length, 'chars');
