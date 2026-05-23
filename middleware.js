export const config = {
  matcher: ['/:path*'],
};

const REDIRECTS = {
  'nic.mc.ecustcic.com': 'nic.ecustcic.com',
};

export function middleware(context) {
  const url = new URL(context.request.url);
  const target = REDIRECTS[url.hostname];

  if (target) {
    const dest = `${url.protocol}//${target}${url.pathname}${url.search}`;
    return Response.redirect(dest, 301);
  }

  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  if (url.pathname === '/api/health') {
    return new Response(JSON.stringify({ status: 'ok', timestamp: Date.now() }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return context.next();
}
