// Vercel Serverless Function: Secure AI Evaluator Proxy (/api/ai-eval)
// Keeps `global_settings.gemini_api_key` strictly server-side behind Supabase JWT + RBAC.

const DEFAULT_ENDPOINT = 'https://revidapi.com/v1/chat/completions';
const DEFAULT_MODEL = 'gemini-3.8-flash';

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
}

function sendJson(res, statusCode, payload) {
  setCorsHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    return req.body.trim() ? JSON.parse(req.body) : {};
  }
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function createHandler(deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const env = deps.env || process.env;

  return async function handler(req, res) {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      return sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
    }

    const supabaseUrl = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
    const supabaseAnonKey = String(env.SUPABASE_ANON_KEY || env.SUPABASE_KEY || '').trim();
    const serviceRoleKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

    if (!supabaseUrl || !supabaseAnonKey) {
      return sendJson(res, 500, {
        success: false,
        error: 'Thiếu cấu hình SUPABASE_URL hoặc SUPABASE_ANON_KEY trên server.',
      });
    }

    const authHeader = String(req.headers?.authorization || req.headers?.Authorization || '');
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    const jwt = match ? match[1].trim() : '';
    if (!jwt) {
      return sendJson(res, 401, {
        success: false,
        error: 'Thiếu token xác thực (Authorization Bearer JWT).',
      });
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { success: false, error: 'Payload JSON không hợp lệ.' });
    }

    const action = String(body?.action || '').trim();
    if (!['ping_test', 'eval_answer', 'eval_conversation'].includes(action)) {
      return sendJson(res, 400, { success: false, error: `Action không hợp lệ: ${action}` });
    }

    // 1. Verify Supabase JWT user identity
    let authUser;
    try {
      const userRes = await fetchImpl(`${supabaseUrl}/auth/v1/user`, {
        method: 'GET',
        headers: {
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${jwt}`,
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!userRes.ok) {
        return sendJson(res, 401, { success: false, error: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.' });
      }
      authUser = await userRes.json();
    } catch (err) {
      return sendJson(res, 502, { success: false, error: `Lỗi xác thực Supabase: ${err.message}` });
    }

    if (!authUser?.id) {
      return sendJson(res, 401, { success: false, error: 'Không xác định được danh tính người dùng.' });
    }

    // 2. Load caller profile (role + status) from Postgres
    const profileKey = serviceRoleKey || supabaseAnonKey;
    const profileBearer = serviceRoleKey || jwt;
    let profile;
    try {
      const profRes = await fetchImpl(
        `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(authUser.id)}&select=id,role,status&limit=1`,
        {
          method: 'GET',
          headers: {
            apikey: profileKey,
            Authorization: `Bearer ${profileBearer}`,
          },
          signal: AbortSignal.timeout(10000),
        }
      );
      if (!profRes.ok) {
        return sendJson(res, 403, { success: false, error: 'Không thể đọc hồ sơ phân quyền người dùng.' });
      }
      const rows = await profRes.json();
      profile = Array.isArray(rows) ? rows[0] : null;
    } catch (err) {
      return sendJson(res, 502, { success: false, error: `Lỗi kiểm tra hồ sơ người dùng: ${err.message}` });
    }

    if (!profile) {
      return sendJson(res, 403, { success: false, error: 'Hồ sơ tài khoản không tồn tại.' });
    }

    if (profile.status !== 'active') {
      return sendJson(res, 403, {
        success: false,
        error: profile.status === 'pending'
          ? 'Tài khoản đang chờ Quản trị viên phê duyệt.'
          : 'Tài khoản đang bị tạm khóa.',
      });
    }

    // 3. Enforce Action RBAC
    if (action === 'ping_test' && profile.role !== 'admin') {
      return sendJson(res, 403, { success: false, error: 'Chỉ Quản trị viên mới được phép kiểm tra kết nối AI.' });
    }
    if (action === 'eval_conversation' && !['teacher', 'admin'].includes(profile.role)) {
      return sendJson(res, 403, { success: false, error: 'Chỉ Giáo viên hoặc Quản trị viên mới được đánh giá hội thoại 1-1.' });
    }

    // 4. Load AI API Key & endpoint strictly server-side from global_settings (with env fallback)
    let storedSettings = null;
    const settingsBearer = serviceRoleKey || (profile.role === 'admin' ? jwt : '');
    const settingsApiKeyHeader = serviceRoleKey || supabaseAnonKey;

    if (settingsBearer) {
      try {
        const gsRes = await fetchImpl(
          `${supabaseUrl}/rest/v1/global_settings?id=eq.1&select=gemini_api_key,gemini_api_url,gemini_model&limit=1`,
          {
            method: 'GET',
            headers: {
              apikey: settingsApiKeyHeader,
              Authorization: `Bearer ${settingsBearer}`,
            },
            signal: AbortSignal.timeout(10000),
          }
        );
        if (gsRes.ok) {
          const gsRows = await gsRes.json();
          storedSettings = Array.isArray(gsRows) ? gsRows[0] : null;
        }
      } catch {
        // Non-fatal; fallback to environment config below
      }
    }

    const defaultEndpoint = String(
      storedSettings?.gemini_api_url || env.DEFAULT_GEMINI_ENDPOINT || DEFAULT_ENDPOINT
    ).trim();
    const defaultModel = String(
      storedSettings?.gemini_model || env.DEFAULT_GEMINI_MODEL || DEFAULT_MODEL
    ).trim();
    const storedApiKey = String(
      storedSettings?.gemini_api_key || env.GEMINI_API_KEY || ''
    ).trim();

    if (action === 'ping_test') {
      const draft = body?.draftConfig && typeof body.draftConfig === 'object' ? body.draftConfig : {};
      const testKey = String(draft.apiKey || storedApiKey || '').trim();
      const testUrl = String(draft.apiUrl || defaultEndpoint).trim();
      const testModel = String(draft.model || defaultModel).trim();

      if (!testKey) {
        return sendJson(res, 400, { success: false, error: 'Chưa có AI API Key để kiểm tra.' });
      }

      try {
        const aiRes = await fetchImpl(testUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${testKey}`,
            'x-api-key': testKey,
          },
          body: JSON.stringify({
            model: testModel,
            messages: [{ role: 'user', content: 'Ping test. Reply with "OK".' }],
            max_tokens: 10,
          }),
          signal: AbortSignal.timeout(20000),
        });
        if (!aiRes.ok) {
          const errText = await aiRes.text().catch(() => '');
          return sendJson(res, 502, {
            success: false,
            error: `API Lỗi HTTP ${aiRes.status}: ${errText.slice(0, 200) || aiRes.statusText}`,
          });
        }
        const data = await aiRes.json();
        return sendJson(res, 200, {
          success: true,
          model: data?.model || testModel,
          reply: String(data?.choices?.[0]?.message?.content || '').trim(),
        });
      } catch (err) {
        return sendJson(res, 502, { success: false, error: `Không kết nối được AI API: ${err.message}` });
      }
    }

    // 5. Handle eval_answer / eval_conversation
    if (!storedApiKey) {
      return sendJson(res, 503, {
        success: false,
        code: 'AI_KEY_MISSING',
        error: 'Chưa cấu hình AI API Key trên hệ thống.',
      });
    }

    const rawMessages = body?.messages;
    if (!Array.isArray(rawMessages) || rawMessages.length < 1 || rawMessages.length > 2) {
      return sendJson(res, 400, { success: false, error: 'Danh sách messages không hợp lệ (chỉ chấp nhận 1-2 messages).' });
    }

    const safeMessages = [];
    for (const msg of rawMessages) {
      if (!msg || !['system', 'user'].includes(msg.role) || msg.content == null) {
        return sendJson(res, 400, { success: false, error: 'Cấu trúc message không hợp lệ.' });
      }
      safeMessages.push({ role: msg.role, content: msg.content });
    }

    const temperatureRaw = Number(body?.temperature);
    const temperature = Number.isFinite(temperatureRaw) ? Math.min(1, Math.max(0, temperatureRaw)) : 0.2;

    try {
      const upstreamRes = await fetchImpl(defaultEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${storedApiKey}`,
          'x-api-key': storedApiKey,
        },
        body: JSON.stringify({
          model: defaultModel,
          messages: safeMessages,
          temperature,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!upstreamRes.ok) {
        const errText = await upstreamRes.text().catch(() => '');
        return sendJson(res, 502, {
          success: false,
          error: `Upstream AI API HTTP ${upstreamRes.status}: ${errText.slice(0, 200)}`,
        });
      }

      const data = await upstreamRes.json();
      const content = String(data?.choices?.[0]?.message?.content || '');
      return sendJson(res, 200, {
        success: true,
        content,
        model: data?.model || defaultModel,
      });
    } catch (err) {
      return sendJson(res, 502, {
        success: false,
        error: `Lỗi gọi Upstream AI API: ${err.message}`,
      });
    }
  };
}

const defaultHandler = createHandler();
defaultHandler.createHandler = createHandler;
module.exports = defaultHandler;

