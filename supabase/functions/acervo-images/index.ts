import { handleImageRequest } from '../../../server/upload.js';

function pagesOrigin(): string | null {
  try {
    const url = new URL(Deno.env.get('GITHUB_PAGES_ORIGIN')?.trim() ?? '');
    if (url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password) {
      return url.origin;
    }
  } catch {
    // An absent or invalid origin leaves the function disabled for browsers.
  }
  return null;
}

function supabaseSecretKey(): string | undefined {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    if (typeof keys?.default === 'string' && keys.default.startsWith('sb_secret_')) {
      return keys.default;
    }
  } catch {
    // Projects using legacy credentials can use the runtime's service-role key.
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
}

Deno.serve(async (request) => {
  const allowedOrigin = pagesOrigin();
  const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin' });

  if (!allowedOrigin) {
    return Response.json({ error: 'A origem do GitHub Pages ainda precisa ser configurada.' }, { status: 503, headers });
  }
  if (request.headers.get('Origin') !== allowedOrigin) {
    return Response.json({ error: 'Origem do catálogo não autorizada.' }, { status: 403, headers });
  }

  headers.set('Access-Control-Allow-Origin', allowedOrigin);
  headers.set('Access-Control-Allow-Methods', 'POST, PATCH, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'apikey, content-type');

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  const response = await handleImageRequest(request, {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
    SUPABASE_SECRET_KEY: supabaseSecretKey(),
  });
  response.headers.forEach((value, name) => headers.set(name, value));
  return new Response(response.body, { status: response.status, headers });
});
