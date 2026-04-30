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

  const records = await my_kv.get(`index:records:${id}`, 'json') || [];

  return new Response(JSON.stringify({ records }), {
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

  const { id } = context.params;
  const domain = await my_kv.get(`domain:${id}`, 'json');
  if (!domain) {
    return new Response(JSON.stringify({ error: 'Domain not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = await context.request.json();
  const { subdomain, type, value, ttl, proxied } = body;

  if (!subdomain || !type || !value) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const provider = await my_kv.get(`provider:${domain.provider_id}`, 'json');
  if (!provider) {
    return new Response(JSON.stringify({ error: 'Provider not found' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const recordId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const record = {
    id: recordId,
    domain_id: id,
    subdomain,
    type: type.toUpperCase(),
    value,
    ttl: ttl || 600,
    proxied: proxied || false,
    status: 'pending',
    remote_id: null,
    created: Date.now(),
  };

  try {
    const result = await createDNSRecord(provider, domain, record);
    record.remote_id = result.id;
    record.status = 'active';
  } catch (e) {
    return new Response(JSON.stringify({ error: 'DNS记录创建失败: ' + e.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  await my_kv.put(`record:${id}:${recordId}`, JSON.stringify(record));

  const records = await my_kv.get(`index:records:${id}`, 'json') || [];
  records.push({ id: recordId, domain_id: id, subdomain, type: record.type, value, ttl: record.ttl, proxied: record.proxied, status: record.status, created: record.created });
  await my_kv.put(`index:records:${id}`, JSON.stringify(records));

  return new Response(JSON.stringify(record), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function createDNSRecord(provider, domain, record) {
  const fullRecord = `${record.subdomain}.${domain.root_domain}`;

  if (provider.type === 'cloudflare') {
    const zoneId = provider.config.zone_id;
    const apiToken = provider.config.api_token;

    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: record.type,
          name: record.subdomain === '@' ? domain.root_domain : fullRecord,
          content: record.value,
          ttl: record.proxied ? 1 : record.ttl,
          proxied: record.proxied,
        }),
      }
    );

    const data = await resp.json();
    if (!data.success) {
      throw new Error(data.errors?.[0]?.message || 'Cloudflare API error');
    }
    return { id: data.result.id };
  }

  if (provider.type === 'dnspod') {
    const result = await callDNSPod(provider, 'CreateRecord', {
      Domain: domain.root_domain,
      SubDomain: record.subdomain === '@' ? '@' : record.subdomain,
      RecordType: record.type,
      Value: record.value,
      RecordLine: '默认',
      TTL: record.ttl,
    });
    return { id: String(result.RecordId || '') };
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
