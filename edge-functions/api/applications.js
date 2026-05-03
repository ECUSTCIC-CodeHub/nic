export async function onRequestGet(context) {
  const session = await getSession(context.request);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (session.isAdmin) {
    const applications = await my_kv.get('index:applications', 'json') || [];
    const valid = [];
    for (const a of applications) {
      const exists = await my_kv.get(`application:${a.id}`, 'json');
      if (exists) { valid.push(a); }
      else { continue; }
    }
    if (valid.length !== applications.length) {
      await my_kv.put('index:applications', JSON.stringify(valid));
    }
    return new Response(JSON.stringify({ applications: valid }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const allApps = await my_kv.get('index:applications', 'json') || [];
  const validApps = [];
  for (const a of allApps) {
    const exists = await my_kv.get(`application:${a.id}`, 'json');
    if (exists) { validApps.push(a); }
  }
  if (validApps.length !== allApps.length) {
    await my_kv.put('index:applications', JSON.stringify(validApps));
  }
  const myApps = validApps.filter(a => a.uid === session.uid);
  return new Response(JSON.stringify({ applications: myApps }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const { env, waitUntil } = context;
  const session = await getSession(context.request);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = await context.request.json();
  const { domain_id, subdomain, type, value, reason, proxied } = body;

  if (!domain_id || !subdomain || !type || !value) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const domain = await my_kv.get(`domain:${domain_id}`, 'json');
  if (!domain) {
    return new Response(JSON.stringify({ error: 'Domain not found' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const records = await my_kv.get(`index:records:${domain_id}`, 'json') || [];
  if (records.some(r => r.subdomain === subdomain && r.status === 'active')) {
    return new Response(JSON.stringify({ error: '该子域名已被使用' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const allApps = await my_kv.get('index:applications', 'json') || [];
  if (allApps.some(a => a.domain_id === domain_id && a.subdomain === subdomain && (a.status === 'pending' || a.status === 'approved'))) {
    return new Response(JSON.stringify({ error: '该子域名已被申请或使用' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const application = {
    id,
    domain_id,
    root_domain: domain.root_domain,
    subdomain,
    type: type.toUpperCase(),
    value,
    reason: reason || '',
    proxied: proxied || false,
    uid: session.uid,
    nickname: session.nickname,
    email: session.email || '',
    status: 'pending',
    created: Date.now(),
  };

  await my_kv.put(`application:${id}`, JSON.stringify(application));

  allApps.push(application);
  await my_kv.put('index:applications', JSON.stringify(allApps));

  // 使用 waitUntil 确保飞书异步调用在响应后仍能完成
  waitUntil(logToBitable(env, {
    '申请ID': id,
    '事件类型': '提交申请',
    '申请人': session.nickname,
    '申请人UID': String(session.uid),
    '申请人邮箱': session.email || '',
    '根域名': domain.root_domain,
    '子域名': subdomain,
    '记录类型': type.toUpperCase(),
    '记录值': value,
    '申请理由': reason || '',
    '代理': proxied ? '是' : '否',
    '操作人': session.nickname,
    '操作时间': new Date().toISOString(),
  }));

  return new Response(JSON.stringify(application), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ======================== 飞书多维表格 ========================

const FEISHU_API = 'https://open.feishu.cn/open-apis';
let feishuToken = null;
let feishuTokenExpires = 0;

async function getFeishuToken(env) {
  if (feishuToken && Date.now() < feishuTokenExpires - 60000) {
    return feishuToken;
  }
  const appId = env.FEISHU_APP_ID || '';
  const appSecret = env.FEISHU_APP_SECRET || '';
  if (!appId || !appSecret) return null;

  const resp = await fetch(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await resp.json();
  if (data.code !== 0) return null;
  feishuToken = data.tenant_access_token;
  feishuTokenExpires = Date.now() + (data.expire - 60) * 1000;
  return feishuToken;
}

async function logToBitable(env, fields) {
  const bitableId = env.FEISHU_BITABLE_ID || '';
  const tableId = env.FEISHU_TABLE_ID || '';
  if (!bitableId || !tableId) return;

  try {
    const token = await getFeishuToken(env);
    if (!token) return;

    await fetch(`${FEISHU_API}/bitable/v1/apps/${bitableId}/tables/${tableId}/records`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
    });
  } catch (e) {
    // 静默失败，不影响主流程
  }
}

// ======================== 会话管理 ========================

const SESSION_TTL = 86400000;

async function getSession(request) {
  const token = extractToken(request);
  if (!token) return null;
  const session = await my_kv.get(`session:${token}`, 'json');
  if (!session) return null;
  if (Date.now() - session.created > SESSION_TTL) {
    await my_kv.delete(`session:${token}`);
    return null;
  }
  return session;
}

function extractToken(request) {
  const auth = request.headers.get('Authorization');
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/session=([^;]+)/);
  return match ? match[1] : null;
}
