// GitHub storage adapter shared by the catalog and image functions.
const API = 'https://api.github.com';

export const CATALOG_FILE = 'catalog.json';

export class GithubError extends Error {
  constructor(message, status = 500, details = '', hint = '') {
    super(message);
    this.status = status;
    this.details = details;
    this.hint = hint;
  }
}

export function ghHeaders(token, extra = {}) {
  return {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ai-prompt-admin',
    ...extra,
  };
}

function trimSlashes(value) {
  if (!value) return '';
  return String(value).replace(/\\/g, '/').split('/').filter(Boolean).join('/');
}

let cachedLogin = '';

async function detectLogin(token) {
  if (cachedLogin) return cachedLogin;
  try {
    const res = await fetch(API + '/user', { headers: ghHeaders(token) });
    if (res.ok) cachedLogin = (await res.json()).login || '';
  } catch { }
  return cachedLogin;
}

export async function ghConfig(env) {
  const token = env.GITHUB_SECRET || env.GITHUB_TOKEN || '';
  let owner = (env.GITHUB_OWNER || '').trim();
  let repo = (env.GITHUB_REPO || '').trim();

  const combined = (env.GITHUB_REPOSITORY || '').trim();
  if (combined.includes('/')) {
    const [o, r] = combined.split('/');
    owner = owner || o;
    repo = repo || r;
  }
  if (repo.includes('/')) {
    const [o, r] = repo.split('/');
    owner = owner || o;
    repo = r;
  }
  if (!owner && token) owner = await detectLogin(token);

  return {
    token,
    owner,
    repo,
    branch: (env.GITHUB_BRANCH || 'main').trim() || 'main',
    dataPath: trimSlashes(env.GITHUB_DATA_PATH || ''),
    configured: !!(token && owner && repo),
  };
}

function repoRelative(cfg, relative) {
  const rel = trimSlashes(relative);
  if (!cfg.dataPath) return rel;
  return rel ? cfg.dataPath + '/' + rel : cfg.dataPath;
}

export function repoPathLabel(cfg, relative) {
  return repoRelative(cfg, relative);
}

function contentsUrl(cfg, relative) {
  const path = repoRelative(cfg, relative);
  return API + '/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' +
    path.split('/').map(encodeURIComponent).join('/');
}

