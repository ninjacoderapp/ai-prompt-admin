import { ghConfig, ghReadFile, CATALOG_FILE } from '../_github.js';

function body(data, status, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return body({ error: 'Method not allowed' }, 405);
  }

  try {
    const cfg = await ghConfig(env);
    if (!cfg.configured) return body({ error: 'Storage is not configured' }, 500);

    const file = await ghReadFile(cfg, CATALOG_FILE);
    if (!file.exists) return body({ categories: ['boy', 'girl', 'festival', 'other'], items: [] }, 200, { 'Cache-Control': 'public, max-age=60' });

    const etag = '"' + file.sha + '"';
    if (request.headers.get('If-None-Match') === etag) {
      return new Response(null, { status: 304, headers: { 'ETag': etag, 'Cache-Control': 'public, max-age=300' } });
    }

    return new Response(file.text, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'ETag': etag,
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch {
    return body({ error: 'Catalog unavailable' }, 502);
  }
}
