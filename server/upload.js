import {
  BUCKET, TABLE, SLOT_COUNT, IMAGE_TYPES, MAX_IMAGE_BYTES,
  isMissingCatalogColumn, jwtRole, supabaseOrigin, normalizeImage, normalizeImageTarget,
  normalizeMetadataPatch, normalizeReplacement, toImage,
} from '../public/supabase.js';

const MAX_REQUEST_BYTES = MAX_IMAGE_BYTES + 32 * 1024;
const MAX_METADATA_BYTES = 4096;
const TABLE_PATH = `/rest/v1/${TABLE}`;
const REPLACE_PATH = '/rest/v1/rpc/replace_catalog_image';

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

function metadataMigrationRequired() {
  return json({
    code: 'metadata_schema_missing',
    error: 'Execute o SQL atualizado no projeto Supabase para salvar autor e categoria.',
  }, 503);
}

function variantMigrationRequired() {
  return json({ code: 'variant_schema_missing', error: 'Execute o SQL atualizado para usar variações e favoritos.' }, 503);
}

function catalogSchemaError(error) {
  if (isMissingCatalogColumn(error, 'slot')) return slotMigrationRequired();
  if (isMissingCatalogColumn(error, 'author')) return metadataMigrationRequired();
  if (['parent_id', 'client_upload_id', 'favorite'].some(column => isMissingCatalogColumn(error, column))) {
    return variantMigrationRequired();
  }
  return null;
}

function missingCover() {
  return json({ code: 'cover_not_found', error: 'A foto de capa desse álbum não foi encontrada.' }, 404);
}

async function readRequestBody(body, limit, limitMessage) {
  const reader = body.getReader();
  const chunks = [];
  let size = 0;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error(limitMessage);
    }
    chunks.push(value);
  }
  return new Blob(chunks);
}

async function readUploadForm(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!request.body || !/^multipart\/form-data\s*;/i.test(contentType)) {
    throw new Error('Envie os dados e a imagem em um formulário.');
  }

  const body = await readRequestBody(request.body, MAX_REQUEST_BYTES, 'A imagem precisa ter no máximo 10 MB.');

  try {
    return await new Response(body, { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    throw new Error('Não foi possível abrir o formulário de envio.');
  }
}

function readDimensions(form) {
  const width = Number(form.get('width'));
  const height = Number(form.get('height'));
  if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 2147483647)) {
    throw new Error('Não foi possível ler as dimensões da imagem.');
  }
  return { width, height };
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

async function readCatalog(request, query) {
  const response = await request(`${TABLE_PATH}?${query}`).catch(() => null);
  return response?.json().catch(() => null);
}

async function previousUpload({ url, request }, { client_upload_id, parent_id }) {
  if (!client_upload_id) return null;
  const rows = await readCatalog(request, `client_upload_id=eq.${client_upload_id}&limit=1`);
  if (!Array.isArray(rows)) return catalogSchemaError(rows) ?? uploadFailure();
  const image = rows[0];
  if (!image) return null;
  if (image.parent_id !== parent_id) {
    return json({ error: 'Este envio pertence a outro álbum.' }, 409);
  }
  return json(toImage(image, url), 200);
}

