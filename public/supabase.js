const CONFIG_KEY = 'catalogo-imagens.supabase';
const PAGE_SIZE = 200;
const IMAGE_COLUMNS = 'id,title,category,description,tags,storage_path,created_at,width,height,file_name,file_size';

export const BUCKET = 'catalog-images';
export const TABLE = 'catalog_images';
export const SLOT_COUNT = 30;
export const IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_ACCEPT = Object.keys(IMAGE_TYPES).join(',');

export function jwtRole(key) {
  const parts = key.split('.');
  if (parts.length !== 3) return null;

  try {
    const payload = atob(parts[1].replaceAll('-', '+').replaceAll('_', '/'));
    return JSON.parse(payload).role;
  } catch {
    return null;
  }
}

export function supabaseOrigin(value) {
  let url;

  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new Error('Informe a URL HTTPS do projeto Supabase.');
  }

  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const secure = url.protocol === 'https:' || (isLocal && url.protocol === 'http:');
  if (!secure || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('Use a URL base do projeto Supabase, sem caminhos adicionais.');
  }

  return url.origin;
}

function normalizeConfig(config) {
  const url = supabaseOrigin(config?.url);
  const key = String(config?.key ?? '').trim();
  if (!/^sb_publishable_[\w-]+$/.test(key) && jwtRole(key) !== 'anon') {
    throw new Error('Informe a chave pública do Supabase (publishable ou anon).');
  }

  return { url, key };
}

export function getCatalogConfig() {
  let stored;
  try {
    stored = JSON.parse(localStorage.getItem(CONFIG_KEY));
  } catch {
    // The deployment configuration also works when browser storage is unavailable.
  }

  try {
    return normalizeConfig(stored ?? globalThis.CATALOGO_SUPABASE);
  } catch {
    return null;
  }
}

export function saveCatalogConfig(config) {
  const normalized = normalizeConfig(config);
  localStorage.setItem(CONFIG_KEY, JSON.stringify(normalized));
  return normalized;
}

export function clearCatalogConfig() {
  localStorage.removeItem(CONFIG_KEY);
}

export function isMissingSlotColumn(error) {
  return ['42703', 'PGRST204'].includes(error?.code) && /\bslot\b/i.test(error.message || '');
}

export function toImage(row, url) {
  const path = row.storage_path.split('/').map(encodeURIComponent).join('/');

  return {
    id: row.id,
    src: `${url}/storage/v1/object/public/${BUCKET}/${path}`,
    title: row.title,
    category: row.category,
    description: row.description,
    tags: row.tags,
    createdAt: row.created_at,
    width: row.width,
    height: row.height,
    fileName: row.file_name,
    fileSize: row.file_size,
    slot: row.slot ?? null,
  };
}

async function imageDimensions(file) {
  const preview = URL.createObjectURL(file);

  try {
    const image = new Image();
    image.src = preview;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  } catch {
    throw new Error('O arquivo não pôde ser aberto como imagem.');
  } finally {
    URL.revokeObjectURL(preview);
  }
}

export function normalizeImage({ file, title, category, description, tags, slot }) {
  if (!(file instanceof File) || !Object.hasOwn(IMAGE_TYPES, file.type) || !file.size) {
    throw new Error('Escolha uma imagem JPEG, PNG, WebP, GIF ou AVIF.');
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error('A imagem precisa ter no máximo 10 MB.');
  }
  if (!file.name || file.name.length > 255) {
    throw new Error('Use um arquivo com nome de até 255 caracteres.');
  }

  const name = String(title ?? '').trim();
  const group = String(category ?? '').trim();
  const note = String(description ?? '').trim();
  const tagList = Array.isArray(tags) ? tags : String(tags ?? '').split(',');
  const keywords = [...new Set(tagList.map(tag => String(tag).trim()).filter(Boolean))];

  if (!name || name.length > 120) throw new Error('Informe um título com até 120 caracteres.');
  if (!group || group.length > 80) throw new Error('Informe uma categoria com até 80 caracteres.');
  if (note.length > 1000) throw new Error('A descrição deve ter até 1.000 caracteres.');
  if (keywords.length > 15 || keywords.some(tag => tag.length > 40)) {
    throw new Error('Use até 15 tags, com até 40 caracteres cada.');
  }

  const image = { file, title: name, category: group, description: note, tags: keywords };
  if (slot == null || slot === '') return image;

  const position = typeof slot === 'string' && /^\d+$/.test(slot) ? Number(slot) : slot;
  if (!Number.isInteger(position) || position < 1 || position > SLOT_COUNT) {
    throw new Error(`Escolha uma posição de 1 a ${SLOT_COUNT}.`);
  }
  return { ...image, slot: position };
}

export function createCatalogConnection(config) {
  const { url, key } = normalizeConfig(config);
  const legacyKey = jwtRole(key) === 'anon';
  const listHeaders = new Headers({ apikey: key });
  if (legacyKey) listHeaders.set('Authorization', `Bearer ${key}`);

  async function listImages() {
    const images = [];
    let cursor;
    let includeSlot = true;

    for (;;) {
      const params = new URLSearchParams({
        select: includeSlot ? `${IMAGE_COLUMNS},slot` : IMAGE_COLUMNS,
        order: 'created_at.desc,id.desc',
        limit: String(PAGE_SIZE),
      });
      if (cursor) {
        const { created_at: createdAt, id } = cursor;
        params.set('or', `(created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${id}))`);
      }

      let response;
      try {
        response = await fetch(`${url}/rest/v1/${TABLE}?${params}`, {
          headers: listHeaders,
          redirect: 'error',
        });
      } catch (cause) {
        throw new Error('Não foi possível acessar o Supabase. Verifique a conexão e a URL do projeto.', { cause });
      }

      const rows = await response.json().catch(() => null);
      if (!response.ok && includeSlot && isMissingSlotColumn(rows)) {
        includeSlot = false;
        continue;
      }
      if (!response.ok || !Array.isArray(rows)) {
        throw new Error(rows?.message || 'Confira a chave pública e a configuração do catálogo no Supabase.');
      }
      if (!rows.length) return images;

      images.push(...rows.map(row => toImage(row, url)));
      cursor = rows.at(-1);
    }
  }

  async function uploadImage(fields, token) {
    const uploadToken = String(token ?? '').trim();
    if (!uploadToken) throw new Error('Informe o token de envio.');
    const { file, tags, ...metadata } = normalizeImage(fields);
    const dimensions = await imageDimensions(file);
    const form = new FormData();
    for (const [name, value] of Object.entries({ ...metadata, ...dimensions, supabaseUrl: url })) {
      form.set(name, value);
    }
    form.set('file', file, file.name);
    for (const tag of tags) form.append('tags', tag);

    let response;
    try {
      response = await fetch(`${url}/functions/v1/acervo-images`, {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${uploadToken}` },
        body: form,
        redirect: 'error',
      });
    } catch (cause) {
      throw new Error('Não foi possível acessar o serviço de envio do catálogo.', { cause });
    }

    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.id) {
      const error = new Error(body?.error || 'O serviço de envio do catálogo não está disponível.');
      error.status = response.status;
      error.code = body?.code;
      throw error;
    }
    return body;
  }

  return { listImages, uploadImage };
}
