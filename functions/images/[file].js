// Serves /images/<file> from the GitHub repository with edge caching.
// Needed because the Pages project is deployed by direct upload, so the
// repository's images/ folder is not part of the static bundle.
import { ghConfig, repoPathLabel } from '../_github.js';

const ALLOWED = /^[A-Za-z0-9._-]+\.(webp|jpe?g|png|avif|gif)$/i;

const CONTENT_TYPES = {
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  avif: 'image/avif',
  gif: 'image/gif',
};

function contentTypeFor(name) {
  const ext = name.split('.').pop().toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

export async function onRequestGet(context) {
  const { params, env } = context;
  const name = Array.isArray(params.file) ? params.file.join('/') : (params.file || '');

  if (!name || !ALLOWED.test(name)) {
    return new Response('Not found', { status: 404 });
  }

  const cfg = await ghConfig(env);
  if (!cfg.configured) {
    return new Response('Image storage is not configured', { status: 503 });
  }

  const path = repoPathLabel(cfg, 'images/' + name);
  const url = 'https://raw.githubusercontent.com/' + cfg.owner + '/' + cfg.repo + '/' +
    cfg.branch + '/' + path.split('/').map(encodeURIComponent).join('/');

  const headers = { 'User-Agent': 'ai-prompt-admin' };
  if (cfg.token) headers.Authorization = 'Bearer ' + cfg.token;

  const upstream = await fetch(url, { headers });

  if (!upstream.ok) {
    const status = upstream.status === 404 ? 404 : 502;
    return new Response(status === 404 ? 'Image not found in the repository' : 'Image storage error', { status });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || contentTypeFor(name),
      'Cache-Control': 'public, max-age=604800',
      'Access-Control-Allow-Origin': '*',
      'X-Image-Source': 'github',
    },
  });
}
