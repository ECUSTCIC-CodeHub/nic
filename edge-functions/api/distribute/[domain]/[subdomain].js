export async function onRequestGet(context) {
  const { domain: rootDomain, subdomain } = context.params;

  const domains = await my_kv.get('index:domains', 'json') || [];
  const domain = domains.find(d => d.root_domain === rootDomain);
  if (!domain) {
    return new Response(JSON.stringify({ error: 'Domain not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const records = await my_kv.get(`index:records:${domain.id}`, 'json') || [];
  const sub = subdomain === '_' ? '@' : subdomain;
  const matched = records.filter(r => r.subdomain === sub && r.status === 'active');

  if (matched.length === 0) {
    return new Response(JSON.stringify({ error: 'No records found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({
    domain: rootDomain,
    subdomain: sub,
    records: matched.map(r => ({
      type: r.type,
      value: r.value,
      ttl: r.ttl,
      proxied: r.proxied,
    })),
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
