// n8n-admin — drive the local n8n editor REST as owner by minting an auth cookie.
// Usage:
//   node dev/n8n-admin.mjs cookie
//   node dev/n8n-admin.mjs get <workflowId>
//   node dev/n8n-admin.mjs list
//   node dev/n8n-admin.mjs create <workflowJsonFile> [--activate]
//   node dev/n8n-admin.mjs update <workflowId> <workflowJsonFile>
//   node dev/n8n-admin.mjs activate <workflowId> [versionId]
//   node dev/n8n-admin.mjs deactivate <workflowId>
//   node dev/n8n-admin.mjs delete <workflowId>
//
// The cookie is minted exactly like AuthService.issueJWT (HS256, secret from
// N8N_USER_MANAGEMENT_JWT_SECRET, payload {id, hash, usedMfa}). This mirrors a
// normal owner browser login; it does not touch passwords.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

const REST = 'http://localhost:5678/rest';
const OWNER_ID = '05933423-6fe4-4741-8988-8e28fd173da7';

function docker(...args) {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker ${args[0]} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function jwtSecret() {
  const s = docker('exec', 'fastmart-n8n', 'printenv', 'N8N_USER_MANAGEMENT_JWT_SECRET');
  if (!s) throw new Error('JWT secret is empty — cannot mint cookie');
  return s;
}

function ownerUser() {
  const sql =
    "SELECT email, password, \"mfaEnabled\" FROM \"user\" WHERE id = '" + OWNER_ID + "';";
  // pass SQL through stdin to avoid Windows quoting hell
  const psql = spawnSync(
    'docker',
    ['exec', '-i', 'fastmart-n8n-postgres', 'psql', '-U', 'n8n', '-d', 'fastmart_n8n', '-t', '-A', '-F', '\u0001'],
    { encoding: 'utf8', input: sql },
  );
  if (psql.status !== 0) throw new Error(`psql failed: ${psql.stderr}`);
  const line = psql.stdout.trim();
  if (!line) throw new Error('owner row not found');
  const [email, password, mfaEnabled] = line.split('\u0001');
  return { email, password, mfaEnabled: mfaEnabled === 't' };
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function createJwtHash({ email, password, mfaEnabled }) {
  const parts = [email, password];
  return crypto.createHash('sha256').update(parts.join(':')).digest('base64').substring(0, 10);
}

function mintCookie() {
  const secret = jwtSecret();
  const user = ownerUser();
  const payload = {
    id: OWNER_ID,
    hash: createJwtHash(user),
    usedMfa: false,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 7 * 86400,
  };
  const header = { alg: 'HS256', typ: 'JWT' };
  const signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
  return signingInput + '.' + sig;
}

async function api(method, path, body) {
  const cookie = mintCookie();
  const res = await fetch(REST + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `n8n-auth=${cookie}; n8n-auth=${cookie}`,
      ...(body !== undefined ? {} : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text.slice(0, 500) };
  }
  return { status: res.status, json };
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  switch (cmd) {
    case 'cookie':
      console.log(mintCookie());
      break;
    case 'debug': {
      const secret = jwtSecret();
      const user = ownerUser();
      console.log('secret_len', secret.length);
      console.log('email', user.email);
      console.log('pw_hash_len', user.password.length, 'mfa', user.mfaEnabled);
      console.log('computed_hash', createJwtHash(user));
      const token = mintCookie();
      const verify = spawnSync(
        'docker',
        ['exec', 'fastmart-n8n', 'node', '-e',
          `const jwt=require('/usr/local/lib/node_modules/n8n/node_modules/jsonwebtoken');` +
          `try{const d=jwt.verify(${JSON.stringify(token)}, process.env.N8N_USER_MANAGEMENT_JWT_SECRET, {algorithms:['HS256']});console.log('VERIFY_OK',JSON.stringify(d));}catch(e){console.log('VERIFY_FAIL',e.message);}`],
        { encoding: 'utf8' },
      );
      console.log(verify.stdout.trim(), verify.stderr.trim());
      break;
    }
    case 'list': {
      const { status, json } = await api('GET', '/workflows?limit=100');
      console.log('HTTP', status);
      console.log(JSON.stringify(json, null, 2).slice(0, 4000));
      break;
    }
    case 'get': {
      const { status, json } = await api('GET', `/workflows/${a}`);
      console.log('HTTP', status);
      console.log(JSON.stringify(json, null, 2));
      break;
    }
    case 'create': {
      const wf = JSON.parse(fs.readFileSync(a, 'utf8'));
      delete wf.id;
      const { status, json } = await api('POST', '/workflows', wf);
      console.log('HTTP', status);
      console.log(JSON.stringify(json, null, 2));
      if (status === 200 && json?.data?.id && b === '--activate') {
        const { status: s2, json: j2 } = await api('POST', `/workflows/${json.data.id}/activate`, {
          versionId: json.data.versionId,
        });
        console.log('ACTIVATE HTTP', s2, JSON.stringify(j2));
      }
      break;
    }
    case 'update': {
      const wf = JSON.parse(fs.readFileSync(b, 'utf8'));
      delete wf.id;
      delete wf.active;
      const { status, json } = await api('PUT', `/workflows/${a}`, wf);
      console.log('HTTP', status);
      console.log(JSON.stringify(json, null, 2).slice(0, 3000));
      break;
    }
    case 'activate': {
      const body = b ? { versionId: b } : {};
      const { status, json } = await api('POST', `/workflows/${a}/activate`, body);
      console.log('HTTP', status);
      console.log(JSON.stringify(json, null, 2).slice(0, 1500));
      break;
    }
    case 'deactivate': {
      const { status, json } = await api('POST', `/workflows/${a}/deactivate`, {});
      console.log('HTTP', status);
      console.log(JSON.stringify(json, null, 2).slice(0, 1500));
      break;
    }
    case 'delete': {
      const { status, json } = await api('DELETE', `/workflows/${a}`);
      console.log('HTTP', status, JSON.stringify(json));
      break;
    }
    case 'post': {
      const body = JSON.parse(fs.readFileSync(a, 'utf8'));
      const { status, json } = await api('POST', b || '/', body);
      console.log('HTTP', status);
      console.log(JSON.stringify(json, null, 2).slice(0, 3000));
      break;
    }
    case 'execs': {
      const { status, json } = await api('GET', `/executions?workflowId=${a}&limit=4&includeData=false`);
      console.log('HTTP', status);
      console.log(JSON.stringify(json, null, 2).slice(0, 2500));
      break;
    }
    case 'exec': {
      const { status, json } = await api('GET', `/executions/${a}?includeData=true`);
      console.log('HTTP', status);
      console.log(JSON.stringify(json, null, 2).slice(0, 8000));
      break;
    }
    default:
      console.log('unknown command');
  }
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
