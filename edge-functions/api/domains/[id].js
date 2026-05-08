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

  // 清理该域名下所有记录（包括远端 DNS 记录）
  const provider = await my_kv.get(`provider:${existing.provider_id}`, 'json');
  const records = await my_kv.get(`index:records:${id}`, 'json') || [];
  const deleteErrors = [];
  for (const r of records) {
    const record = await my_kv.get(`record:${id}:${r.id}`, 'json');
    if (record && record.remote_id && provider) {
      try {
        await deleteDNSRecord(provider, existing, record);
      } catch (e) {
        deleteErrors.push(`记录 ${r.subdomain}: ${e.message}`);
      }
    }
    await my_kv.delete(`record:${id}:${r.id}`);
  }
  await my_kv.delete(`index:records:${id}`);

  if (deleteErrors.length > 0) {
    // 远端 DNS 删除部分失败，但 KV 数据已清理，返回警告
    return new Response(JSON.stringify({
      warning: '部分远端DNS记录删除失败',
      errors: deleteErrors,
    }), {
      status: 207,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 清理关联的已审批申请（仅删除 KV 数据，不再尝试删远端 DNS 因为上面已处理）
  const allApps = await my_kv.get('index:applications', 'json') || [];
  const relatedApps = allApps.filter(a => a.domain_id === id);
  for (const app of relatedApps) {
    await my_kv.delete(`application:${app.id}`);
  }
  const remainingApps = allApps.filter(a => a.domain_id !== id);
  await my_kv.put('index:applications', JSON.stringify(remainingApps));

  await my_kv.delete(`domain:${id}`);

  const domains = await my_kv.get('index:domains', 'json') || [];
  const filtered = domains.filter(d => d.id !== id);
  await my_kv.put('index:domains', JSON.stringify(filtered));

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function deleteDNSRecord(provider, domain, record) {
  if (provider.type === 'cloudflare') {
    const zoneId = provider.config.zone_id;
    const apiToken = provider.config.api_token;
    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${record.remote_id}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${apiToken}` },
      }
    );
    const data = await resp.json();
    if (!data.success) {
      throw new Error(data.errors?.[0]?.message || 'Cloudflare API error');
    }
    return;
  }

  if (provider.type === 'dnspod') {
    await callDNSPod(provider, 'DeleteRecord', {
      Domain: domain.root_domain,
      RecordId: parseInt(record.remote_id) || record.remote_id,
    });
    return;
  }

  throw new Error('Unknown provider type');
}

const DNSPOD_HOST = 'dnspod.tencentcloudapi.com';
const DNSPOD_SERVICE = 'dnspod';
const DNSPOD_VERSION = '2021-03-23';

async function callDNSPod(provider, action, params) {
  const secretId = provider.config.secret_id;
  const secretKey = provider.config.secret_key;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const body = JSON.stringify(params);
  const authorization = await generateTC3Auth(secretId, secretKey, timestamp, 'POST', DNSPOD_HOST, DNSPOD_SERVICE, body);
  const resp = await fetch(`https://${DNSPOD_HOST}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Host': DNSPOD_HOST,
      'X-TC-Action': action,
      'X-TC-Version': DNSPOD_VERSION,
      'X-TC-Timestamp': timestamp,
      'X-TC-Nonce': nonce,
      'Authorization': authorization,
    },
    body,
  });
  const data = await resp.json();
  if (data.Response?.Error) {
    throw new Error(data.Response.Error.Message || 'DNSPod API error');
  }
  return data.Response;
}

async function generateTC3Auth(secretId, secretKey, timestamp, method, host, service, body) {
  const date = new Date(parseInt(timestamp) * 1000).toISOString().split('T')[0];
  const payloadHash = await sha256Hex(body || '');
  const canonicalHeaders = `content-type:application/json\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = [method, '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', timestamp, credentialScope, await sha256Hex(canonicalRequest)].join('\n');
  const dateKey = await hmacSha256(`TC3${secretKey}`, date);
  const serviceKey = await hmacSha256(dateKey, service);
  const signingKey = await hmacSha256(serviceKey, 'tc3_request');
  const signature = await hmacSha256Hex(signingKey, stringToSign);
  return `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

async function sha256Hex(data) {
  const encoded = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(key, data) {
  const keyBuffer = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey('raw', keyBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  return sig;
}

async function hmacSha256Hex(key, data) {
  const sig = await hmacSha256(key, data);
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
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
