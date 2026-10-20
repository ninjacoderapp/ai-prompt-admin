import {
  ghConfig, ghReadFile, ghWriteFile, ghDeleteFile, ghHeaders,
  readCatalog, writeCatalog, repoPathLabel, GithubError, CATALOG_FILE,
} from '../_github.js';

const SERVICE_VERSION = '2.0.1';
const DEFAULT_CATALOG = { categories: ['boy', 'girl', 'festival', 'other'], items: [] };

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

function errorPayload(error, err, cfg) {
  return {
    error,
    details: err instanceof GithubError ? (err.details || err.message) : err.message,
    hint: err instanceof GithubError ? err.hint : '',
    status: err instanceof GithubError ? err.status : 500,
    repo: cfg ? cfg.owner + '/' + cfg.repo : '',
    branch: cfg ? cfg.branch : '',
    catalogPath: cfg ? repoPathLabel(cfg, CATALOG_FILE) : CATALOG_FILE,
  };
}

function configError(cfg) {
  const missing = [];
  if (!cfg.token) missing.push('GITHUB_SECRET');
  if (!cfg.owner) missing.push('GITHUB_OWNER');
  if (!cfg.repo) missing.push('GITHUB_REPO');
  return {
    error: 'GitHub storage is not configured',
    details: 'Missing environment variable(s): ' + missing.join(', '),
    hint: 'Add them in Cloudflare Pages -> Settings -> Environment variables, then redeploy.',
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method === 'GET') {
    if (url.searchParams.get('diagnostics')) return handleDiagnostics(env, url);
    return handleGetCatalog(env);
  }
  if (request.method === 'POST') {
    const auth = checkAuth(request);
    if (!auth.authenticated) {
      return json({ error: 'Unauthorized', details: 'Session cookie missing or expired. Please log in again.' }, 401);
    }
    return handlePostCatalog(request, env);
  }
  return json({ error: 'Method not allowed' }, 405);
}

async function handleGetCatalog(env) {
  let cfg;
  try {
    cfg = await ghConfig(env);
  } catch (err) {
    return json({ error: 'GitHub configuration failed', details: err.message }, 500);
  }
  if (!cfg.configured) return json(configError(cfg), 500);

  try {
    const file = await ghReadFile(cfg, CATALOG_FILE);
    if (!file.exists) {
      // First run: report the exact path so a wrong GITHUB_DATA_PATH is visible.
      return new Response(JSON.stringify(DEFAULT_CATALOG), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Catalog-Status': 'not-found',
          'X-Catalog-Path': repoPathLabel(cfg, CATALOG_FILE),
        },
      });
    }
    try {
      JSON.parse(file.text);
    } catch {
      return json({ error: 'Invalid catalog JSON in the repository', details: 'Response starts with: ' + file.text.substring(0, 200) }, 500);
    }
    return new Response(file.text, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' },
    });
  } catch (err) {
    return json(errorPayload('Failed to fetch catalog', err, cfg), 500);
  }
}

function validateCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return 'Invalid catalog format';
  if (!Array.isArray(catalog.categories)) return 'categories must be an array';
  if (!Array.isArray(catalog.items)) return 'items must be an array';

  for (let i = 0; i < catalog.items.length; i++) {
    const item = catalog.items[i];
    if (!item || typeof item !== 'object') return 'Item #' + (i + 1) + ' is not an object';
    // Presence check, not truthiness: an empty prompt must not block the save.
    const missing = ['id', 'name', 'category', 'image', 'prompt'].filter(f => !(f in item));
    if (missing.length) return 'Item #' + (i + 1) + ' (id ' + item.id + ') is missing: ' + missing.join(', ');
    if (!Array.isArray(item.tags)) return 'Item #' + (i + 1) + ' (id ' + item.id + ') has invalid tags (must be an array)';
    if (item.nameRequired !== undefined && typeof item.nameRequired !== 'boolean' && item.nameRequired !== 0 && item.nameRequired !== 1) {
      return 'Item #' + (i + 1) + ' (id ' + item.id + ') has invalid nameRequired (must be true/false or 1/0)';
    }
  }
  return null;
}

