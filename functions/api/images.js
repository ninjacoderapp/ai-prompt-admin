const DROPBOX_API = 'https://api.dropboxapi.com/2';
const DROPBOX_CONTENT = 'https://content.dropboxapi.com/2';
const ALLOWED_TYPES = ['image/webp', 'image/jpeg', 'image/png', 'image/avif'];
const MAX_FILE_SIZE = 20 * 1024 * 1024;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

// Normalise a Dropbox path: always starts with '/', no duplicate or trailing slashes.
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

function getImagesPath(env) {
  return getBasePath(env) + '/images';
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // GET /api/images                  -> configuration + Dropbox diagnostics
  // GET /api/images?path=/a/b.webp   -> stream that file (public, used by <img>)
  // GET /api/images?filename=b.webp  -> same, resolved inside the images folder
  if (request.method === 'GET' || request.method === 'HEAD') {
    const path = url.searchParams.get('path');
    const filename = url.searchParams.get('filename');
    if (!path && !filename) return handleStatus(env);
    return handleImageProxy(env, path, filename);
  }

  const authResult = await checkAuth(request, env);
  if (!authResult.authenticated) return json({ error: 'Unauthorized' }, 401);

  if (request.method === 'POST') {
    const contentType = request.headers.get('Content-Type') || '';
    if (contentType.includes('multipart/form-data')) return handleUpload(request, env);
    if (contentType.includes('application/json')) return handleJsonAction(request, env);
    return json({ error: 'Unsupported Content-Type: ' + (contentType || 'none') }, 415);
  }

  return json({ error: 'Method not allowed' }, 405);
}

// ===== DIAGNOSTICS =====
async function handleStatus(env) {
  const catalogPath = getBasePath(env) + '/catalog.json';
  const imagesPath = getImagesPath(env);

  const credentials = env.DROPBOX_ACCESS_TOKEN
    ? 'access_token'
    : env.DROPBOX_REFRESH_TOKEN && env.DROPBOX_APP_KEY && env.DROPBOX_APP_SECRET
      ? 'refresh_token'
      : 'missing';

  const status = {
    service: 'images',
    credentials,
    rootPath: env.DROPBOX_ROOT_PATH || '',
    subfolder: env.DROPBOX_SUBFOLDER || '/AI-Prompt-App',
    basePath: getBasePath(env),
    catalogPath,
    imagesPath,
    catalogExists: false,
    imagesFolderExists: false,
    imageCount: 0,
  };

  try {
    const token = await getDropboxToken(env);
    const [catalogMeta, imagesMeta] = await Promise.all([
      getMetadata(token, catalogPath),
      getMetadata(token, imagesPath),
    ]);
    status.catalogExists = !!catalogMeta;
    status.imagesFolderExists = !!imagesMeta;

    if (imagesMeta) {
      const entries = await listFolder(token, imagesPath);
      if (entries) status.imageCount = entries.filter(e => e['.tag'] === 'file').length;
    }
  } catch (err) {
    status.error = err.message;
  }

  return json(status, 200, { 'Cache-Control': 'public, max-age=60' });
}

// ===== IMAGE PROXY =====
async function handleImageProxy(env, rawPath, filename) {
  try {
    const basePath = getBasePath(env);

    let path;
    if (rawPath) {
      path = normalizePath(rawPath);
    } else {
      const safeName = String(filename || '').replace(/^.*[\\/]/, '');
      if (!safeName) return new Response('Invalid filename', { status: 400 });
      path = getImagesPath(env) + '/' + safeName;
    }

    // Never proxy anything outside this app's folder.
    if (basePath && path !== basePath && !path.startsWith(basePath + '/')) {
      return new Response('Forbidden', { status: 403 });
    }

    const token = await getDropboxToken(env);
    const response = await fetch(DROPBOX_CONTENT + '/files/download', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Dropbox-API-Arg': JSON.stringify({ path }),
      },
    });

    if (!response.ok) return new Response('Image not found', { status: 404 });

    const headers = {
      'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream',
      'Cache-Control': 'public, max-age=3600',
    };
    const contentLength = response.headers.get('Content-Length');
    if (contentLength) headers['Content-Length'] = contentLength;

    return new Response(response.body, { status: 200, headers });
  } catch (err) {
    return new Response('Image unavailable: ' + err.message, { status: 502 });
  }
}

// ===== JSON ACTIONS (delete / link) =====
async function handleJsonAction(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const action = body.action || (body.path || body.filename ? 'link' : null);
  if (action === 'delete') return handleDelete(env, body);
  if (action === 'link') return handleGetUrl(request, env, body);
  return json({ error: 'Unknown action. Use "delete" or "link".' }, 400);
}

