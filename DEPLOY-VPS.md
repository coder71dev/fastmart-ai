# Part 3 — Deploy to VPS (runbook)

Goal: move this exact stack onto the VPS next to the live Perfecto store, behind HTTPS, and cut the widget over to it. Everything below is copy-paste in order. Preconditions marked ⚠ must be true before you start.

**Status:** ⬜ not started — this runbook was written 2026-09-03 from the working local setup. Tick each step as you go and note deviations at the bottom.

---

## 0. Preconditions ⚠

- [ ] ⚠ VPS is reachable over SSH and has Docker + Docker Compose (`docker compose version` works).
- [ ] ⚠ A DNS record points at the VPS (e.g. `ai.perfectobd.com`). No HTTPS without it.
- [ ] ⚠ The live store is reachable at a stable HTTPS URL (this becomes `STORE_BASE_URL`).
- [ ] ⚠ Ports 80 + 443 are open on the VPS firewall; 5678 stays **closed** to the internet (Caddy proxies it).

## 1. Get the code + env onto the VPS

```bash
# on the VPS
git clone <this-repo-url> fastmart-ai && cd fastmart-ai
cp .env.example .env
```

Edit `.env`:

| Var | Set to |
|---|---|
| `N8N_HOST` | `ai.perfectobd.com` (your AI subdomain) |
| `N8N_PROTOCOL` | `https` |
| `N8N_SECURE_COOKIE` | `true` |
| `N8N_ENCRYPTION_KEY` | `openssl rand -hex 32` — **save it**; n8n credentials break if it changes |
| `N8N_USER_MANAGEMENT_JWT_SECRET` | `openssl rand -hex 32` |
| `POSTGRES_PASSWORD` | a real password |
| `STORE_BASE_URL` | live store URL, e.g. `https://perfectobd.com` |
| `N8N_RUNNERS_ENABLED` | leave `false` (see README — Code-node store calls need it) |

Do **not** touch `NODE_FUNCTION_ALLOW_BUILTIN` / `N8N_BLOCK_ENV_ACCESS_IN_NODE` — already in docker-compose.yml and required.

## 2. Start the stack

```bash
docker compose up -d
docker compose ps        # n8n, postgres, (meilisearch local-only) all Up
```

- Open `https://ai.perfectobd.com` **after** step 3 (TLS) — first visit completes owner signup, same as local.
- Meilisearch service is for the *local dev store*; on VPS the live store has its own search. Leave the service running (harmless) or comment it out of docker-compose.yml.

## 3. HTTPS via Caddy (automatic Let's Encrypt)

```bash
# Caddyfile
ai.perfectobd.com {
    reverse_proxy 127.0.0.1:5678
}
```

```bash
docker run -d --name caddy --restart unless-stopped \
  -p 80:443 -p 443:443 \
  -v $PWD/Caddyfile:/etc/caddy/Caddyfile \
  -v caddy_data:/data caddy:2
```

(nginx works too — anything that terminates TLS and proxies to 127.0.0.1:5678. HTTPS is also what unlocks the deferred WhatsApp/Messenger spike, Part 1 Step 6.)

## 4. Firewall

```bash
ufw allow 22,80,443/tcp && ufw enable
# verify 5678 is NOT reachable from outside:
curl -m 3 http://<vps-ip>:5678/   # must time out
```

## 5. Recreate the workflows

Two options — pick ONE:

**A. From this repo (recommended — deterministic):**
1. Complete n8n owner signup, then grab the owner id from the DB (see `dev/n8n-admin.mjs` `OWNER_ID` — adjust it there).
2. Edit `dev/deploy.mjs` / `dev/n8n-admin.mjs` `REST` constant if you run them from your machine against the VPS URL, or run them on the VPS.
3. `node dev/build-workflows.mjs && node dev/build-main.mjs`
4. Import the Gemini + Postgres credentials once in the n8n UI (names must match `dev/build-*.mjs`: "Gemini API Palm v3", "fastmart Postgres"). Their credential **ids differ on the VPS** — update `GEMINI_CRED` / `PG_CRED` in the two build scripts, rebuild, deploy:
   `node dev/deploy.mjs dev/out/*.json` (specialists first, then agentChat — ids are injected from `dev/build-main.mjs` `SPEC`).

**B. Backup/restore the whole n8n (keeps creds + history):**
```bash
# on the LOCAL machine (source)
docker exec fastmart-n8n-postgres pg_dump -U n8n fastmart_n8n > n8n-backup.sql
# on the VPS (target), with the stack freshly up
cat n8n-backup.sql | docker exec -i fastmart-n8n-postgres psql -U n8n fastmart_n8n
docker compose restart n8n
```
Then flip every workflow Active again. ⚠ Verify webhook path still `spike/agent-chat` (Production URL field is the source of truth — see WIDGET-CONTRACT.md).

## 6. Point the widget at the VPS

The widget fork (in `biz-buddy`, `storefront-widget.tsx`) defaults to the n8n webhook. On the live store set:

```js
window.__PERFECTO_N8N_CHAT_WEBHOOK = 'https://ai.perfectobd.com/webhook/spike/agent-chat';
```

- ⚠ CORS: the webhook must allow the store's origin — n8n webhooks do by default; if a proxy adds headers, test from the real widget page (DevTools → Network → 200 + contract JSON).
- Rollback: `window.__PERFECTO_CHAT_MODE = 'laravel'` reverts to the old SSE brain instantly.

## 7. Acceptance (all must pass before calling it live)

```bash
node dev/eval-harness.mjs --webhook https://ai.perfectobd.com/webhook/spike/agent-chat \
  --store https://perfectobd.com --out vps-eval.json
# expect: pass=10 fail=0
```

- [ ] Eval green (10/10) against the **live store**.
- [ ] One real browser session: search → product cards render; add → cart table renders with true total; remove → empty.
- [ ] `STORE_BASE_URL` set to live store; no references to `fastmart-pro.test` anywhere (`grep -r fastmart-pro` clean).
- [ ] n8n executions list shows all `success` for the above.
- [ ] Nightly backups scheduled (below).

## 8. Backups

```bash
# crontab -e
0 3 * * * cd /opt/fastmart-ai && docker exec fastmart-n8n-postgres pg_dump -U n8n fastmart_n8n | gzip > backups/n8n-$(date +\%F).sql.gz && find backups -mtime -14 -delete
```

Also snapshot the `n8n_data` volume occasionally (holds the encryption-key-linked credentials) — but with a stable `N8N_ENCRYPTION_KEY`, DB dumps are the real backup.

## 9. After go-live

- [ ] Watch n8n Executions daily for the first week (errors, loops, latency).
- [ ] Re-run the eval battery after any prompt change — it's the regression gate.
- [ ] Part 1 Step 6 (WhatsApp/email channels) can now be spiked — HTTPS is in place.

---

## Deviations / notes from the actual deploy

(fill in during the real run)
