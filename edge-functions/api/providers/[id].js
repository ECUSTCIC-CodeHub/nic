export async function onRequestGet(context) {
  const session = await getSession(context.request);
  if (!session || !session.isAdmin) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { id } = context.params;
  const provider = await my_kv.get(`provider:${id}`, 'json');
  if (!provider) {
    return new Response(JSON.stringify({ error: 'Provider not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify(provider), {
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
  const existing = await my_kv.get(`provider:${id}`, 'json');
  if (!existing) {
    return new Response(JSON.stringify({ error: 'Provider not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = await context.request.json();
  const updated = {
    ...existing,
    name: body.name || existing.name,
    config: body.config || existing.config,
    updated: Date.now(),
  };

  await my_kv.put(`provider:${id}`, JSON.stringify(updated));

  const providers = await my_kv.get('index:providers', 'json') || [];
  const idx = providers.findIndex(p => p.id === id);
  if (idx >= 0) {
    providers[idx] = { id, type: updated.type, name: updated.name, created: updated.created };
    await my_kv.put('index:providers', JSON.stringify(providers));
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
  const existing = await my_kv.get(`provider:${id}`, 'json');
  if (!existing) {
    return new Response(JSON.stringify({ error: 'Provider not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 检查是否有关联域名
  const domains = await my_kv.get('index:domains', 'json') || [];
  const relatedDomains = domains.filter(d => d.provider_id === id);
  if (relatedDomains.length > 0) {
    return new Response(JSON.stringify({
      error: `该Provider下还有 ${relatedDomains.length} 个关联域名，请先删除关联域名`,
      domains: relatedDomains.map(d => ({ id: d.id, root_domain: d.root_domain })),
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  await my_kv.delete(`provider:${id}`);

  const providers = await my_kv.get('index:providers', 'json') || [];
  const filtered = providers.filter(p => p.id !== id);
  await my_kv.put('index:providers', JSON.stringify(filtered));

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
