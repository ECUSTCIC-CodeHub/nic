export async function onRequestGet(context) {
  const session = await getSession(context.request);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const domains = await my_kv.get('index:domains', 'json') || [];

  return new Response(JSON.stringify({ domains }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const session = await getSession(context.request);
  if (!session || !session.isAdmin) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = await context.request.json();
  const { root_domain, provider_id, description } = body;

  if (!root_domain || !provider_id) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const provider = await my_kv.get(`provider:${provider_id}`, 'json');
  if (!provider) {
    return new Response(JSON.stringify({ error: 'Provider not found' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const domain = {
    id,
    root_domain,
    provider_id,
    description: description || '',
    created: Date.now(),
  };

  await my_kv.put(`domain:${id}`, JSON.stringify(domain));

  const domains = await my_kv.get('index:domains', 'json') || [];
  domains.push({ id, root_domain, provider_id, description: domain.description, created: domain.created });
  await my_kv.put('index:domains', JSON.stringify(domains));

  return new Response(JSON.stringify(domain), {
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
