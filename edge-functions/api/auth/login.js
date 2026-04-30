export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const redirectUri = url.searchParams.get('redirect_uri') || '';
  const state = crypto.randomUUID().replace(/-/g, '');

  const stateData = JSON.stringify({
    redirect_uri: redirectUri,
    created: Date.now(),
  });
  await my_kv.put(`oauth:state:${state}`, stateData);

  const skinUrl = (env.BLESSING_SKIN_URL || 'https://skin.mc.ecustcic.com').replace(/\/+$/, '');
  const authUrl = new URL(`${skinUrl}/oauth/authorize`);
  authUrl.searchParams.set('client_id', env.BLESSING_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', `${url.origin}/api/auth/callback`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', '');
  authUrl.searchParams.set('state', state);

  return Response.redirect(authUrl.toString(), 302);
}
