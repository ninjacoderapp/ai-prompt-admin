import {
  ghConfig, ghWriteFile, ghDeleteFile, ghGetMeta, ghListDir,
  readCatalog, writeCatalog, repoPathLabel, GithubError,
} from '../_github.js';

const ALLOWED_TYPES = ['image/webp', 'image/jpeg', 'image/png', 'image/avif'];
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const IMAGES_DIR = 'images';

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

function configError(cfg) {
  const missing = [];
  if (!cfg.token) missing.push('GITHUB_SECRET');
  if (!cfg.owner) missing.push('GITHUB_OWNER');
  if (!cfg.repo) missing.push('GITHUB_REPO');
  return { error: 'GitHub storage is not configured', details: 'Missing: ' + missing.join(', ') };
}

function errorPayload(error, err, cfg) {
  return {
    error,
    details: err instanceof GithubError ? (err.details || err.message) : err.message,
    hint: err instanceof GithubError ? err.hint : '',
    status: err instanceof GithubError ? err.status : 500,
    repo: cfg ? cfg.owner + '/' + cfg.repo : '',
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // GET /api/images              -> configuration + storage diagnostics
  // GET /api/images?file=b.webp  -> stream an image from GitHub raw (fallback
  //                                 used until Cloudflare Pages deploys it)
  if (request.method === 'GET' || request.method === 'HEAD') {
    const file = url.searchParams.get('file') || url.searchParams.get('path');
    if (!file) return handleStatus(env);
    return handleImageProxy(env, file);
  }

  const auth = checkAuth(request);
  if (!auth.authenticated) return json({ error: 'Unauthorized' }, 401);

  let cfg;
  try {
    cfg = await ghConfig(env);
  } catch (err) {
    return json({ error: 'GitHub configuration failed', details: err.message }, 500);
  }
  if (!cfg.configured) return json(configError(cfg), 500);

  if (request.method === 'POST') {
    const contentType = request.headers.get('Content-Type') || '';
    if (contentType.includes('multipart/form-data')) {
      try {
        return await handleUpload(request, cfg);
      } catch (err) {
        return json(errorPayload('Image upload failed', err, cfg), 500);
      }
    }
    if (contentType.includes('application/json')) {
      try {
        return await handleJsonAction(request, cfg);
      } catch (err) {
        return json(errorPayload('Action failed', err, cfg), 500);
      }
    }
    return json({ error: 'Unsupported Content-Type: ' + (contentType || 'none') }, 415);
  }

  return json({ error: 'Method not allowed' }, 405);
}

// ===== STATUS / DIAGNOSTICS =====
async function handleStatus(env) {
  const status = {
    service: 'images',
    secretPresent: !!env.GITHUB_SECRET,
    owner: env.GITHUB_OWNER || '(auto)',
    repo: env.GITHUB_REPO || '(missing)',
    branch: env.GITHUB_BRANCH || 'main',
    imagesPath: null,
    catalogPath: null,
    imageCount: 0,
    images: [],
  };

  try {
    const cfg = await ghConfig(env);
    status.owner = cfg.owner || '(unknown)';
    status.repo = cfg.repo || '(missing)';
    status.imagesPath = repoPathLabel(cfg, IMAGES_DIR);
    status.catalogPath = repoPathLabel(cfg, 'catalog.json');

    if (!cfg.configured) {
      status.error = 'GitHub storage is not configured';
      return json(status, 200, { 'Cache-Control': 'no-cache' });
    }

    const entries = await ghListDir(cfg, IMAGES_DIR);
    const files = entries.filter(e => e.type === 'file');
    status.imageCount = files.length;
    status.images = files.slice(-20).map(e => e.name);
  } catch (err) {
    status.error = err.message;
  }

  return json(status, 200, { 'Cache-Control': 'no-cache' });
}

// ===== IMAGE FALLBACK =====
// Images are normally served by functions/images/[file].js. This raw GitHub
// proxy is the fallback for previews when that route is unavailable.
async function handleImageProxy(env, rawPath) {
  const name = String(rawPath).replace(/\\/g, '/').split('/').pop();
  if (!name || !/\.[a-z0-9]{2,5}$/i.test(name)) {
    return new Response('Invalid filename', { status: 400 });
  }

  try {
    const cfg = await ghConfig(env);
    if (!cfg.configured) return new Response('Storage is not configured', { status: 500 });

    const path = repoPathLabel(cfg, IMAGES_DIR + '/' + name);
    const url = 'https://raw.githubusercontent.com/' + cfg.owner + '/' + cfg.repo + '/' +
      cfg.branch + '/' + path.split('/').map(encodeURIComponent).join('/');
    const headers = cfg.token ? { 'Authorization': 'Bearer ' + cfg.token } : {};
    const res = await fetch(url, { headers, cf: { cacheTtl: 86400 } });

    if (!res.ok) return new Response('Image not found', { status: 404 });

    return new Response(res.body, {
      status: 200,
      headers: {
        'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (err) {
    return new Response('Image unavailable: ' + err.message, { status: 502 });
  }
}

// ===== UPLOAD =====
async function handleUpload(request, cfg) {
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

  const buffer = new Uint8Array(await file.arrayBuffer());
  const originalName = file.name || 'image';
  const rawExt = originalName.includes('.') ? originalName.split('.').pop().toLowerCase() : 'webp';
  const ext = /^[a-z0-9]{2,5}$/.test(rawExt) ? rawExt : 'webp';

  // ?as=<name> keeps the original filename. The admin "Import" tool uses it so
  // legacy entries like "public/images/1.webp" can be re-linked to the file.
  const requestedName = importFilename(new URL(request.url).searchParams.get('as'));
  let filename;
  let existingSha = null;
  if (requestedName) {
    filename = requestedName;
    const meta = await ghGetMeta(cfg, IMAGES_DIR + '/' + filename);
    if (meta) existingSha = meta.sha;
  } else {
    // Unique filename so an upload can never overwrite an existing image.
    filename = Date.now() + '-' + Math.random().toString(36).substring(2, 8) + '.' + ext;
  }
  const path = IMAGES_DIR + '/' + filename;

  const result = await ghWriteFile(
    cfg, path, buffer,
    (existingSha ? 'Replace image ' : 'Add image ') + filename,
    existingSha || undefined
  );
  const origin = new URL(request.url).origin;

  return json({
    success: true,
    filename,
    path,
    imageUrl: origin + '/' + path,
    sha: result.sha,
    commit: result.commit,
    size: buffer.length,
    overwritten: !!existingSha,
    note: 'The image is now in the repository and served from /images/' + filename + '. It can take a few seconds to appear.',
  });
}

// Keeps a caller-supplied filename inside the images folder and limited to the
// extensions the rest of the pipeline understands.
const IMPORT_EXT = ['webp', 'jpg', 'jpeg', 'png', 'avif'];

function importFilename(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const base = raw.replace(/\\/g, '/').split('/').pop()
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^[._]+/, '');
  const match = base.match(/^(.+)\.([A-Za-z0-9]{2,5})$/);
  if (!match) return null;
  const extension = match[2].toLowerCase();
  if (!IMPORT_EXT.includes(extension)) return null;
  const stem = match[1].substring(0, 80) || 'image';
  return stem + '.' + extension;
}

// ===== JSON ACTIONS (delete / migrate-links) =====
async function handleJsonAction(request, cfg) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (body.action === 'delete') return handleDelete(body, cfg);
  if (body.action === 'migrate-links') return handleMigrateLinks(request, cfg);
  return json({ error: 'Unknown action. Use "delete" or "migrate-links".' }, 400);
}

// Always resolves to "images/<basename>", so nothing outside the images folder
// can ever be deleted whatever path the caller sends.
function resolveImagePath(body) {
  const raw = body.path || body.filePath || '';
  let path = String(raw).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!path && body.filename) path = IMAGES_DIR + '/' + String(body.filename).replace(/^.*[\\/]/, '');
  if (!path) return null;
  const name = path.substring(path.lastIndexOf('/') + 1);
  return name ? IMAGES_DIR + '/' + name : null;
}

async function handleDelete(body, cfg) {
  const path = resolveImagePath(body);
  if (!path) return json({ error: 'Provide "path" or "filename"' }, 400);

  const result = await ghDeleteFile(cfg, path, 'Delete image ' + path.substring(path.lastIndexOf('/') + 1));
  return json({ success: true, deleted: result.deleted, path, commit: result.commit || null });
}

// ===== MIGRATE CATALOG IMAGES TO CLOUDFLARE PAGES URLS =====
async function handleMigrateLinks(request, cfg) {
  const origin = new URL(request.url).origin;

  const stored = await readCatalog(cfg);
  if (!stored.exists || !stored.catalog) {
    return json({ error: 'catalog.json not found in the repository' }, 404);
  }

  const items = Array.isArray(stored.catalog.items) ? stored.catalog.items : [];
  const report = { total: items.length, updated: 0, alreadyDirect: 0, failed: [] };

  for (const item of items) {
    const name = imageFilename(item);
    if (!name) {
      report.failed.push({ id: item.id, reason: 'no image filename', image: item.image });
      continue;
    }
    const newPath = IMAGES_DIR + '/' + name;
    const newUrl = origin + '/' + newPath;
    if (item.image === newUrl && item.filePath === newPath) {
      report.alreadyDirect++;
      continue;
    }
    item.image = newUrl;
    item.filePath = newPath;
    report.updated++;
  }

  if (report.failed.length > 20) report.failed = report.failed.slice(0, 20);

  if (report.updated === 0) {
    return json({
      success: true,
      saved: false,
      ...report,
      hint: 'Every image already points at Cloudflare Pages.',
    });
  }

  try {
    const result = await writeCatalog(cfg, stored.catalog, 'Point catalog images at Cloudflare Pages');
    return json({ success: true, saved: true, ...report, commit: result.commit });
  } catch (err) {
    return json({
      error: 'Links were resolved but catalog.json could not be saved',
      details: err.message,
      hint: err.hint || '',
      saved: false,
      ...report,
    }, 500);
  }
}

function imageFilename(item) {
  for (const value of [item.filePath, item.image]) {
    if (!value) continue;
    const clean = String(value).split('?')[0].split('#')[0];
    const name = clean.substring(clean.lastIndexOf('/') + 1);
    if (name && /\.[a-z0-9]{2,5}$/i.test(name)) return name;
  }
  return null;
}

function checkAuth(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/admin_session=([^;]+)/);
  const token = match ? match[1] : null;
  return { authenticated: !!(token && token.length >= 10) };
}
