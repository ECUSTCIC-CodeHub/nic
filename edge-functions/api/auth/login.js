const STATE_TTL_MS = 10 * 60 * 1000;

export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const redirectUri = url.searchParams.get('redirect_uri') || '';
  const state = crypto.randomUUID().replace(/-/g, '');

  const now = Date.now();
  const stateData = JSON.stringify({
    redirect_uri: redirectUri,
    created: now,
  });
  // 只写入单个 state 键；过期校验在 callback 里按 created 时间内联判断，
  // 不再维护全局 index 数组，减少每次登录/回调的 KV 与 CPU 开销（边缘函数预算有限）
  await my_kv.put(`oauth:state:${state}`, stateData);

  const skinUrl = (env.BLESSING_SKIN_URL || 'https://skin.mc.ecustcic.com').replace(/\/+$/, '');
  const authUrl = new URL(`${skinUrl}/oauth/authorize`);
  authUrl.searchParams.set('client_id', env.BLESSING_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', `${url.origin}/api/auth/callback`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', '');
  authUrl.searchParams.set('state', state);

  return Response.redirect(authUrl.toString(), 302);
}
