const STATE_TTL_MS = 10 * 60 * 1000;
// 下调超时以降低两次串行上游请求的总耗时，避免接近边缘函数平台的 wall-clock 上限
const FETCH_TIMEOUT_MS = 8000;

// 对上游请求设置超时，避免边缘函数挂起或超时报错
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 安全解析 JSON，上游返回 HTML/空内容时不抛异常
async function safeJson(resp) {
  const text = await resp.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    return { __raw: text, error: 'invalid_json_response' };
  }
}

export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const errorDescription = url.searchParams.get('error_description');

  // 皮肤站在授权失败/用户拒绝时会带 error 参数回调，应明确提示而不是报脚本错误
  if (error) {
    return new Response(JSON.stringify({
      error: 'OAuth 授权失败',
      error_code: error,
      error_description: errorDescription || '',
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!code || !state) {
    return new Response(JSON.stringify({ error: 'Missing code or state' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const stateData = await my_kv.get(`oauth:state:${state}`, 'json');
  await my_kv.delete(`oauth:state:${state}`);

  const now = Date.now();
  const states = await my_kv.get('index:oauth:states', 'json') || [];
  const expired = states.filter(s => s.key !== state && now - s.created > STATE_TTL_MS);
  // 批量清理过期 state
  await Promise.all(expired.map(s => my_kv.delete(`oauth:state:${s.key}`)));
  const updated = states.filter(s => s.key !== state && now - s.created <= STATE_TTL_MS);
  await my_kv.put('index:oauth:states', JSON.stringify(updated));

  if (!stateData) {
    return new Response(JSON.stringify({ error: 'Invalid or expired state' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const skinUrl = (env.BLESSING_SKIN_URL || 'https://skin.mc.ecustcic.com').replace(/\/+$/, '');

  const params = new URLSearchParams();
  params.set('grant_type', 'authorization_code');
  params.set('client_id', env.BLESSING_CLIENT_ID);
  params.set('client_secret', env.BLESSING_CLIENT_SECRET);
  params.set('redirect_uri', `${url.origin}/api/auth/callback`);
  params.set('code', code);

  let tokenResponse;
  try {
    tokenResponse = await fetchWithTimeout(`${skinUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: params.toString(),
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: '无法连接皮肤站换取令牌，请重试' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const tokenData = await safeJson(tokenResponse);
  if (!tokenResponse.ok || tokenData.error || !tokenData.access_token) {
    const upstreamErr = tokenData.error_description || tokenData.error;
    return new Response(JSON.stringify({
      // 上游返回非 JSON（HTML 错误页等）时，safeJson 会给出 invalid_json_response，
      // 这里用中文兜底，避免把内部占位符直接暴露给用户
      error: upstreamErr && upstreamErr !== 'invalid_json_response'
        ? upstreamErr
        : `皮肤站返回异常 (HTTP ${tokenResponse.status})`,
    }), {
      // 上游服务故障(5xx)映射为 502，凭证/参数类错误(4xx)保持 400
      status: tokenResponse.status >= 500 ? 502 : 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let userResponse;
  try {
    userResponse = await fetchWithTimeout(`${skinUrl}/api/user`, {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: '无法获取皮肤站用户信息，请重试' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const userData = await safeJson(userResponse);
  // 用空值判断而非 !userData.uid，避免 uid 为数字 0 时被误判为获取失败
  if (!userResponse.ok || userData.uid == null) {
    return new Response(JSON.stringify({ error: '皮肤站用户信息获取失败，请重试' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const adminList = await my_kv.get('config:admins', 'json') || [];
  const isAdmin = adminList.includes(String(userData.uid)) || userData.permission >= 1;

  const sessionId = crypto.randomUUID().replace(/-/g, '');
  const session = {
    uid: userData.uid,
    nickname: userData.nickname,
    email: userData.email || '',
    avatar: userData.avatar,
    permission: userData.permission,
    isAdmin,
    created: Date.now(),
  };
  await my_kv.put(`session:${sessionId}`, JSON.stringify(session));

  const redirectUri = stateData.redirect_uri || '/admin';

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${redirectUri}?token=${sessionId}`,
      'Set-Cookie': `session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`,
    },
  });
}
