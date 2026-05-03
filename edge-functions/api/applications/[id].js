export async function onRequestGet(context) {
  const session = await getSession(context.request);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { id } = context.params;
  const application = await my_kv.get(`application:${id}`, 'json');
  if (!application) {
    return new Response(JSON.stringify({ error: 'Application not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!session.isAdmin && application.uid !== session.uid) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify(application), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const { env, waitUntil } = context;
  const session = await getSession(context.request);
  if (!session || !session.isAdmin) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { id } = context.params;
  const application = await my_kv.get(`application:${id}`, 'json');
  if (!application) {
    return new Response(JSON.stringify({ error: 'Application not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (application.status !== 'pending') {
    return new Response(JSON.stringify({ error: 'Application already processed' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = await context.request.json();
  const action = body.action;

  if (!['approve', 'reject'].includes(action)) {
    return new Response(JSON.stringify({ error: 'Invalid action' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const now = Date.now();

  if (action === 'approve') {
    const domain = await my_kv.get(`domain:${application.domain_id}`, 'json');
    if (!domain) {
      return new Response(JSON.stringify({ error: 'Domain not found' }), {
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
      domain_id: application.domain_id,
      subdomain: application.subdomain,
      type: application.type,
      value: application.value,
      ttl: application.proxied ? 1 : 600,
      proxied: application.proxied || false,
      status: 'pending',
      remote_id: null,
      created: Date.now(),
      application_id: id,
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

    await my_kv.put(`record:${application.domain_id}:${recordId}`, JSON.stringify(record));

    const records = await my_kv.get(`index:records:${application.domain_id}`, 'json') || [];
    records.push({ id: recordId, domain_id: application.domain_id, subdomain: application.subdomain, type: application.type, value: application.value, ttl: record.ttl, proxied: record.proxied, status: record.status, created: record.created });
    await my_kv.put(`index:records:${application.domain_id}`, JSON.stringify(records));

    application.status = 'approved';
    application.record_id = recordId;
    application.reviewed_at = now;
    application.reviewed_by = session.uid;

    waitUntil(logToBitable(env, {
      '申请ID': id,
      '事件类型': '审批通过',
      '申请人': application.nickname,
      '申请人UID': String(application.uid),
      '申请人邮箱': application.email || '',
      '根域名': application.root_domain,
      '子域名': application.subdomain,
      '记录类型': application.type,
      '记录值': application.value,
      '申请理由': application.reason || '',
      '代理': application.proxied ? '是' : '否',
      '操作人': session.nickname,
      '拒绝原因': '',
      '操作时间': new Date(now).toISOString(),
    }));
  } else {
    application.status = 'rejected';
    application.reviewed_at = now;
    application.reviewed_by = session.uid;
    application.reject_reason = body.reason || '';

    waitUntil(logToBitable(env, {
      '申请ID': id,
      '事件类型': '审批拒绝',
      '申请人': application.nickname,
      '申请人UID': String(application.uid),
      '申请人邮箱': application.email || '',
      '根域名': application.root_domain,
      '子域名': application.subdomain,
      '记录类型': application.type,
      '记录值': application.value,
      '申请理由': application.reason || '',
      '代理': application.proxied ? '是' : '否',
      '操作人': session.nickname,
      '拒绝原因': body.reason || '',
      '操作时间': new Date(now).toISOString(),
    }));
  }

  await my_kv.put(`application:${id}`, JSON.stringify(application));

  const allApps = await my_kv.get('index:applications', 'json') || [];
  const idx = allApps.findIndex(a => a.id === id);
  if (idx >= 0) {
    allApps[idx] = application;
    await my_kv.put('index:applications', JSON.stringify(allApps));
  }

  return new Response(JSON.stringify(application), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestDelete(context) {
  const { env, waitUntil } = context;
  const session = await getSession(context.request);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { id } = context.params;
  const application = await my_kv.get(`application:${id}`, 'json');

  if (application) {
    if (!session.isAdmin && application.uid !== session.uid) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (application.status === 'approved' && application.record_id) {
      const domain = await my_kv.get(`domain:${application.domain_id}`, 'json');
      if (domain) {
        const existing = await my_kv.get(`record:${application.domain_id}:${application.record_id}`, 'json');
        if (existing && existing.remote_id) {
          const provider = await my_kv.get(`provider:${domain.provider_id}`, 'json');
          if (provider) {
            try {
              await deleteDNSRecord(provider, domain, existing);
            } catch (e) {
              return new Response(JSON.stringify({ error: 'DNS记录删除失败: ' + e.message }), {
                status: 502,
                headers: { 'Content-Type': 'application/json' },
              });
            }
          }
        }
        await my_kv.delete(`record:${application.domain_id}:${application.record_id}`);
        const records = await my_kv.get(`index:records:${application.domain_id}`, 'json') || [];
        const filtered = records.filter(r => r.id !== application.record_id);
        await my_kv.put(`index:records:${application.domain_id}`, JSON.stringify(filtered));
      }
    }

    waitUntil(logToBitable(env, {
      '申请ID': id,
      '事件类型': '删除记录',
      '申请人': application.nickname,
      '申请人UID': String(application.uid),
      '申请人邮箱': application.email || '',
      '根域名': application.root_domain,
      '子域名': application.subdomain,
      '记录类型': application.type,
      '记录值': application.value,
      '申请理由': application.reason || '',
      '代理': application.proxied ? '是' : '否',
      '操作人': session.nickname,
      '拒绝原因': application.reject_reason || '',
      '操作时间': new Date().toISOString(),
    }));

    await my_kv.delete(`application:${id}`);
  }

  const allApps = await my_kv.get('index:applications', 'json') || [];
  const filtered = allApps.filter(a => a.id !== id);
  await my_kv.put('index:applications', JSON.stringify(filtered));

  return new Response(JSON.stringify({ success: true }), {
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

// ======================== DNS API 工具 ========================

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

async function deleteDNSRecord(provider, domain, record) {
  if (provider.type === 'cloudflare') {
    const zoneId = provider.config.zone_id;
    const apiToken = provider.config.api_token;

    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${record.remote_id}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${apiToken}`,
        },
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
