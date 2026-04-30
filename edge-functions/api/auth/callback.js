export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    return new Response(JSON.stringify({ error: 'Missing code or state' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const stateData = await my_kv.get(`oauth:state:${state}`, 'json');
  await my_kv.delete(`oauth:state:${state}`);

  const STATE_TTL_MS = 10 * 60 * 1000;
  const now = Date.now();
  const states = await my_kv.get('index:oauth:states', 'json') || [];
  const expired = states.filter(s => now - s.created > STATE_TTL_MS);
  for (const s of expired) {
    await my_kv.delete(`oauth:state:${s.key}`);
  }
  const updated = states.filter(s => s.key !== state && now - s.created <= STATE_TTL_MS);
  await my_kv.put('index:oauth:states', JSON.stringify(updated));

  if (!stateData) {
    return new Response(JSON.stringify({ error: 'Invalid or expired state' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const skinUrl = (env.BLESSING_SKIN_URL || 'https://skin.mc.ecustcic.com').replace(/\/+$/, '');

  const params = new URLSearchParams();
  params.set('grant_type', 'authorization_code');
  params.set('client_id', env.BLESSING_CLIENT_ID);
  params.set('client_secret', env.BLESSING_CLIENT_SECRET);
  params.set('redirect_uri', `${url.origin}/api/auth/callback`);
  params.set('code', code);

  const tokenResponse = await fetch(`${skinUrl}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: params.toString(),
  });

  const tokenData = await tokenResponse.json();
  if (tokenData.error) {
    return new Response(JSON.stringify({ error: tokenData.error_description || tokenData.error }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const userResponse = await fetch(`${skinUrl}/api/user`, {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
    },
  });
  const userData = await userResponse.json();

  const adminList = await my_kv.get('config:admins', 'json') || [];
  const isAdmin = adminList.includes(String(userData.uid)) || userData.permission >= 1;

  const sessionId = crypto.randomUUID().replace(/-/g, '');
  const session = {
    uid: userData.uid,
    nickname: userData.nickname,
    email: userData.email || '',
    avatar: userData.avatar,
    permission: userData.permission,
    isAdmin,
    created: Date.now(),
  };
  await my_kv.put(`session:${sessionId}`, JSON.stringify(session));

  const redirectUri = stateData.redirect_uri || '/admin';

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${redirectUri}?token=${sessionId}`,
      'Set-Cookie': `session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`,
    },
  });
}
