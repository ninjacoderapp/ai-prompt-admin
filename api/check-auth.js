export async function onRequest(context) {
  const { request, env } = context;
  const sessionToken = getSessionToken(request);
  if (!sessionToken || sessionToken.length < 10) {
    return new Response(JSON.stringify({ authenticated: false }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ authenticated: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
function getSessionToken(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/admin_session=([^;]+)/);
  return match ? match[1] : null;
}