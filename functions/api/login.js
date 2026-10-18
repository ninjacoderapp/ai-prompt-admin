export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
  try {
    const { password } = await request.json();
    if (!password || !env.ADMIN_PASSWORD) {
      return new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    if (password !== env.ADMIN_PASSWORD) {
      return new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    const sessionToken = await generateSessionToken(env.SESSION_SECRET);
    return new Response(JSON.stringify({ success: true, token: sessionToken }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': 'admin_session=' + sessionToken + '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Invalid request' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
}
async function generateSessionToken(secret) {
  const encoder = new TextEncoder();
  const data = encoder.encode('' + Date.now() + '-' + Math.random() + '-' + secret);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}