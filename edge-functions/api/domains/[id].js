export async function onRequestGet(context) {
  const session = await getSession(context.request);
  if (!session || !session.isAdmin) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { id } = context.params;
  const domain = await my_kv.get(`domain:${id}`, 'json');
  if (!domain) {
    return new Response(JSON.stringify({ error: 'Domain not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify(domain), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPut(context) {
  const session = await getSession(context.request);
  if (!session || !session.isAdmin) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { id } = context.params;
  const existing = await my_kv.get(`domain:${id}`, 'json');
  if (!existing) {
    return new Response(JSON.stringify({ error: 'Domain not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = await context.request.json();
  const updated = {
    ...existing,
    root_domain: body.root_domain || existing.root_domain,
    provider_id: body.provider_id || existing.provider_id,
    description: body.description !== undefined ? body.description : existing.description,
    updated: Date.now(),
  };

  await my_kv.put(`domain:${id}`, JSON.stringify(updated));

  const domains = await my_kv.get('index:domains', 'json') || [];
  const idx = domains.findIndex(d => d.id === id);
  if (idx >= 0) {
    domains[idx] = { id, root_domain: updated.root_domain, provider_id: updated.provider_id, description: updated.description, created: updated.created };
    await my_kv.put('index:domains', JSON.stringify(domains));
  }

  return new Response(JSON.stringify(updated), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestDelete(context) {
  const session = await getSession(context.request);
  if (!session || !session.isAdmin) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { id } = context.params;
  const existing = await my_kv.get(`domain:${id}`, 'json');
  if (!existing) {
    return new Response(JSON.stringify({ error: 'Domain not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  await my_kv.delete(`domain:${id}`);

  const domains = await my_kv.get('index:domains', 'json') || [];
  const filtered = domains.filter(d => d.id !== id);
  await my_kv.put('index:domains', JSON.stringify(filtered));

  const records = await my_kv.get(`index:records:${id}`, 'json') || [];
  for (const r of records) {
    await my_kv.delete(`record:${id}:${r.id}`);
  }
  await my_kv.delete(`index:records:${id}`);

  return new Response(JSON.stringify({ success: true }), {
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
