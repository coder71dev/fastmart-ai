// gemini-sig-proxy.mjs
//
// Sits between n8n Assistant and Gemini's OpenAI-compatible endpoint.
//
// Gemini 3 attaches a `thought_signature` to every tool call. When the tool
// result is sent back, Gemini requires that signature on the assistant's
// tool-call message. n8n's OpenAI-compatible client drops it (it isn't a
// standard OpenAI field), so the follow-up turn fails with
// `400 Function call is missing a thought_signature`.
//
// This proxy caches each tool call's signature from the model response and
// re-attaches it to the matching assistant tool-call message on the next
// request. Everything else is passed through untouched. Internal-only.

import http from 'node:http';

const PORT = Number(process.env.PORT || 8017);
const UPSTREAM = (
  process.env.GEMINI_UPSTREAM ||
  'https://generativelanguage.googleapis.com/v1beta/openai'
).replace(/\/+$/, '');
const MAX_SIGS = 2000;

const sigs = new Map(); // tool_call id -> thought_signature

function remember(id, sig) {
  if (!id || !sig) return;
  sigs.delete(id);
  sigs.set(id, sig);
  while (sigs.size > MAX_SIGS) {
    sigs.delete(sigs.keys().next().value);
  }
}

function injectSignatures(body) {
  if (!body || !Array.isArray(body.messages)) return 0;
  let injected = 0;
  for (const msg of body.messages) {
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue;
    for (const tc of msg.tool_calls) {
      const present = tc?.extra_content?.google?.thought_signature;
      if (!present && tc?.id && sigs.has(tc.id)) {
        tc.extra_content = { google: { thought_signature: sigs.get(tc.id) } };
        injected++;
      }
    }
  }
  return injected;
}

function captureToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return;
  for (const tc of toolCalls) {
    remember(tc?.id, tc?.extra_content?.google?.thought_signature);
  }
}

function captureFromJson(json) {
  const choices = json?.choices;
  if (!Array.isArray(choices)) return;
  for (const ch of choices) {
    captureToolCalls(ch?.message?.tool_calls);
    captureToolCalls(ch?.delta?.tool_calls);
  }
}

// Gemini's OpenAI-compatible STREAM sends finish_reason "stop" even when the
// message contains tool calls (its non-streaming path correctly says
// "tool_calls"). The AI SDK trusts finish_reason to decide whether to continue
// the agent loop, so "stop" makes n8n end the turn right after running a tool.
function jsonHasToolCalls(json) {
  const choices = json?.choices;
  if (!Array.isArray(choices)) return false;
  return choices.some(
    (ch) =>
      (Array.isArray(ch?.delta?.tool_calls) && ch.delta.tool_calls.length > 0) ||
      (Array.isArray(ch?.message?.tool_calls) && ch.message.tool_calls.length > 0),
  );
}

function forceToolCallsFinish(json) {
  const choices = json?.choices;
  if (!Array.isArray(choices)) return false;
  let changed = false;
  for (const ch of choices) {
    if (ch && ch.finish_reason === 'stop') {
      ch.finish_reason = 'tool_calls';
      changed = true;
    }
  }
  return changed;
}

function parseSseData(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const upstreamPath = url.pathname.replace(/^\/v1(?=\/|$)/, '');
    const target = UPSTREAM + upstreamPath + (url.search || '');
    const isChat = /\/chat\/completions$/.test(upstreamPath);

    const raw = await readBody(req);
    let outgoing = raw;
    if (isChat && raw.length) {
      try {
        const body = JSON.parse(raw.toString('utf8'));
        injectSignatures(body);
        outgoing = Buffer.from(JSON.stringify(body));
      } catch {
        // not JSON: forward unchanged
      }
    }

    const headers = { accept: req.headers.accept || 'application/json' };
    if (req.headers.authorization) headers.authorization = req.headers.authorization;
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? outgoing : undefined,
    });

    res.statusCode = upstream.status;
    const contentType = upstream.headers.get('content-type') || '';
    if (contentType) res.setHeader('content-type', contentType);

    if (!upstream.body) {
      res.end();
      return;
    }

    if (isChat && contentType.includes('text/event-stream')) {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let sawToolCalls = false;
      const emitLine = (line) => {
        let out = line;
        const json = parseSseData(line);
        if (json) {
          if (jsonHasToolCalls(json)) sawToolCalls = true;
          if (sawToolCalls && forceToolCallsFinish(json)) {
            out = 'data: ' + JSON.stringify(json);
          }
          captureFromJson(json);
        }
        res.write(out + '\n');
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = pending.indexOf('\n')) >= 0) {
          emitLine(pending.slice(0, idx));
          pending = pending.slice(idx + 1);
        }
      }
      if (pending) emitLine(pending);
      res.end();
      return;
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (isChat) {
      try {
        const json = JSON.parse(buf.toString('utf8'));
        captureFromJson(json);
        if (jsonHasToolCalls(json) && forceToolCallsFinish(json)) {
          res.end(Buffer.from(JSON.stringify(json)));
          return;
        }
      } catch {
        // ignore
      }
    }
    res.end(buf);
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('content-type', 'application/json');
    }
    res.end(JSON.stringify({ error: { message: 'gemini-sig-proxy upstream error', code: 502 } }));
  }
});

server.listen(PORT, () => {
  console.log(`[gemini-sig-proxy] listening on :${PORT}, upstream ${UPSTREAM}`);
});
