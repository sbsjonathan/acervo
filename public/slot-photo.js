import { IMAGE_TYPES, MAX_IMAGE_BYTES } from './supabase.js';

const MAX_PHOTO_EDGE = 2400;
const JPEG_QUALITIES = [0.87, 0.76, 0.62];
const mimeByExtension = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
};
const heifTypes = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);

function photoType(file) {
  if (file.type === 'image/jpg') return 'image/jpeg';
  if (file.type && file.type !== 'application/octet-stream') return file.type;
  const extension = file.name.match(/\.([^.]+)$/)?.[1].toLowerCase();
  return Object.hasOwn(mimeByExtension, extension) ? mimeByExtension[extension] : '';
}

async function loadPhoto(image, source) {
  if (typeof image.decode === 'function') {
    image.src = source;
    await image.decode();
    return;
  }
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = reject;
    image.src = source;
  });
}

async function drawResizedPhoto(file, canvas) {
  const image = new Image();
  const source = URL.createObjectURL(file);

  try {
    await loadPhoto(image, source);
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('Invalid image dimensions');

    // Modern browsers apply the photo's orientation when decoding into an image element.
    const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const drawing = canvas.getContext('2d');
    if (!drawing) throw new Error('Canvas context unavailable');
    drawing.fillStyle = '#fff';
    drawing.fillRect(0, 0, canvas.width, canvas.height);
    drawing.drawImage(image, 0, 0, canvas.width, canvas.height);
  } finally {
    image.removeAttribute('src');
    URL.revokeObjectURL(source);
  }
}

async function convertPhoto(file) {
  const canvas = document.createElement('canvas');
  try {
    try {
      await drawResizedPhoto(file, canvas);
    } catch (cause) {
      const message = heifTypes.has(file.type)
        ? 'Este navegador não conseguiu abrir a foto HEIC. No iPhone, abra a foto em Arquivos e use Ações Rápidas → Converter Imagem para salvar uma cópia JPEG.'
        : 'Não foi possível abrir a foto. Escolha outra imagem ou salve uma cópia em JPEG.';
      throw new Error(message, { cause });
    }

    for (const quality of JPEG_QUALITIES) {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (!blob || blob.type !== 'image/jpeg' || !blob.size || blob.size > MAX_IMAGE_BYTES) continue;
      const base = file.name.replace(/\.[^.]*$/, '').trim().slice(0, 251) || 'foto';
      return new File([blob], `${base}.jpg`, { type: blob.type, lastModified: file.lastModified });
    }
    throw new Error('Não foi possível reduzir a foto para 10 MB. Salve uma cópia JPEG menor e tente novamente.');
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

export async function prepareSlotPhoto(file) {
  if (!(file instanceof File) || !file.size) throw new Error('Escolha uma foto para adicionar.');

  const type = photoType(file);
  if (!Object.hasOwn(IMAGE_TYPES, type) && !heifTypes.has(type)) {
    throw new Error('Escolha uma foto JPEG, PNG, WebP, GIF, AVIF, HEIC ou HEIF.');
  }

  const photo = file.type === type ? file : new File([file], file.name, { type, lastModified: file.lastModified });
  if (Object.hasOwn(IMAGE_TYPES, type) && photo.size <= MAX_IMAGE_BYTES) return photo;
  return convertPhoto(photo);
}
