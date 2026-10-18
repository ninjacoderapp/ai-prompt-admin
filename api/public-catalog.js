const DROPBOX_API = 'https://api.dropboxapi.com/2';
const DROPBOX_CONTENT = 'https://content.dropboxapi.com/2';

function getCatalogPath(env) {
  const root = env.DROPBOX_ROOT_PATH || '';
  return root + '/AI-Prompt-App/catalog.json';
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  try {
    const token = await getDropboxToken(env);
    const catalogPath = getCatalogPath(env);
    const metaResponse = await fetch(DROPBOX_API + '/files/get_metadata', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: catalogPath }),
    });
    let revision = null;
    if (metaResponse.ok) { const meta = await metaResponse.json(); revision = meta.rev; }
    const ifNoneMatch = request.headers.get('If-None-Match');
    if (ifNoneMatch && revision && ifNoneMatch === '"' + revision + '"') {
      return new Response(null, { status: 304, headers: { 'ETag': '"' + revision + '"', 'Cache-Control': 'public, max-age=300' } });
    }
    const response = await fetch(DROPBOX_CONTENT + '/files/download', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Dropbox-API-Arg': JSON.stringify({ path: catalogPath }) },
    });
    if (!response.ok) {
      if (response.status === 409) return new Response(JSON.stringify({ categories: [], items: [] }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' } });
      return new Response(JSON.stringify({ error: 'Catalog unavailable' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
    const text = await response.text();
    try { JSON.parse(text); } catch { return new Response(JSON.stringify({ error: 'Invalid catalog data' }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' };
    if (revision) headers['ETag'] = '"' + revision + '"';
    return new Response(text, { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Service unavailable' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }
}

async function getDropboxToken(env) {
  if (env.DROPBOX_ACCESS_TOKEN) return env.DROPBOX_ACCESS_TOKEN;
  if (env.DROPBOX_REFRESH_TOKEN && env.DROPBOX_APP_KEY && env.DROPBOX_APP_SECRET) {
    const response = await fetch('https://api.dropbox.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.DROPBOX_REFRESH_TOKEN, client_id: env.DROPBOX_APP_KEY, client_secret: env.DROPBOX_APP_SECRET }),
    });
    if (!response.ok) { const errText = await response.text(); throw new Error('Token refresh failed (HTTP ' + response.status + '): ' + errText.substring(0, 300)); }
    const data = await response.json();
    if (!data.access_token) throw new Error('Token refresh response missing access_token: ' + JSON.stringify(data));
    return data.access_token;
  }
  throw new Error('No Dropbox credentials configured');
}