// ===== UPLOAD =====
async function handleUpload(request, env) {
  try {
    const formData = await request.formData();
    const file = formData.get('image');

    if (!file || typeof file === 'string') {
      return json({ error: 'No image file provided (expected form field "image")' }, 400);
    }
    if (!ALLOWED_TYPES.includes(file.type)) {
      return json({ error: 'Invalid file type "' + file.type + '". Allowed: WebP, JPEG, PNG, AVIF' }, 400);
    }
    if (file.size > MAX_FILE_SIZE) {
      return json({ error: 'File too large. Maximum size is 20MB' }, 400);
    }

    const token = await getDropboxToken(env);
    const buffer = await file.arrayBuffer();

    const originalName = file.name || 'image';
    const rawExt = originalName.includes('.') ? originalName.split('.').pop().toLowerCase() : 'webp';
    const ext = /^[a-z0-9]{2,5}$/.test(rawExt) ? rawExt : 'webp';
    const filename = Date.now() + '-' + Math.random().toString(36).substring(2, 8) + '.' + ext;
    const dropboxPath = getImagesPath(env) + '/' + filename;

    const uploadResponse = await fetch(DROPBOX_CONTENT + '/files/upload', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath, mode: 'add', autorename: true, mute: true }),
      },
      body: buffer,
    });

    if (!uploadResponse.ok) {
      return json({
        error: 'Upload failed',
        details: (await uploadResponse.text()).substring(0, 500),
        status: uploadResponse.status,
      }, 500);
    }

    const uploadResult = await uploadResponse.json();

    // Prefer a public shared link. If the app is missing "sharing" scopes, fall
    // back to the worker proxy, which works with read access alone.
    const sharedUrl = await createOrFindSharedLink(token, dropboxPath);
    const proxyUrl = new URL(
      '/api/images?path=' + encodeURIComponent(dropboxPath),
      request.url
    ).toString();

    return json({
      success: true,
      filename,
      path: dropboxPath,
      imageUrl: sharedUrl || proxyUrl,
      directUrl: sharedUrl,
      proxyUrl,
      fileId: uploadResult.id,
      size: uploadResult.size,
    });
  } catch (err) {
    return json({ error: 'Upload failed', details: err.message }, 500);
  }
}

// ===== DELETE =====
async function handleDelete(env, body) {
  try {
    const imagesPath = getImagesPath(env);
    let target = null;

    if (body.path) {
      target = normalizePath(body.path);
    } else if (body.filename) {
      const safeName = String(body.filename).replace(/^.*[\\/]/, '');
      if (safeName) target = imagesPath + '/' + safeName;
    }

    if (!target) return json({ error: 'Provide "path" or "filename"' }, 400);

    // Only allow deleting files that live inside the images folder.
    if (target !== imagesPath && !target.startsWith(imagesPath + '/')) {
      return json({ error: 'Refusing to delete a file outside ' + imagesPath }, 400);
    }

    const token = await getDropboxToken(env);
    const response = await fetch(DROPBOX_API + '/files/delete_v2', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: target }),
    });

    // 409 = path not found, i.e. already deleted. Treat as success.
    if (response.ok || response.status === 409) {
      return json({ success: true, deleted: response.ok, path: target });
    }

    return json({
      error: 'Failed to delete file from Dropbox',
      details: (await response.text()).substring(0, 500),
      status: response.status,
    }, 500);
  } catch (err) {
    return json({ error: 'Failed to delete file', details: err.message }, 500);
  }
}

// ===== RESOLVE / CREATE A LINK =====
async function handleGetUrl(request, env, body) {
  try {
    const imagesPath = getImagesPath(env);
    let path = null;

    if (body.path) {
      path = normalizePath(body.path);
    } else if (body.filename) {
      const safeName = String(body.filename).replace(/^.*[\\/]/, '');
      if (safeName) path = imagesPath + '/' + safeName;
    }
    if (!path) return json({ error: 'File path is required' }, 400);

    const token = await getDropboxToken(env);
    const proxyUrl = new URL(
      '/api/images?path=' + encodeURIComponent(path),
      request.url
    ).toString();
    const sharedUrl = await createOrFindSharedLink(token, path);

    return json({
      success: true,
      path,
      url: sharedUrl || proxyUrl,
      directUrl: sharedUrl,
      proxyUrl,
      fallback: sharedUrl ? null : 'proxy',
    });
  } catch (err) {
    return json({ error: 'Failed to get URL', details: err.message }, 500);
  }
}

// ===== DROPBOX HELPERS =====
async function createOrFindSharedLink(token, path) {
  try {
    const createResponse = await fetch(DROPBOX_API + '/sharing/create_shared_link_with_settings', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, settings: { requested_visibility: 'public' } }),
    });
    if (createResponse.ok) {
      const data = await createResponse.json();
      return convertToDirectUrl(data.url);
    }

    const listResponse = await fetch(DROPBOX_API + '/sharing/list_shared_links', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, direct_only: true }),
    });
    if (listResponse.ok) {
      const data = await listResponse.json();
      if (data.links && data.links.length > 0) return convertToDirectUrl(data.links[0].url);
    }
  } catch {
    // Fall through to the proxy fallback.
  }
  return null;
}

function convertToDirectUrl(sharedUrl) {
  try {
    const url = new URL(sharedUrl);
    url.hostname = 'dl.dropboxusercontent.com';
    url.searchParams.delete('dl');
    url.searchParams.set('raw', '1');
    return url.toString();
  } catch {
    return sharedUrl;
  }
}

async function getMetadata(token, path) {
  const response = await fetch(DROPBOX_API + '/files/get_metadata', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (response.status === 409) return null;
  if (!response.ok) {
    throw new Error('get_metadata failed (HTTP ' + response.status + '): ' + (await response.text()).substring(0, 300));
  }
  return response.json();
}

async function listFolder(token, path) {
  const response = await fetch(DROPBOX_API + '/files/list_folder', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, limit: 2000 }),
  });
  if (!response.ok) return null;
  const data = await response.json();
  return data.entries || [];
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
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: env.DROPBOX_REFRESH_TOKEN,
        client_id: env.DROPBOX_APP_KEY,
        client_secret: env.DROPBOX_APP_SECRET,
      }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error('Token refresh failed (HTTP ' + response.status + '): ' + errText.substring(0, 300));
    }
    const data = await response.json();
    if (!data.access_token) throw new Error('Token refresh response missing access_token: ' + JSON.stringify(data));
    return data.access_token;
  }
  throw new Error('No Dropbox credentials configured (set DROPBOX_ACCESS_TOKEN, or DROPBOX_REFRESH_TOKEN + DROPBOX_APP_KEY + DROPBOX_APP_SECRET)');
}
