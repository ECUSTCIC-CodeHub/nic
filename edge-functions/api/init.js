export async function onRequestPost(context) {
  const { env } = context;
  const body = await context.request.json();

  const initKey = env.INIT_KEY || '';
  if (!initKey || body.init_key !== initKey) {
    return new Response(JSON.stringify({ error: 'Invalid init key' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const admins = body.admins || [];
  await my_kv.put('config:admins', JSON.stringify(admins));

  const settings = body.settings || {};
  await my_kv.put('config:settings', JSON.stringify(settings));

  return new Response(JSON.stringify({ success: true, message: 'System initialized' }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
