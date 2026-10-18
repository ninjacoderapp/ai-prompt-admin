const DROPBOX_API = 'https://api.dropboxapi.com/2';
const DROPBOX_CONTENT = 'https://content.dropboxapi.com/2';

function getImagesPath(env) {
  const root = env.DROPBOX_ROOT_PATH || '';
  return root + '/AI-Prompt-App/images';
}

export async function onRequest(context) {
  const { request, env } = context;
  const authResult = await checkAuth(request, env);
  if (!authResult.authenticated) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  if (request.method === 'POST' && action === 'upload') return handleUpload(request, env);
  if (request.method === 'POST' && action === 'url') return handleGetUrl(request, env);
  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
}

async function handleUpload(request, env) {
  try {
    const formData = await request.formData();
    const file = formData.get('image');
    if (!file) return new Response(JSON.stringify({ error: 'No image file provided' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    const allowedTypes = ['image/webp', 'image/jpeg', 'image/png', 'image/avif'];
    if (!allowedTypes.includes(file.type)) return new Response(JSON.stringify({ error: 'Invalid file type. Allowed: WebP, JPEG, PNG, AVIF' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    if (file.size > 20 * 1024 * 1024) return new Response(JSON.stringify({ error: 'File too large. Maximum size is 20MB' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    const token = await getDropboxToken(env);
    const buffer = await file.arrayBuffer();
    const imagesPath = getImagesPath(env);
    const ext = file.name.split('.').pop() || 'webp';
    const filename = Date.now() + '-' + Math.random().toString(36).substring(2, 8) + '.' + ext;
    const dropboxPath = imagesPath + '/' + filename;
    const uploadResponse = await fetch(DROPBOX_CONTENT + '/files/upload', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath, mode: 'add' }) },
      body: buffer,
    });
    if (!uploadResponse.ok) { const error = await uploadResponse.text(); return new Response(JSON.stringify({ error: 'Upload failed', details: error }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }
    const uploadResult = await uploadResponse.json();
    const linkResponse = await fetch(DROPBOX_API + '/sharing/create_shared_link_with_settings', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dropboxPath, settings: { requested_visibility: 'public' } }),
    });
    let imageUrl = null;
    if (linkResponse.ok) { const linkData = await linkResponse.json(); imageUrl = convertToDirectUrl(linkData.url); }
    else {
      const listResponse = await fetch(DROPBOX_API + '/sharing/list_shared_links', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dropboxPath }),
      });
      if (listResponse.ok) { const listData = await listResponse.json(); if (listData.links && listData.links.length > 0) imageUrl = convertToDirectUrl(listData.links[0].url); }
    }
    if (!imageUrl) imageUrl = 'https://dl.dropboxusercontent.com/scl/fi/' + uploadResult.id + '/' + filename;
    return new Response(JSON.stringify({ success: true, filename, path: dropboxPath, imageUrl, fileId: uploadResult.id, size: uploadResult.size }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Upload failed', details: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleGetUrl(request, env) {
  try {
    const { path } = await request.json();
    if (!path) return new Response(JSON.stringify({ error: 'File path is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    const token = await getDropboxToken(env);
    const listResponse = await fetch(DROPBOX_API + '/sharing/list_shared_links', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (listResponse.ok) { const listData = await listResponse.json(); if (listData.links && listData.links.length > 0) return new Response(JSON.stringify({ success: true, url: convertToDirectUrl(listData.links[0].url) }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
    const linkResponse = await fetch(DROPBOX_API + '/sharing/create_shared_link_with_settings', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, settings: { requested_visibility: 'public' } }),
    });
    if (!linkResponse.ok) return new Response(JSON.stringify({ error: 'Failed to create shared link' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    const linkData = await linkResponse.json();
    return new Response(JSON.stringify({ success: true, url: convertToDirectUrl(linkData.url) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Failed to get URL', details: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

function convertToDirectUrl(sharedUrl) {
  let url = sharedUrl;
  url = url.replace('www.dropbox.com', 'dl.dropboxusercontent.com');
  url = url.replace('?dl=0', '?dl=1');
  url = url.replace('?raw=1', '');
  return url;
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