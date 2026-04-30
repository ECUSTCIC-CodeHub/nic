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

  return new Response(JSON.stringify(application), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
}

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
