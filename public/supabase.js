const PAGE_SIZE = 200;
const IMAGE_COLUMNS = 'id,title,category,description,tags,storage_path,created_at,width,height,file_name,file_size';

export const BUCKET = 'catalog-images';
export const TABLE = 'catalog_images';
export const SLOT_COUNT = 30;
export const AUTHOR_OPTIONS = Object.freeze(['Yasmim', 'Áquila', 'Jonathan', 'Outro']);
export const AUTHOR_MAX_LENGTH = 80;
export const IMAGE_CATEGORIES = Object.freeze(['Logo', 'Frases', 'Desenho', 'Outro']);
export const IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_ACCEPT = Object.keys(IMAGE_TYPES).join(',');
const IMAGE_SUFFIXES = Object.values(IMAGE_TYPES).join('|');
const UUID_PATTERN = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';

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
  try {
    return normalizeConfig(globalThis.CATALOGO_SUPABASE);
  } catch {
    return null;
  }
}

export function isMissingCatalogColumn(error, column) {
  return ['42703', 'PGRST204'].includes(error?.code) && new RegExp(`\\b${column}\\b`, 'i').test(error.message || '');
}

export function toImage(row, url) {
  const path = row.storage_path.split('/').map(encodeURIComponent).join('/');

  return {
    id: row.id,
    src: `${url}/storage/v1/object/public/${BUCKET}/${path}`,
    storagePath: row.storage_path,
    title: row.title,
    author: row.author ?? null,
    category: row.category ?? null,
    description: row.description,
    tags: row.tags,
    createdAt: row.created_at,
    width: row.width,
    height: row.height,
    fileName: row.file_name,
    fileSize: row.file_size,
    slot: row.slot ?? null,
    parentId: row.parent_id ?? null,
    favorite: row.favorite === true,
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

export function normalizeImageMetadata({ author, category }) {
  const name = typeof author === 'string' ? author.trim() : '';
  const group = typeof category === 'string' ? category.trim() : '';

  if ((author != null && typeof author !== 'string') || name.includes('\0') || [...name].length > AUTHOR_MAX_LENGTH) {
    throw new Error(`Use um nome de autor com até ${AUTHOR_MAX_LENGTH} caracteres.`);
  }
  if ((category != null && typeof category !== 'string') || (group && !IMAGE_CATEGORIES.includes(group))) {
    throw new Error('Escolha uma das categorias disponíveis.');
  }
  return { author: name || null, category: group || null };
}

export function normalizeMetadataPatch(fields) {
  const keys = ['author', 'category', 'favorite'].filter(key => Object.hasOwn(fields, key));
  if (!keys.length) throw new Error('Informe autor, categoria ou favorito para editar a foto.');
  if (keys.includes('favorite') && typeof fields.favorite !== 'boolean') {
    throw new Error('Informe se a foto é favorita.');
  }

  const metadata = { ...normalizeImageMetadata(fields), favorite: fields.favorite };
  return Object.fromEntries(keys.map(key => [key, metadata[key]]));
}

export function normalizeSlot(slot) {
  const position = typeof slot === 'string' && /^\d+$/.test(slot) ? Number(slot) : slot;
  if (!Number.isInteger(position) || position < 1 || position > SLOT_COUNT) {
    throw new Error(`Escolha um álbum de 1 a ${SLOT_COUNT}.`);
  }
  return position;
}

function normalizeUuid(value) {
  if (typeof value !== 'string' || !new RegExp(`^${UUID_PATTERN}$`, 'i').test(value)) {
    throw new Error('O identificador da foto é inválido.');
  }
  return value.toLowerCase();
}

export function normalizeImageTarget({ id, slot }) {
  if (id == null) return { slot: normalizeSlot(slot) };
  if (slot != null) throw new Error('Escolha apenas uma foto para editar.');
  return { id: normalizeUuid(id) };
}

function validateImageFile(file) {
  if (!(file instanceof File) || !Object.hasOwn(IMAGE_TYPES, file.type) || !file.size) {
    throw new Error('Escolha uma imagem JPEG, PNG, WebP, GIF ou AVIF.');
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error('A imagem precisa ter no máximo 10 MB.');
  }
  if (!file.name || file.name.length > 255) {
    throw new Error('Use um arquivo com nome de até 255 caracteres.');
  }
}

export function normalizeReplacement({ id, expectedStoragePath, clientUploadId, file }) {
  validateImageFile(file);
  const imageId = normalizeUuid(id);
  const pathPattern = new RegExp(`^token/${imageId}(?:/${UUID_PATTERN}-[0-9a-f]{64})?\\.(?:${IMAGE_SUFFIXES})$`);
  if (typeof expectedStoragePath !== 'string' || !pathPattern.test(expectedStoragePath)) {
    throw new Error('O arquivo atual da foto é inválido. Atualize o catálogo e tente novamente.');
  }
  return { id: imageId, expectedStoragePath, clientUploadId: normalizeUuid(clientUploadId), file };
}

export function normalizeImage({ file, title, author, category, description, tags, slot, parentId, clientUploadId }) {
  validateImageFile(file);

  const name = String(title ?? '').trim();
  const note = String(description ?? '').trim();
  const tagList = Array.isArray(tags) ? tags : String(tags ?? '').split(',');
  const keywords = [...new Set(tagList.map(tag => String(tag).trim()).filter(Boolean))];

  if (!name || name.length > 120) throw new Error('Informe um título com até 120 caracteres.');
  if (note.length > 1000) throw new Error('A descrição deve ter até 1.000 caracteres.');
  if (keywords.length > 15 || keywords.some(tag => tag.length > 40)) {
    throw new Error('Use até 15 tags, com até 40 caracteres cada.');
  }

  let location;
  if (parentId == null) {
    location = { slot: normalizeSlot(slot) };
  } else {
    if (slot != null) throw new Error('Uma variação deve pertencer a uma foto de capa.');
    location = { parent_id: normalizeUuid(parentId) };
    if (clientUploadId != null) location.client_upload_id = normalizeUuid(clientUploadId);
  }

  return {
    file,
    title: name,
    description: note,
    tags: keywords,
    ...location,
    ...normalizeImageMetadata({ author, category }),
  };
}

export function createCatalogConnection(config) {
  const { url, key } = normalizeConfig(config);
  const legacyKey = jwtRole(key) === 'anon';
  const listHeaders = new Headers({ apikey: key });
  if (legacyKey) listHeaders.set('Authorization', `Bearer ${key}`);

  async function listImages() {
    const images = [];
    let cursor;
    let optionalColumns = ['slot', 'author', 'parent_id', 'favorite'];

    for (;;) {
      const params = new URLSearchParams({
        select: [IMAGE_COLUMNS, ...optionalColumns].join(','),
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
      if (!response.ok || !Array.isArray(rows)) {
        const unavailable = optionalColumns.find(column => isMissingCatalogColumn(rows, column));
        if (unavailable) {
          optionalColumns = optionalColumns.filter(column => column !== unavailable);
          continue;
        }
        throw new Error(rows?.message || 'Confira a chave pública e a configuração do catálogo no Supabase.');
      }
      if (!rows.length) return images;

      images.push(...rows.map(row => toImage(row, url)));
      cursor = rows.at(-1);
    }
  }

  async function saveImage(method, body, headers = {}, imageId) {
    let response;
    try {
      response = await fetch(`${url}/functions/v1/acervo-images`, {
        method,
        headers: { apikey: key, ...headers },
        body,
        redirect: 'error',
      });
    } catch (cause) {
      throw new Error('Não foi possível acessar o serviço do catálogo.', { cause });
    }

    const image = await response.json().catch(() => null);
    if (!response.ok || !image?.id) {
      const error = new Error(image?.error || 'O serviço do catálogo não está disponível.');
      error.status = response.status;
      error.code = image?.code;
      if (response.status === 409 && error.code === 'replacement_conflict' && image?.currentImage?.id === imageId && imageId) {
        error.currentImage = image.currentImage;
      }
      throw error;
    }
    return image;
  }

  async function uploadImage(fields) {
    const { file, tags, ...metadata } = normalizeImage(fields);
    const dimensions = await imageDimensions(file);
    const form = new FormData();
    for (const [name, value] of Object.entries({ ...metadata, ...dimensions, supabaseUrl: url })) {
      if (value !== null) form.set(name, value);
    }
    form.set('file', file, file.name);
    for (const tag of tags) form.append('tags', tag);
    return saveImage('POST', form);
  }

  async function updateImageMetadata(fields) {
    const metadata = {
      ...normalizeImageTarget(fields),
      ...normalizeMetadataPatch(fields),
      supabaseUrl: url,
    };
    return saveImage('PATCH', JSON.stringify(metadata), { 'Content-Type': 'application/json' });
  }

  async function importFavorite(id) {
    const metadata = { id: normalizeUuid(id), favorite: true, onlyIfUnset: true, supabaseUrl: url };
    return saveImage('PATCH', JSON.stringify(metadata), { 'Content-Type': 'application/json' });
  }

  async function replaceImage({ image, file, clientUploadId = crypto.randomUUID() }) {
    const { file: validatedFile, ...replacement } = normalizeReplacement({
      id: image?.id, expectedStoragePath: image?.storagePath, clientUploadId, file,
    });
    const dimensions = await imageDimensions(validatedFile);
    const form = new FormData();
    for (const [name, value] of Object.entries({ ...replacement, ...dimensions, supabaseUrl: url })) {
      form.set(name, value);
    }
    form.set('file', validatedFile, validatedFile.name);
    return saveImage('PUT', form, {}, replacement.id);
  }

  return { listImages, uploadImage, updateImageMetadata, importFavorite, replaceImage };
}
