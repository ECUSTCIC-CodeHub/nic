export async function onRequestGet(context) {
  const session = await getSession(context.request);
  if (!session || !session.isAdmin) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { id } = context.params;
  const subdomain = new URL(context.request.url).searchParams.get('subdomain');

  if (!subdomain) {
    return new Response(JSON.stringify({ error: 'Missing subdomain' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const domain = await my_kv.get(`domain:${id}`, 'json');
  if (!domain) {
    return new Response(JSON.stringify({ error: 'Domain not found' }), {
      status: 404,
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

  try {
    const records = await lookupDNSRecords(provider, domain, subdomain);
    return new Response(JSON.stringify({ domain: domain.root_domain, subdomain, records }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ domain: domain.root_domain, subdomain, records: [], error: e.message }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function lookupDNSRecords(provider, domain, subdomain) {
  if (provider.type === 'cloudflare') {
    const zoneId = provider.config.zone_id;
    const apiToken = provider.config.api_token;
    const name = subdomain === '@' ? domain.root_domain : `${subdomain}.${domain.root_domain}`;

    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`,
      {
        headers: {
          Authorization: `Bearer ${apiToken}`,
        },
      }
    );

    const data = await resp.json();
    if (!data.success) {
      throw new Error(data.errors?.[0]?.message || 'Cloudflare API error');
    }

    return data.result.map(r => ({
      id: r.id,
      type: r.type,
      name: r.name,
      value: r.content,
      ttl: r.ttl === 1 ? 'Auto' : r.ttl,
      proxied: r.proxied || false,
    }));
  }

  if (provider.type === 'dnspod') {
    const result = await callDNSPod(provider, 'DescribeRecordList', {
      Domain: domain.root_domain,
      SubDomain: subdomain === '@' ? '@' : subdomain,
    });

    const list = result.RecordList || [];
    return list.map(r => ({
      id: String(r.RecordId),
      type: r.Type,
      name: `${r.SubDomain === '@' ? '' : r.SubDomain + '.'}${domain.root_domain}`,
      value: r.Value,
      ttl: r.TTL,
      proxied: false,
    }));
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
