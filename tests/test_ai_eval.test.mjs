import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const aiEvalModule = require('../api/ai-eval.js');
const { createHandler } = aiEvalModule;

const SECRET_DB_KEY = 'sk-secret-db-key-do-not-leak-999';
const SECRET_OVERRIDE_KEY = 'sk-override-test-key-777';

function createMockRes() {
  const headers = {};
  let bodyText = '';
  const res = {
    statusCode: 200,
    headers,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
    },
    getHeader(name) {
      return headers[String(name).toLowerCase()];
    },
    end(chunk = '') {
      bodyText += chunk ? String(chunk) : '';
    },
    get text() {
      return bodyText;
    },
    json() {
      return JSON.parse(bodyText || '{}');
    },
  };
  return res;
}

function createJsonReq({ method = 'POST', headers = {}, body = undefined, streamBody = false } = {}) {
  if (!streamBody) {
    return {
      method,
      headers,
      body,
    };
  }
  const jsonStr = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  const stream = Readable.from([Buffer.from(jsonStr, 'utf8')]);
  stream.method = method;
  stream.headers = headers;
  return stream;
}

function buildMockFetch({
  usersByToken = {},
  profilesById = {},
  globalSettings = {
    gemini_api_key: SECRET_DB_KEY,
    gemini_api_url: 'https://mock-llm.local/v1/chat/completions',
    gemini_model: 'gemini-3.8-flash',
  },
  upstreamReply = 'OK',
  upstreamContent = '{"score_total": 8.0}',
  upstreamStatus = 200,
  onUpstreamCall = null,
} = {}) {
  return async function mockFetch(url, options = {}) {
    const urlStr = String(url);

    if (urlStr.startsWith('https://supabase.local/auth/v1/user')) {
      const auth = options?.headers?.Authorization || options?.headers?.authorization || '';
      const token = auth.replace(/^Bearer\s+/i, '').trim();
      const user = usersByToken[token];
      if (!user) {
        return new Response(JSON.stringify({ msg: 'Invalid token' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(user), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (urlStr.startsWith('https://supabase.local/rest/v1/profiles')) {
      const parsed = new URL(urlStr);
      const idFilter = parsed.searchParams.get('id') || '';
      const uid = idFilter.replace(/^eq\./, '');
      const prof = profilesById[uid];
      return new Response(JSON.stringify(prof ? [prof] : []), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (urlStr.startsWith('https://supabase.local/rest/v1/global_settings')) {
      return new Response(JSON.stringify(globalSettings ? [globalSettings] : []), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (onUpstreamCall) {
      onUpstreamCall(urlStr, options);
    }

    if (upstreamStatus !== 200) {
      return new Response('Upstream error', { status: upstreamStatus });
    }

    const reqBody = JSON.parse(options.body || '{}');
    const isPing = reqBody.max_tokens === 10;
    return new Response(
      JSON.stringify({
        model: reqBody.model || 'gemini-3.8-flash',
        choices: [{ message: { content: isPing ? upstreamReply : upstreamContent } }],
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  };
}

const DEFAULT_USERS = {
  'tok-student': { id: 'stu-1', email: 'student@test.com' },
  'tok-teacher': { id: 'tea-1', email: 'teacher@test.com' },
  'tok-pending': { id: 'pen-1', email: 'pending@test.com' },
  'tok-suspended': { id: 'sus-1', email: 'suspended@test.com' },
  'tok-admin': { id: 'adm-1', email: 'admin@test.com' },
};

const DEFAULT_PROFILES = {
  'stu-1': { id: 'stu-1', role: 'student', status: 'active' },
  'tea-1': { id: 'tea-1', role: 'teacher', status: 'active' },
  'pen-1': { id: 'pen-1', role: 'teacher', status: 'pending' },
  'sus-1': { id: 'sus-1', role: 'student', status: 'suspended' },
  'adm-1': { id: 'adm-1', role: 'admin', status: 'active' },
};

const BASE_ENV = {
  SUPABASE_URL: 'https://supabase.local',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
};

function makeHandler(overrides = {}) {
  return createHandler({
    env: { ...BASE_ENV, ...(overrides.env || {}) },
    fetchImpl: buildMockFetch({
      usersByToken: DEFAULT_USERS,
      profilesById: DEFAULT_PROFILES,
      ...overrides,
    }),
  });
}

test('OPTIONS returns 204 with CORS and no-store headers', async () => {
  const handler = makeHandler();
  const req = createJsonReq({ method: 'OPTIONS' });
  const res = createMockRes();
  await handler(req, res);

  assert.equal(res.statusCode, 204);
  assert.equal(res.getHeader('access-control-allow-origin'), '*');
  assert.equal(res.getHeader('cache-control'), 'no-store');
});

test('Non-POST method returns 405', async () => {
  const handler = makeHandler();
  const req = createJsonReq({ method: 'GET' });
  const res = createMockRes();
  await handler(req, res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.json().success, false);
});

test('Missing Authorization header returns 401', async () => {
  const handler = makeHandler();
  const req = createJsonReq({ body: { action: 'eval_answer', messages: [{ role: 'user', content: 'hi' }] } });
  const res = createMockRes();
  await handler(req, res);

  assert.equal(res.statusCode, 401);
});

test('Invalid Supabase JWT returns 401', async () => {
  const handler = makeHandler();
  const req = createJsonReq({
    headers: { authorization: 'Bearer invalid-token' },
    body: { action: 'eval_answer', messages: [{ role: 'user', content: 'hi' }] },
  });
  const res = createMockRes();
  await handler(req, res);

  assert.equal(res.statusCode, 401);
});

test('Pending teacher receives 403 awaiting approval', async () => {
  const handler = makeHandler();
  const req = createJsonReq({
    headers: { authorization: 'Bearer tok-pending' },
    body: { action: 'eval_answer', messages: [{ role: 'user', content: 'hi' }] },
  });
  const res = createMockRes();
  await handler(req, res);

  assert.equal(res.statusCode, 403);
  assert.match(res.json().error, /phê duyệt/i);
});

test('Suspended account receives 403', async () => {
  const handler = makeHandler();
  const req = createJsonReq({
    headers: { authorization: 'Bearer tok-suspended' },
    body: { action: 'eval_answer', messages: [{ role: 'user', content: 'hi' }] },
  });
  const res = createMockRes();
  await handler(req, res);

  assert.equal(res.statusCode, 403);
  assert.match(res.json().error, /tạm khóa/i);
});

test('Student cannot call ping_test or eval_conversation (403)', async () => {
  const handler = makeHandler();

  const pingRes = createMockRes();
  await handler(
    createJsonReq({
      headers: { authorization: 'Bearer tok-student' },
      body: { action: 'ping_test' },
    }),
    pingRes,
  );
  assert.equal(pingRes.statusCode, 403);

  const convRes = createMockRes();
  await handler(
    createJsonReq({
      headers: { authorization: 'Bearer tok-student' },
      body: { action: 'eval_conversation', messages: [{ role: 'user', content: 'dialogue' }] },
    }),
    convRes,
  );
  assert.equal(convRes.statusCode, 403);
});

test('Teacher cannot call ping_test (403)', async () => {
  const handler = makeHandler();
  const res = createMockRes();
  await handler(
    createJsonReq({
      headers: { authorization: 'Bearer tok-teacher' },
      body: { action: 'ping_test' },
    }),
    res,
  );
  assert.equal(res.statusCode, 403);
});

test('Active student can call eval_answer using server key without key leakage', async () => {
  let seenAuth = '';
  let seenApiKey = '';
  let seenUrl = '';
  const handler = makeHandler({
    onUpstreamCall(url, opts) {
      seenUrl = url;
      seenAuth = opts?.headers?.Authorization || '';
      seenApiKey = opts?.headers?.['x-api-key'] || '';
    },
  });

  const req = createJsonReq({
    streamBody: true,
    headers: { authorization: 'Bearer tok-student' },
    body: {
      action: 'eval_answer',
      messages: [
        { role: 'system', content: 'Rubric' },
        { role: 'user', content: 'Evaluate my answer' },
      ],
      temperature: 0.2,
    },
  });
  const res = createMockRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.success, true);
  assert.equal(body.content, '{"score_total": 8.0}');
  assert.equal(seenUrl, 'https://mock-llm.local/v1/chat/completions');
  assert.equal(seenAuth, `Bearer ${SECRET_DB_KEY}`);
  assert.equal(seenApiKey, SECRET_DB_KEY);
  assert.equal(res.text.includes(SECRET_DB_KEY), false);
  assert.equal(JSON.stringify(res.headers).includes(SECRET_DB_KEY), false);
});

test('Active teacher can call eval_conversation', async () => {
  const handler = makeHandler();
  const res = createMockRes();
  await handler(
    createJsonReq({
      headers: { authorization: 'Bearer tok-teacher' },
      body: {
        action: 'eval_conversation',
        messages: [{ role: 'user', content: 'Evaluate 1-1 dialogue' }],
      },
    }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().success, true);
  assert.equal(res.text.includes(SECRET_DB_KEY), false);
});

test('Admin ping_test uses stored DB key when draftConfig.apiKey is empty', async () => {
  let usedKey = '';
  let usedUrl = '';
  let usedModel = '';
  const handler = makeHandler({
    onUpstreamCall(url, opts) {
      usedUrl = url;
      usedKey = opts?.headers?.['x-api-key'] || '';
      usedModel = JSON.parse(opts.body).model;
    },
  });

  const res = createMockRes();
  await handler(
    createJsonReq({
      headers: { authorization: 'Bearer tok-admin' },
      body: {
        action: 'ping_test',
        draftConfig: {
          apiKey: '',
          apiUrl: 'https://custom-endpoint.local/v1/chat/completions',
          model: 'gemini-custom-test',
        },
      },
    }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().success, true);
  assert.equal(res.json().reply, 'OK');
  assert.equal(usedKey, SECRET_DB_KEY);
  assert.equal(usedUrl, 'https://custom-endpoint.local/v1/chat/completions');
  assert.equal(usedModel, 'gemini-custom-test');
  assert.equal(res.text.includes(SECRET_DB_KEY), false);
});

test('Admin ping_test uses draftConfig.apiKey override when provided', async () => {
  let usedKey = '';
  const handler = makeHandler({
    onUpstreamCall(_url, opts) {
      usedKey = opts?.headers?.Authorization || '';
    },
  });

  const res = createMockRes();
  await handler(
    createJsonReq({
      headers: { authorization: 'Bearer tok-admin' },
      body: {
        action: 'ping_test',
        draftConfig: { apiKey: SECRET_OVERRIDE_KEY },
      },
    }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(usedKey, `Bearer ${SECRET_OVERRIDE_KEY}`);
  assert.equal(res.text.includes(SECRET_OVERRIDE_KEY), false);
});

test('Missing AI API key on eval_answer returns 503 AI_KEY_MISSING', async () => {
  const handler = makeHandler({
    globalSettings: {
      gemini_api_key: '',
      gemini_api_url: 'https://mock-llm.local/v1/chat/completions',
      gemini_model: 'gemini-3.8-flash',
    },
  });

  const res = createMockRes();
  await handler(
    createJsonReq({
      headers: { authorization: 'Bearer tok-student' },
      body: {
        action: 'eval_answer',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    }),
    res,
  );

  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, 'AI_KEY_MISSING');
});

test('Invalid message role or empty messages array returns 400', async () => {
  const handler = makeHandler();

  const emptyRes = createMockRes();
  await handler(
    createJsonReq({
      headers: { authorization: 'Bearer tok-student' },
      body: { action: 'eval_answer', messages: [] },
    }),
    emptyRes,
  );
  assert.equal(emptyRes.statusCode, 400);

  const badRoleRes = createMockRes();
  await handler(
    createJsonReq({
      headers: { authorization: 'Bearer tok-student' },
      body: { action: 'eval_answer', messages: [{ role: 'assistant', content: 'spoof' }] },
    }),
    badRoleRes,
  );
  assert.equal(badRoleRes.statusCode, 400);
});

