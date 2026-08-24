// state 有效期放宽到 30 分钟：用户在皮肤站授权页停留时间可能较长，
// 10 分钟太短容易误判为“Invalid or expired state”。
const STATE_TTL_MS = 30 * 60 * 1000;
const PENDING_TTL_MS = 60 * 1000;

// 轻量回调：只做 state 校验 + 存证，不做任何出站网络请求。
// 真正“换令牌 + 取用户 + 建会话”的耗时逻辑拆分到 /api/auth/complete 分步轮询执行，
// 让每次边缘函数调用最多只承担一次出站请求，避免单次调用同时背负两次串行 fetch
// 而超过 EdgeOne 边缘函数预算被掐断（表现为 “Error return from script”）。
export async function onRequestGet(context) {
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

  // 校验 state。注意：这里不再一读就 delete，而是把消费动作放到最后成功创建 pending 之后，
  // 避免边缘函数中途被 545 终止导致重试时 state 已被提前消费，进而误报 “Invalid or expired state”。
  const stateData = await my_kv.get(`oauth:state:${state}`, 'json');
  const now = Date.now();
  if (!stateData || now - stateData.created > STATE_TTL_MS) {
    if (stateData) await my_kv.delete(`oauth:state:${state}`);
    // state 失效时不再直接返回裸 JSON，而是重定向到首页（SPA 会展示登录页），
    // 避免用户在浏览器看到一串难懂的报错文案。
    return Response.redirect(new URL('/', url.origin).toString(), 302);
  }

  // 纵深防御：与 login.js 一致的开放重定向防护，仅允许站内相对路径
  const rawRedirect = stateData.redirect_uri || '/';
  const redirectUri = rawRedirect.startsWith('/')
    && !rawRedirect.startsWith('//')
    && !/^\/[^/]*:/.test(rawRedirect)
    ? rawRedirect
    : '/';

  // 把授权码存为待处理任务，前端再通过 /api/auth/complete 分步轮询取回结果
  const pid = crypto.randomUUID().replace(/-/g, '');
  await my_kv.put(`pending:${pid}`, JSON.stringify({
    code,
    redirect_uri: redirectUri,
    step: 'token',
    created: now,
  }));

  // 最后才消费 state：pending 已成功创建后再删除，
  // 缩小“已删除但 pending 未建好”的失败窗口（避免边缘函数重试时误报 Invalid state）。
  await my_kv.delete(`oauth:state:${state}`);

  const sep = redirectUri.includes('?') ? '&' : '?';
  return new Response(null, {
    status: 302,
    headers: { Location: `${redirectUri}${sep}auth=pending&id=${pid}` },
  });
}
