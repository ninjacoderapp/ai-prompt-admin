const DROPBOX_API = 'https://api.dropboxapi.com/2';
const DROPBOX_CONTENT = 'https://content.dropboxapi.com/2';

function normalizePath(value) {
  if (!value) return '';
  const parts = String(value).replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length ? '/' + parts.join('/') : '';
}

function getBasePath(env) {
  const root = normalizePath(env.DROPBOX_ROOT_PATH || '');
  const subfolder = normalizePath(env.DROPBOX_SUBFOLDER || '/AI-Prompt-App');
  return root + subfolder;
}

function getCatalogPath(env) {
  return getBasePath(env) + '/catalog.json';
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'GET') return handleGetCatalog(env);
  if (request.method === 'POST') {
    const authResult = await checkAuth(request, env);
    if (!authResult.authenticated) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    return handlePostCatalog(request, env);
  }
  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
}

async function handleGetCatalog(env) {
  try {
    const token = await getDropboxToken(env);
    const catalogPath = getCatalogPath(env);
    const response = await fetch(DROPBOX_API + '/files/download', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Dropbox-API-Arg': JSON.stringify({ path: catalogPath }) },
    });
    if (response.status === 409) {
      // The catalog file does not exist yet -> first run. Report the exact path
      // in headers so it is easy to verify the DROPBOX_SUBFOLDER setting.
      return new Response(JSON.stringify({ categories: ['trending', 'boy', 'girl', 'festival', 'other'], items: [] }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Catalog-Status': 'not-found',
          'X-Catalog-Path': catalogPath,
        },
      });
    }
    if (!response.ok) {
      const error = await response.text();
      let details = error;
      try { const errJson = JSON.parse(error); details = JSON.stringify(errJson.error || errJson); } catch {}
      return new Response(JSON.stringify({ error: 'Failed to fetch catalog', details: details, status: response.status, catalogPath: catalogPath }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    const text = await response.text();
    try { JSON.parse(text); } catch (parseErr) {
      return new Response(JSON.stringify({ error: 'Invalid catalog JSON in Dropbox', details: 'Response starts with: ' + text.substring(0, 200) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Dropbox connection failed', details: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handlePostCatalog(request, env) {
  try {
    const catalog = await request.json();
    if (!catalog || typeof catalog !== 'object') return new Response(JSON.stringify({ error: 'Invalid catalog format' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    if (!Array.isArray(catalog.categories)) return new Response(JSON.stringify({ error: 'categories must be an array' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    if (!Array.isArray(catalog.items)) return new Response(JSON.stringify({ error: 'items must be an array' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    for (const item of catalog.items) {
      if (!item.id || !item.name || !item.category || !item.image || !item.prompt) return new Response(JSON.stringify({ error: 'Each item must have id, name, category, image, and prompt' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      if (!Array.isArray(item.tags)) return new Response(JSON.stringify({ error: 'tags must be an array' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const token = await getDropboxToken(env);
    const catalogPath = getCatalogPath(env);
    const jsonString = JSON.stringify(catalog, null, 2);
    let revision = null;
    try {
      const metaResponse = await fetch(DROPBOX_API + '/files/get_metadata', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: catalogPath }),
      });
      if (metaResponse.ok) { const meta = await metaResponse.json(); revision = meta.rev; }
    } catch {}
    const uploadArg = { path: catalogPath, mode: 'overwrite' };
    if (revision) uploadArg.mode = { update: revision };
    const uploadResponse = await fetch(DROPBOX_CONTENT + '/files/upload', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify(uploadArg) },
      body: jsonString,
    });
    if (!uploadResponse.ok) { const error = await uploadResponse.text(); return new Response(JSON.stringify({ error: 'Failed to save catalog', details: error }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }
    const result = await uploadResponse.json();
    return new Response(JSON.stringify({ success: true, rev: result.rev, size: jsonString.length }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Failed to save catalog', details: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function checkAuth(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/admin_session=([^;]+)/);
  const token = match ? match[1] : null;
  return { authenticated: !!(token && token.length >= 10) };
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