async function saveImage(supabase, { file, ...metadata }) {
  const { url, request } = supabase;
  const { slot, parent_id } = metadata;
  const earlier = await previousUpload(supabase, metadata);
  if (earlier) return earlier;

  const query = parent_id
    ? `id=eq.${parent_id}&slot=not.is.null&select=id,author,parent_id&limit=1`
    : `slot=eq.${slot}&select=id,author&limit=1`;
  const matches = await readCatalog(request, query);
  if (!Array.isArray(matches)) return catalogSchemaError(matches) ?? uploadFailure();
  if (parent_id && !matches.length) return missingCover();
  if (!parent_id && matches.length) return occupiedSlot(slot);

  const id = crypto.randomUUID();
  const storagePath = `token/${id}.${IMAGE_TYPES[file.type]}`;
  const objectPath = `/storage/v1/object/${BUCKET}/${storagePath}`;

  const object = await request(objectPath, {
    method: 'POST',
    headers: { 'Content-Type': file.type, 'Cache-Control': 'max-age=3600' },
    body: file,
  }).catch(() => null);
  if (!object?.ok) return uploadFailure();

  const inserted = await request(TABLE_PATH, {
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

  const recovered = await readCatalog(request, `id=eq.${id}`);
  if (recovered?.[0]) return json(toImage(recovered[0], url), 201);

  // Delete only when Supabase rejected the insert and confirms that the row is absent.
  if (inserted?.status >= 400 && inserted.status < 500 && Array.isArray(recovered) && !recovered.length) {
    await request(objectPath, { method: 'DELETE' }).catch(() => {});
  }
  const schemaError = catalogSchemaError(result);
  if (schemaError) return schemaError;
  if (parent_id && result?.code === '23503') return missingCover();
  if (!parent_id && result?.code === '23505' &&
      /catalog_images_slot_key|Key \(slot\)/i.test(`${result.message} ${result.details}`)) {
    return occupiedSlot(slot);
  }
  return await previousUpload(supabase, metadata) ?? uploadFailure();
}

function replacementConflict(row, url) {
  return json({
    code: 'replacement_conflict',
    error: 'A foto foi alterada em outro envio. Confira a versão atual e tente novamente.',
    currentImage: toImage(row, url),
  }, 409);
}

function replacementFailure() {
  return json({ error: 'Não foi possível substituir a foto no Supabase. Tente novamente.' }, 502);
}

function missingImage() {
  return json({ error: 'A foto não foi encontrada.' }, 404);
}

function canReplaceImage(row) {
  return row.owner_id == null && (row.slot != null || row.parent_id != null);
}

async function hashReplacement(data) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function replaceImage(request, supabase) {
  let replacement;
  let dimensions;
  try {
    const form = await readUploadForm(request);
    if (supabaseOrigin(form.get('supabaseUrl')) !== supabase.url) {
      return json({ error: 'Para substituir, conecte o catálogo ao projeto Supabase configurado no servidor.' }, 409);
    }
    replacement = normalizeReplacement({
      id: form.get('id'), expectedStoragePath: form.get('expectedStoragePath'),
      clientUploadId: form.get('clientUploadId'), file: form.get('file'),
    });
    dimensions = readDimensions(form);
    if (!await matchesImageType(replacement.file)) {
      return json({ error: 'O conteúdo do arquivo não corresponde ao formato da imagem.' }, 400);
    }
  } catch (error) {
    return json({ error: error.message }, 400);
  }

  const { file, id, expectedStoragePath, clientUploadId } = replacement;
  const rows = await readCatalog(supabase.request, `id=eq.${id}`);
  if (!Array.isArray(rows)) return replacementFailure();
  if (!rows.length) return missingImage();
  const current = rows[0];
  if (!canReplaceImage(current)) return json({ error: 'Esta foto não pode ser substituída neste catálogo.' }, 403);

  const fileHash = await hashReplacement(await file.arrayBuffer());
  // The prior path makes retries stable without letting a later replacement reuse an earlier path.
  const version = await hashReplacement(new TextEncoder().encode(`${expectedStoragePath}\n${fileHash}`));
  const newPath = `token/${id}/${clientUploadId}-${version}.${IMAGE_TYPES[file.type]}`;
  const objectPath = `/storage/v1/object/${BUCKET}/`;
  const remove = path => supabase.request(`${objectPath}${path}`, { method: 'DELETE' }).catch(() => null);
  const confirm = async row => {
    await remove(expectedStoragePath);
    return json(toImage(row, supabase.url), 200);
  };

  if (current.storage_path === newPath) return confirm(current);
  if (current.storage_path !== expectedStoragePath) {
    await remove(newPath);
    return replacementConflict(current, supabase.url);
  }

  const uploaded = await supabase.request(`${objectPath}${newPath}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type, 'Cache-Control': 'max-age=3600' },
    body: file,
  }).catch(() => null);
  if (!uploaded?.ok) {
    const error = await uploaded?.json().catch(() => null);
    const exists = uploaded?.status === 409 || String(error?.statusCode) === '409' || error?.error === 'Duplicate';
    if (!exists) return replacementFailure();
  }

  const saved = await supabase.request(REPLACE_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      p_image_id: id,
      p_expected_path: expectedStoragePath,
      p_new_path: newPath,
      p_width: dimensions.width,
      p_height: dimensions.height,
      p_file_name: file.name,
      p_file_size: file.size,
    }),
  }).catch(() => null);
  const out = await saved?.json().catch(() => null);
  if (saved?.ok && out?.[0]?.storage_path === newPath) return confirm(out[0]);

  const latest = await readCatalog(supabase.request, `id=eq.${id}`);
  if (!Array.isArray(latest)) return replacementFailure();
  if (latest[0]?.storage_path === newPath) return confirm(latest[0]);
  if (!latest.length || latest[0].storage_path !== expectedStoragePath) {
    await remove(newPath);
    return latest.length ? replacementConflict(latest[0], supabase.url) : missingImage();
  }
  // The outcome is uncertain while the old path is current. A retry can reuse the immutable upload.
  if (out?.code === 'PGRST202') {
    return json({ code: 'replacement_schema_missing', error: 'Execute o SQL atualizado para substituir fotos.' }, 503);
  }
  return replacementFailure();
}

async function updateMetadata(request, supabase) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!request.body || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return json({ error: 'Envie autor e categoria em JSON.' }, 400);
  }

  const limitMessage = 'Os dados de autor e categoria são muito longos.';
  if (Number(request.headers.get('Content-Length')) > MAX_METADATA_BYTES) {
    return json({ error: limitMessage }, 413);
  }

  let data;
  try {
    const body = await readRequestBody(request.body, MAX_METADATA_BYTES, limitMessage);
    data = JSON.parse(await body.text());
  } catch (error) {
    return json({ error: error instanceof SyntaxError ? 'Não foi possível ler os dados da edição.' : error.message }, 400);
  }

  let target;
  let metadata;
  let onlyIfUnset;
  try {
    if (supabaseOrigin(data?.supabaseUrl) !== supabase.url) {
      return json({ error: 'Para editar, conecte o catálogo ao projeto Supabase configurado no servidor.' }, 409);
    }
    target = normalizeImageTarget(data);
    metadata = normalizeMetadataPatch(data);
    onlyIfUnset = data.onlyIfUnset === true;
    if (onlyIfUnset && (!target.id || metadata.favorite !== true || Object.keys(metadata).length !== 1)) {
      throw new Error('Informe uma foto válida para importar seu favorito.');
    }
  } catch (error) {
    return json({ error: error.message }, 400);
  }

  const query = target.id ? `id=eq.${target.id}` : `slot=eq.${target.slot}`;
  const condition = onlyIfUnset ? '&favorite=is.null' : '';
  const response = await supabase.request(`${TABLE_PATH}?${query}${condition}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(metadata),
  }).catch(() => null);
  let rows = await response?.json().catch(() => null);
  const schemaError = catalogSchemaError(rows);
  if (schemaError) return schemaError;
  if (!response?.ok || !Array.isArray(rows)) return json({ error: 'Não foi possível salvar a edição no Supabase.' }, 502);
  if (!rows.length && onlyIfUnset) {
    rows = await readCatalog(supabase.request, query);
    if (!Array.isArray(rows)) return json({ error: 'Não foi possível carregar o favorito no Supabase.' }, 502);
  }
  if (!rows.length) {
    return json({ error: target.id ? 'A foto não foi encontrada.' : `O álbum ${target.slot} ainda está vazio.` }, 404);
  }
  return json(toImage(rows[0], supabase.url), 200);
}

export async function handleImageRequest(request, env) {
  if (!['POST', 'PATCH', 'PUT'].includes(request.method)) {
    return new Response(null, { status: 405, headers: { Allow: 'POST, PATCH, PUT' } });
  }

  let supabase;
  try {
    supabase = getSupabaseRequest(env);
  } catch {
    return json({ error: 'A conexão com o Supabase ainda precisa ser configurada no servidor.' }, 503);
  }
  if (request.method === 'PATCH') return updateMetadata(request, supabase);

  if (Number(request.headers.get('Content-Length')) > MAX_REQUEST_BYTES) {
    return json({ error: 'A imagem precisa ter no máximo 10 MB.' }, 413);
  }
  if (request.method === 'PUT') return replaceImage(request, supabase);

  let image;
  try {
    const form = await readUploadForm(request);
    if (supabaseOrigin(form.get('supabaseUrl')) !== supabase.url) {
      return json({ error: 'Para enviar, conecte o catálogo ao projeto Supabase configurado no servidor.' }, 409);
    }

    const dimensions = readDimensions(form);
    const category = form.get('category');
    const legacyUpload = !form.has('author') && category === 'Fotos do aparelho';
    image = {
      ...normalizeImage({
        file: form.get('file'),
        title: form.get('title'),
        author: form.get('author'),
        category: legacyUpload ? null : category,
        description: form.get('description'),
        tags: form.getAll('tags'),
        slot: form.get('slot'),
        parentId: form.get('parent_id') ?? form.get('parentId'),
        clientUploadId: form.get('client_upload_id') ?? form.get('clientUploadId'),
      }),
      ...dimensions,
    };
    if (!await matchesImageType(image.file)) return json({ error: 'O conteúdo do arquivo não corresponde ao formato da imagem.' }, 400);
  } catch (error) {
    return json({ error: error.message }, 400);
  }

  return saveImage(supabase, image);
}
