const PENDING_TTL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

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

// 分步轮询完成 OAuth：把“换令牌 + 取用户”拆成两次独立调用，
// 每次边缘函数调用最多只发一次出站请求，且各步骤幂等可重试，
// 从而显著降低单次调用超过 EdgeOne 预算被掐断的概率。
export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const pid = url.searchParams.get('id');
  if (!pid) {
    return new Response(JSON.stringify({ error: 'Missing pending id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 兜底：把整个处理逻辑包在 try/catch 里。边缘函数任何未捕获异常都会表现为
  // “Error return from script”(545)，这里统一转成可重试的 202，让前端轮询重试而非直接判死。
  try {
    const pending = await my_kv.get(`pending:${pid}`, 'json');
    if (!pending || Date.now() - pending.created > PENDING_TTL_MS) {
      await my_kv.delete(`pending:${pid}`);
      await my_kv.delete(`token:${pid}`);
      return new Response(JSON.stringify({ error: '登录会话已过期，请重新登录', expired: true }), {
        status: 410,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const skinUrl = (env.BLESSING_SKIN_URL || 'https://skin.mc.ecustcic.com').replace(/\/+$/, '');

    // ---------- 阶段一：用授权码换取令牌（最多一次出站请求） ----------
    if (pending.step === 'token') {
      // 幂等：若上次已成功换到令牌但更新 pending 失败，直接进入 user 阶段，避免重复消费一次性 code
      const existing = await my_kv.get(`token:${pid}`);
      if (existing) {
        pending.step = 'user';
        await my_kv.put(`pending:${pid}`, JSON.stringify(pending));
        return new Response(JSON.stringify({ status: 'pending' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const params = new URLSearchParams();
      params.set('grant_type', 'authorization_code');
      params.set('client_id', env.BLESSING_CLIENT_ID);
      params.set('client_secret', env.BLESSING_CLIENT_SECRET);
      params.set('redirect_uri', `${url.origin}/api/auth/callback`);
      params.set('code', pending.code);

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
        // 超时/网络中断：此时无法确定皮肤站是否已消费一次性授权码，
        // 若贸然用同一 code 重试会得到 4xx 确定性错误，导致登录必然失败。
        // 因此不再返回 202 重试，而是直接清理状态并让用户重新发起登录。
        await my_kv.delete(`pending:${pid}`);
        await my_kv.delete(`token:${pid}`);
        return new Response(JSON.stringify({ error: '连接皮肤站超时，请重新登录' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const tokenData = await safeJson(tokenResponse);
      if (!tokenResponse.ok || tokenData.error || !tokenData.access_token) {
        const upstreamErr = tokenData.error_description || tokenData.error;
        const msg = upstreamErr && upstreamErr !== 'invalid_json_response'
          ? upstreamErr
          : `皮肤站返回异常 (HTTP ${tokenResponse.status})`;
        // 上游 5xx 视为临时故障，返回 202 让前端重试；4xx 是确定性错误，直接返回
        const isTransient = tokenResponse.status >= 500;
        if (!isTransient) {
          // 确定性错误：授权码已消费，重试无法成功，清理状态并让用户重新登录
          await my_kv.delete(`pending:${pid}`);
          await my_kv.delete(`token:${pid}`);
        }
        return new Response(JSON.stringify({
          error: msg,
          ...(isTransient ? { status: 'pending', retry: true } : {}),
        }), {
          status: isTransient ? 202 : 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // 先持久化令牌（幂等），再推进到 user 阶段
      await my_kv.put(`token:${pid}`, tokenData.access_token);
      pending.step = 'user';
      await my_kv.put(`pending:${pid}`, JSON.stringify(pending));
      return new Response(JSON.stringify({ status: 'pending' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ---------- 阶段二：获取用户信息并建立会话（最多一次出站请求） ----------
    if (pending.step === 'user') {
      const accessToken = await my_kv.get(`token:${pid}`);
      if (!accessToken) {
        // 令牌丢失，回退到 token 阶段重新换取
        pending.step = 'token';
        await my_kv.put(`pending:${pid}`, JSON.stringify(pending));
        return new Response(JSON.stringify({ status: 'pending' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      let userResponse;
      try {
        userResponse = await fetchWithTimeout(`${skinUrl}/api/user`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
      } catch (e) {
        return new Response(JSON.stringify({ status: 'pending', retry: true }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const userData = await safeJson(userResponse);
      if (!userResponse.ok || userData.uid == null) {
        const isTransient = userResponse.status >= 500;
        if (!isTransient) {
          // 确定性错误：用户信息获取失败（如 token 失效），清理状态避免残留
          await my_kv.delete(`pending:${pid}`);
          await my_kv.delete(`token:${pid}`);
        }
        return new Response(JSON.stringify({
          error: '皮肤站用户信息获取失败，请重试',
          ...(isTransient ? { status: 'pending', retry: true } : {}),
        }), {
          status: isTransient ? 202 : 400,
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
      await my_kv.delete(`pending:${pid}`);
      await my_kv.delete(`token:${pid}`);

      return new Response(JSON.stringify({ token: sessionId, redirect_uri: pending.redirect_uri || '/' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': `session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`,
        },
      });
    }

    return new Response(JSON.stringify({ error: '未知状态' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    // 未预期的内部错误：转成可重试的 202，避免暴露 545 / 内部错误导致登录失败。
    // 记录堆栈便于后续排查（如 env 未配置、KV 持续失败等确定性根因）。
    console.error('[complete] unexpected error:', e);
    return new Response(JSON.stringify({ status: 'pending', retry: true }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