async function handlePostCatalog(request, env) {
  let catalog;
  try {
    catalog = await request.json();
  } catch (err) {
    return json({ error: 'Could not read the request body', details: err.message }, 400);
  }

  const invalid = validateCatalog(catalog);
  if (invalid) return json({ error: invalid }, 400);

  let cfg;
  try {
    cfg = await ghConfig(env);
  } catch (err) {
    return json({ error: 'GitHub configuration failed', details: err.message }, 500);
  }
  if (!cfg.configured) return json(configError(cfg), 500);

  try {
    const result = await writeCatalog(cfg, catalog, 'Update catalog via admin panel');
    return json({
      success: true,
      sha: result.sha,
      commit: result.commit,
      size: result.size,
      repo: cfg.owner + '/' + cfg.repo,
      branch: cfg.branch,
      catalogPath: repoPathLabel(cfg, CATALOG_FILE),
    });
  } catch (err) {
    return json(errorPayload('Failed to save catalog', err, cfg), 500);
  }
}

async function handleDiagnostics(env, url) {
  const report = {
    service: 'catalog',
    version: SERVICE_VERSION,
    secretPresent: !!env.GITHUB_SECRET,
    owner: env.GITHUB_OWNER || '(auto)',
    repo: env.GITHUB_REPO || '(missing)',
    branch: env.GITHUB_BRANCH || 'main',
    dataPath: env.GITHUB_DATA_PATH || '(repo root)',
    token: null,
    repoAccess: null,
    read: null,
    write: null,
    catalog: null,
  };

  let cfg;
  try {
    cfg = await ghConfig(env);
  } catch (err) {
    report.token = { ok: false, error: err.message };
    return json(report);
  }
  report.owner = cfg.owner || '(unknown)';
  report.repo = cfg.repo || '(missing)';
  report.configured = cfg.configured;

  if (!cfg.token) {
    report.token = { ok: false, error: 'GITHUB_SECRET is not set' };
    return json(report);
  }

  try {
    const res = await fetch('https://api.github.com/user', { headers: ghHeaders(cfg.token) });
    if (res.ok) {
      const user = await res.json();
      report.token = { ok: true, login: user.login };
    } else {
      report.token = { ok: false, status: res.status, error: (await res.text()).substring(0, 200) };
    }
  } catch (err) {
    report.token = { ok: false, error: err.message };
  }

  try {
    const res = await fetch('https://api.github.com/repos/' + cfg.owner + '/' + cfg.repo, { headers: ghHeaders(cfg.token) });
    if (res.ok) {
      const repo = await res.json();
      report.repoAccess = { ok: true, defaultBranch: repo.default_branch, private: repo.private, permissions: repo.permissions };
      if (repo.permissions && typeof repo.permissions.push === 'boolean') {
        report.write = { ok: repo.permissions.push, via: 'token permissions' };
      }
    } else {
      report.repoAccess = {
        ok: false,
        status: res.status,
        error: (await res.text()).substring(0, 200),
        hint: 'A fine-grained token only sees repositories it was explicitly granted. Check GITHUB_OWNER / GITHUB_REPO and the token permissions.',
      };
    }
  } catch (err) {
    report.repoAccess = { ok: false, error: err.message };
  }

  try {
    const file = await ghReadFile(cfg, CATALOG_FILE);
    if (file.exists) {
      report.read = { ok: true, sha: file.sha, size: file.size };
      try {
        const parsed = JSON.parse(file.text);
        report.catalog = {
          ok: true,
          bytes: file.text.length,
          categories: Array.isArray(parsed.categories) ? parsed.categories.length : 'invalid',
          items: Array.isArray(parsed.items) ? parsed.items.length : 'invalid',
          firstItemKeys: Array.isArray(parsed.items) && parsed.items[0] ? Object.keys(parsed.items[0]) : [],
        };
      } catch {
        report.catalog = { ok: false, error: 'catalog.json is not valid JSON' };
      }
    } else {
      report.read = {
        ok: false,
        status: 404,
        error: 'catalog.json does not exist in the repository yet',
        hint: 'It is created the first time you save from the admin panel.',
      };
    }
  } catch (err) {
    report.read = { ok: false, error: err.message, hint: err.hint || '' };
  }

  // diagnostics=2 performs a real commit + delete to prove write access.
  if (url.searchParams.get('diagnostics') === '2') {
    const probe = '.write-test.txt';
    try {
      await ghWriteFile(cfg, probe, 'write-test ' + new Date().toISOString(), 'Write test');
      await ghDeleteFile(cfg, probe, 'Write test cleanup');
      report.write = { ok: true, via: 'real commit', path: probe };
    } catch (err) {
      report.write = { ok: false, status: err.status, error: err.message, hint: err.hint || '' };
    }
  }

  return json(report);
}

function checkAuth(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/admin_session=([^;]+)/);
  const token = match ? match[1] : null;
  return { authenticated: !!(token && token.length >= 10) };
}
