import {
  BUCKET, TABLE, SLOT_COUNT, IMAGE_TYPES, MAX_IMAGE_BYTES,
  isMissingSlotColumn, jwtRole, supabaseOrigin, normalizeImage, toImage,
} from '../public/supabase.js';

const MAX_REQUEST_BYTES = MAX_IMAGE_BYTES + 32 * 1024;
const encoder = new TextEncoder();

function json(data, status) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function uploadFailure() {
  return json({ error: 'O Supabase não salvou a imagem. Confira a configuração do servidor e execute o SQL atualizado.' }, 502);
}

function occupiedSlot(slot) {
  return json({ code: 'slot_occupied', error: `O álbum ${slot} já tem uma foto. Escolha outro álbum.` }, 409);
}

function slotMigrationRequired() {
  return json({
    code: 'slot_schema_missing',
    error: `Execute o SQL atualizado no projeto Supabase para usar as ${SLOT_COUNT} posições.`,
  }, 503);
}

async function matchesToken(candidate, expected) {
  if (!candidate) return false;

  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(candidate)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(left, right);
  }

  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < leftBytes.length; i += 1) {
    difference |= leftBytes[i] ^ rightBytes[i];
  }
  return difference === 0;
}

async function readUploadForm(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!request.body || !/^multipart\/form-data\s*;/i.test(contentType)) {
    throw new Error('Envie os dados e a imagem em um formulário.');
  }

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new Error('A imagem precisa ter no máximo 10 MB.');
    }
    chunks.push(value);
  }

  try {
    return await new Response(new Blob(chunks), { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    throw new Error('Não foi possível abrir o formulário de envio.');
  }
}

async function matchesImageType(file) {
  const bytes = new Uint8Array(await file.slice(0, 256).arrayBuffer());
  const text = String.fromCharCode(...bytes);

  switch (file.type) {
    case 'image/jpeg':
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/png':
      return text.startsWith('\x89PNG\r\n\x1a\n');
    case 'image/gif':
      return text.startsWith('GIF87a') || text.startsWith('GIF89a');
    case 'image/webp':
      return text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP';
    case 'image/avif': {
      if (text.slice(4, 8) !== 'ftyp') return false;
      const brands = ['avif', 'avis'];
      if (brands.includes(text.slice(8, 12))) return true;
      const limit = Math.min(new DataView(bytes.buffer).getUint32(0), text.length);
      for (let i = 16; i + 4 <= limit; i += 4) {
        if (brands.includes(text.slice(i, i + 4))) return true;
      }
      return false;
    }
    default:
      return false;
  }
}

function getSupabaseRequest(env) {
  const url = supabaseOrigin(env.SUPABASE_URL);
  const key = String(env.SUPABASE_SECRET_KEY ?? '').trim();
  const legacyKey = jwtRole(key) === 'service_role';
  if (!/^sb_secret_[\w-]+$/.test(key) && !legacyKey) {
    throw new Error('A chave de servidor do Supabase está ausente ou inválida.');
  }

  function request(path, options = {}) {
    const headers = new Headers(options.headers);
    headers.set('apikey', key);
    headers.set('User-Agent', 'AcervoCatalogWorker/1.0');
    if (legacyKey) headers.set('Authorization', `Bearer ${key}`);
    return fetch(`${url}${path}`, { ...options, headers, redirect: 'error' });
  }

  return { url, request };
}

async function saveImage({ url, request }, { file, ...metadata }) {
  const tablePath = `/rest/v1/${TABLE}`;
  const { slot } = metadata;
  if (slot !== undefined) {
    const check = await request(`${tablePath}?slot=eq.${slot}&select=id&limit=1`).catch(() => null);
    const matches = await check?.json().catch(() => null);
    if (isMissingSlotColumn(matches)) return slotMigrationRequired();
    if (!check?.ok || !Array.isArray(matches)) return uploadFailure();
    if (matches.length) return occupiedSlot(slot);
  }

  const id = crypto.randomUUID();
  const storagePath = `token/${id}.${IMAGE_TYPES[file.type]}`;
  const objectPath = `/storage/v1/object/${BUCKET}/${storagePath}`;

  const object = await request(objectPath, {
    method: 'POST',
    headers: { 'Content-Type': file.type, 'Cache-Control': 'max-age=3600' },
    body: file,
  }).catch(() => null);
  if (!object?.ok) return uploadFailure();

  const inserted = await request(tablePath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      ...metadata,
      id,
      storage_path: storagePath,
      file_name: file.name,
      file_size: file.size,
    }),
  }).catch(() => null);

  const result = await inserted?.json().catch(() => null);
  if (inserted?.ok && result?.[0]) return json(toImage(result[0], url), 201);

  const lookup = await request(`${tablePath}?id=eq.${id}`).catch(() => null);
  const recovered = lookup?.ok ? await lookup.json().catch(() => null) : null;
  if (recovered?.[0]) return json(toImage(recovered[0], url), 201);

  // Delete only when Supabase rejected the insert and confirms that the row is absent.
  if (inserted?.status >= 400 && inserted.status < 500 && Array.isArray(recovered) && !recovered.length) {
    await request(objectPath, { method: 'DELETE' }).catch(() => {});
  }
  if (slot !== undefined && isMissingSlotColumn(result)) return slotMigrationRequired();
  if (slot !== undefined && result?.code === '23505' &&
      /catalog_images_slot_key|Key \(slot\)/i.test(`${result.message} ${result.details}`)) {
    return occupiedSlot(slot);
  }
  return uploadFailure();
}

export async function handleImageUpload(request, env) {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  }

  const expected = String(env.ACERVO_UPLOAD_TOKEN ?? '').trim();
  if (!expected) return json({ error: 'O token de envio ainda precisa ser configurado no servidor.' }, 503);
  const candidate = request.headers.get('Authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!await matchesToken(candidate, expected)) return json({ error: 'Token de envio inválido.' }, 401);

  let supabase;
  try {
    supabase = getSupabaseRequest(env);
  } catch {
    return json({ error: 'A conexão de envio com o Supabase ainda precisa ser configurada no servidor.' }, 503);
  }

  if (Number(request.headers.get('Content-Length')) > MAX_REQUEST_BYTES) {
    return json({ error: 'A imagem precisa ter no máximo 10 MB.' }, 413);
  }

  let image;
  try {
    const form = await readUploadForm(request);
    if (supabaseOrigin(form.get('supabaseUrl')) !== supabase.url) {
      return json({ error: 'Para enviar, conecte o catálogo ao projeto Supabase configurado no servidor.' }, 409);
    }

    const width = Number(form.get('width'));
    const height = Number(form.get('height'));
    if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 2147483647)) {
      return json({ error: 'Não foi possível ler as dimensões da imagem.' }, 400);
    }
    image = {
      ...normalizeImage({
        file: form.get('file'),
        title: form.get('title'),
        category: form.get('category'),
        description: form.get('description'),
        tags: form.getAll('tags'),
        slot: form.get('slot'),
      }),
      width,
      height,
    };
    if (!await matchesImageType(image.file)) return json({ error: 'O conteúdo do arquivo não corresponde ao formato da imagem.' }, 400);
  } catch (error) {
    return json({ error: error.message }, 400);
  }

  return saveImage(supabase, image);
}