export function base64Encode(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value) {
  const binary = atob(String(value).replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function utf8Encode(text) { return new TextEncoder().encode(text); }
function utf8Decode(bytes) { return new TextDecoder('utf-8').decode(bytes); }

async function ghError(res, action) {
  let text = '';
  try { text = await res.text(); } catch { }
  let summary = '';
  try {
    const parsed = JSON.parse(text);
    summary = parsed.message || '';
    if (Array.isArray(parsed.errors) && parsed.errors.length) {
      summary += ' (' + parsed.errors.map(e => e.message || e.code || '').filter(Boolean).join(', ') + ')';
    }
  } catch {
    summary = text.substring(0, 300);
  }

  let hint = '';
  if (res.status === 401) {
    hint = 'GITHUB_SECRET is not a valid token. Create a fine-grained PAT (Contents: Read and write on this repository), update the Cloudflare environment variable and redeploy.';
  } else if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    hint = 'GitHub API rate limit reached. Wait a minute and try again.';
  } else if (res.status === 403) {
    hint = 'The token is valid but lacks permission. Fine-grained PATs need Repository permissions -> Contents: Read and write.';
  } else if (res.status === 404) {
    hint = 'Repository, branch or file not found. Check GITHUB_OWNER, GITHUB_REPO and GITHUB_BRANCH. A fine-grained token only sees repositories it was explicitly granted.';
  } else if (res.status === 409) {
    hint = 'The file changed on GitHub since it was read. Saving again retries with the latest version.';
  } else if (res.status === 422) {
    hint = 'GitHub rejected the request. Usually the file exceeds 100 MB or the branch is protected.';
  }

  return new GithubError(
    'GitHub ' + action + ' failed (HTTP ' + res.status + ')' + (summary ? ': ' + summary : ''),
    res.status, summary, hint
  );
}

export async function ghGetMeta(cfg, relative) {
  const res = await fetch(contentsUrl(cfg, relative) + '?ref=' + encodeURIComponent(cfg.branch), { headers: ghHeaders(cfg.token) });
  if (res.status === 404) return null;
  if (!res.ok) throw await ghError(res, 'stat ' + repoRelative(cfg, relative));
  const data = await res.json();
  return Array.isArray(data) ? null : data;
}

export async function ghReadFile(cfg, relative) {
  const url = contentsUrl(cfg, relative) + '?ref=' + encodeURIComponent(cfg.branch);
  const res = await fetch(url, { headers: ghHeaders(cfg.token) });
  if (res.status === 404) return { exists: false, sha: null, size: 0, text: null };
  if (!res.ok) throw await ghError(res, 'read ' + repoRelative(cfg, relative));

  const data = await res.json();
  if (Array.isArray(data)) throw new GithubError(repoRelative(cfg, relative) + ' is a directory, not a file', 400);

  if (data.encoding === 'base64' && data.content) {
    return { exists: true, sha: data.sha, size: data.size || 0, text: utf8Decode(base64ToBytes(data.content)) };
  }
  // The Contents API omits the body for files over 1 MB, so fetch it raw.
  const raw = await fetch(url, { headers: ghHeaders(cfg.token, { Accept: 'application/vnd.github.raw' }) });
  if (!raw.ok) throw await ghError(raw, 'download ' + repoRelative(cfg, relative));
  return { exists: true, sha: data.sha, size: data.size || 0, text: await raw.text() };
}

export async function ghWriteFile(cfg, relative, content, message, sha) {
  const bytes = typeof content === 'string' ? utf8Encode(content) : content;
  const body = { message, content: base64Encode(bytes), branch: cfg.branch };
  if (sha) body.sha = sha;

  const res = await fetch(contentsUrl(cfg, relative), {
    method: 'PUT',
    headers: ghHeaders(cfg.token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await ghError(res, 'write ' + repoRelative(cfg, relative));

  const data = await res.json();
  return {
    sha: data.content ? data.content.sha : null,
    commit: data.commit ? data.commit.sha : null,
    size: data.content ? data.content.size : bytes.length,
  };
}

export async function ghDeleteFile(cfg, relative, message) {
  const meta = await ghGetMeta(cfg, relative);
  if (!meta) return { deleted: false, reason: 'not found' };

  const res = await fetch(contentsUrl(cfg, relative), {
    method: 'DELETE',
    headers: ghHeaders(cfg.token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message, sha: meta.sha, branch: cfg.branch }),
  });
  if (!res.ok) throw await ghError(res, 'delete ' + repoRelative(cfg, relative));

  const data = await res.json();
  return { deleted: true, commit: data.commit ? data.commit.sha : null };
}

export async function ghListDir(cfg, relative) {
  const res = await fetch(contentsUrl(cfg, relative) + '?ref=' + encodeURIComponent(cfg.branch), { headers: ghHeaders(cfg.token) });
  if (res.status === 404) return [];
  if (!res.ok) throw await ghError(res, 'list ' + repoRelative(cfg, relative));
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function readCatalog(cfg) {
  const file = await ghReadFile(cfg, CATALOG_FILE);
  if (!file.exists) return { exists: false, catalog: null, sha: null };
  let catalog;
  try {
    catalog = JSON.parse(file.text);
  } catch (err) {
    throw new GithubError('catalog.json is not valid JSON', 500, err.message,
      'Open the file on GitHub and fix the JSON, or restore an earlier commit.');
  }
  return { exists: true, catalog, sha: file.sha, size: file.size };
}

export async function writeCatalog(cfg, catalog, message) {
  // Minified on purpose: this is what the mobile app downloads on every start.
  const body = JSON.stringify(catalog);
  const meta = await ghGetMeta(cfg, CATALOG_FILE);
  try {
    return await ghWriteFile(cfg, CATALOG_FILE, body, message || 'Update catalog', meta ? meta.sha : undefined);
  } catch (err) {
    // Someone else committed in between: retry once with the latest sha.
    if (err instanceof GithubError && err.status === 409) {
      const fresh = await ghGetMeta(cfg, CATALOG_FILE);
      return await ghWriteFile(cfg, CATALOG_FILE, body, message || 'Update catalog', fresh ? fresh.sha : undefined);
    }
    throw err;
  }
}
