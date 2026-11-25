import { createCaptionControls, isCustomAuthor } from './captions.js';
import { createVariations } from './variations.js';
import { createFlowMotion } from './flow-motion.js';
import { prepareSlotPhoto } from './slot-photo.js';
import {
  AUTHOR_MAX_LENGTH, createCatalogConnection, getCatalogConfig, IMAGE_CATEGORIES, SLOT_COUNT,
} from './supabase.js';

const byId = id => document.getElementById(id);
const element = (tag, className, content) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content) node.textContent = content;
  return node;
};
const detail = byId('detail-dialog');
const slotFile = byId('slot-file');
const replacementFile = byId('replacement-file');
const detailPhoto = byId('detail-image');
const replaceDetail = byId('replace-detail');
const detailFeedback = byId('detail-feedback');
let viewedImage = null;
let feedbackTimer;
const replacing = new Set();
const replacementAttempts = new WeakMap();
let replacementTarget = null;
const slotAnnouncement = byId('slot-announcement');
const busySlots = new Set();
const gallery = byId('gallery');
const viewport = byId('flow-viewport');
const previousButton = byId('previous-image');
const nextButton = byId('next-image');
const favoriteButton = byId('flow-favorite');
const variationsToggle = byId('variations-toggle');
const authorDialog = byId('author-dialog');
const authorSelect = byId('author-select');
const authorCustom = byId('author-custom');
const categorySelect = byId('category-select');
const metadataDrafts = new Map();
const pendingFields = new WeakMap();
const flowCounter = byId('results');
const announcement = byId('flow-announcement');
const favoritesKey = 'acervo-favoritos-v1';
const state = {
  albums: new Map(),
  images: new Map(),
  source: null,
  pending: false,
  error: '',
};
let activeIndex = 0;
let activeSlot = null;
let step = 128;
let radius = 3;
let pickerSlot = 0;
authorCustom.maxLength = AUTHOR_MAX_LENGTH;
const covers = new Map();
let applyCustomAuthor = null;
const captions = createCaptionControls({
  authorSelect, categorySelect, authorCaption: byId('author-caption'), categoryCaption: byId('category-caption'),
  onChange: (field, value) => changeCaption(activeIndex + 1, field, value),
  onCustomAuthor: () => {
    const slot = activeIndex + 1;
    editCustomAuthor(albumMetadata(slot), name => changeCaption(slot, 'author', name));
  },
});
const variations = createVariations({
  getImages: imagesForCover,
  uploadVariation,
  editImage,
  isSaving,
  editCustomAuthor,
  openPhoto: openDetail,
  report: reportSlot,
});
const motion = createFlowMotion(viewport, {
  getStep: () => state.pending ? 0 : step,
  onPosition: updateFlow,
  onVerticalSwipe(direction) {
    if (direction === 'up') openVariations();
  },
  onSettle: () => {
    announcement.textContent = `Álbum ${activeIndex + 1} de ${SLOT_COUNT}.`;
  },
});
let toastTimer;

function readLegacyFavorites() {
  try {
    const entries = JSON.parse(localStorage.getItem(favoritesKey));
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

async function importLocalFavorites(source, projectUrl) {
  const prefix = projectUrl + ':';
  let retryNeeded = false;
  for (const entry of readLegacyFavorites()) {
    if (typeof entry !== 'string' || !entry.startsWith(prefix) || state.source !== source) continue;
    const image = state.images.get(entry.slice(prefix.length));
    if (!image || isSaving(image, 'favorite')) continue;
    try {
      await persistField(image, 'favorite', () => source.importFavorite(image.id));
    } catch {
      retryNeeded = true;
      continue;
    }
    try {
      // Re-read so another tab's edits are preserved.
      const remaining = readLegacyFavorites().filter(key => key !== entry);
      localStorage.setItem(favoritesKey, JSON.stringify(remaining));
    } catch {}
  }
  if (retryNeeded) reportSlot('Alguns corações deste aparelho serão sincronizados quando você reabrir o Acervo.');
}

function albumNumber(album) {
  return String(album).padStart(2, '0');
}

function updateImageActions() {
  const image = state.albums.get(activeIndex + 1);
  const favorite = Boolean(image?.favorite);
  favoriteButton.disabled = !image || isSaving(image, 'favorite');
  favoriteButton.setAttribute('aria-pressed', String(favorite));
  favoriteButton.setAttribute('aria-label', favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos');
  variationsToggle.disabled = !image;
}

function openVariations() {
  motion.jumpTo(Math.round(motion.getPosition()));
  const parent = state.albums.get(activeIndex + 1);
  if (parent) variations.open(parent);
}

function imagesForCover(parentId) {
  const root = state.images.get(parentId);
  if (!root) return [];
  const siblings = [...state.images.values()].filter(image => image.parentId === parentId);
  // Supabase sends UTC timestamps; use the ID as a stable tie-breaker for concurrent inserts.
  siblings.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return [root, ...siblings];
}

function albumMetadata(slot) {
  return state.albums.get(slot) ?? metadataDrafts.get(slot) ?? {};
}

function isSaving(image, field) {
  return pendingFields.get(image)?.has(field) ?? false;
}

function renderMetadata(slot) {
  if (activeIndex + 1 !== slot) return;
  const image = state.albums.get(slot);
  const unavailable = busySlots.has(slot) || !state.source;
  captions.render(albumMetadata(slot), {
    authorDisabled: unavailable || isSaving(image, 'author'),
    categoryDisabled: unavailable || isSaving(image, 'category'),
  });
}

function refreshImage(image) {
  if (image.slot === activeIndex + 1) updateCaption();
  variations.refresh();
}

async function persistField(image, field, save, optimisticValue = image[field]) {
  const fields = pendingFields.get(image) ?? new Set();
  if (fields.has(field)) return;
  fields.add(field);
  pendingFields.set(image, fields);
  const previous = image[field];
  image[field] = optimisticValue;
  refreshImage(image);
  try {
    const saved = await save();
    image[field] = saved[field];
  } catch (error) {
    image[field] = previous;
    throw error;
  } finally {
    fields.delete(field);
    refreshImage(image);
  }
}

async function editImage(image, field, value) {
  const updated = field === 'favorite' ? value : value || null;
  if (image[field] === updated) return;
  const source = state.source;
  if (!source) throw new Error('A conexão com o catálogo está indisponível.');
  await persistField(image, field, () => source.updateImageMetadata({ id: image.id, [field]: updated }), updated);
}

function changeCaption(slot, field, value) {
  if (!state.source || busySlots.has(slot)) return;
  const image = state.albums.get(slot);
  if (image) {
    void editImage(image, field, value).catch(error => reportSlot(`Álbum ${albumNumber(slot)}: ${error.message}`));
  } else {
    metadataDrafts.set(slot, { ...metadataDrafts.get(slot), [field]: value });
    renderMetadata(slot);
  }
}

function updateCaption() {
  const album = activeIndex + 1;
  flowCounter.textContent = `${albumNumber(album)} / ${SLOT_COUNT}`;
  renderMetadata(album);
  updateImageActions();
}

function renderCollection() {
  byId('flow').hidden = state.pending || Boolean(state.error);
  byId('loading').hidden = !state.pending;
  const error = byId('empty');
  error.hidden = !state.error;
  byId('empty-copy').textContent = state.error;
  measureFlow();
  updateFlow(motion.getPosition());
  for (const [slot, cover] of covers) updateCover(cover, slot === activeSlot);
  updateCaption();
}

function measureFlow() {
  const width = viewport.clientWidth;
  if (!width) return;
  step = Math.max(92, Math.min(222, width * 0.38));
  radius = width >= 780 ? 5 : width >= 565 ? 4 : 3;
}

function updateFlow(position) {
  const center = Math.round(position);
  const reach = radius;
  const first = center - reach;
  const last = center + reach;

  if (center !== activeSlot || covers.size !== last - first + 1) {
    for (const [slot, cover] of covers) {
      if (slot >= first && slot <= last) continue;
      if (document.activeElement === cover) viewport.focus({ preventScroll: true });
      cover.remove();
      covers.delete(slot);
    }
    for (let slot = first; slot <= last; slot += 1) {
      if (covers.has(slot)) continue;
      const album = ((slot % SLOT_COUNT) + SLOT_COUNT) % SLOT_COUNT + 1;
      const cover = createCover(album, slot);
      covers.set(slot, cover);
      gallery.append(cover);
    }
  }

  for (const [slot, cover] of covers) {
    const offset = slot - position;
    const distance = Math.abs(offset);
    const direction = Math.sign(offset);
    const approach = Math.min(distance, 1);
    const spacing = approach + Math.max(0, distance - 1) * 0.54;
    const x = direction * step * spacing;
    const y = 8 * approach;
    const depth = -80 * approach - 46 * Math.max(0, distance - 1);
    const angle = -52 * direction * approach;
    cover.style.transform = `perspective(920px) translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, ${depth.toFixed(2)}px) rotateY(${angle.toFixed(2)}deg)`;
    cover.style.zIndex = String(600 - Math.round(distance * 100));
    cover.style.setProperty('--shade', Math.min(.69, distance * .29));
    if (center !== activeSlot) {
      const active = slot === center;
      cover.classList.toggle('is-active', active);
      cover.tabIndex = active ? 0 : -1;
      if (active) cover.setAttribute('aria-current', 'true');
      else cover.removeAttribute('aria-current');
      updateCover(cover, active);
    }
  }
  if (center === activeSlot) return;
  activeSlot = center;
  activeIndex = ((center % SLOT_COUNT) + SLOT_COUNT) % SLOT_COUNT;
  updateCaption();
}

function createCover(album, slot) {
  const cover = element('button', 'flow-cover');
  cover.type = 'button';
  cover.dataset.album = album;
  cover.dataset.slot = slot;
  cover.tabIndex = -1;
  updateCover(cover, false);
  cover.addEventListener('click', event => {
    if (event.detail !== 0 && motion.shouldSuppressClick()) return;
    if (Math.abs(motion.getPosition() - slot) > 0.035) {
      motion.moveTo(slot);
      return;
    }
    if (state.pending || busySlots.has(album)) return;
    const image = state.albums.get(album);
    if (image) {
      openDetail(image);
      return;
    }
    if (!state.source) {
      reportSlot('O envio ficará disponível quando o Acervo estiver conectado ao Supabase.');
      return;
    }
    pickerSlot = album;
    slotFile.value = '';
    slotFile.click();
  });
  return cover;
}

function placeholderIcon(name) {
  const namespace = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(namespace, 'svg');
  const use = document.createElementNS(namespace, 'use');
  icon.setAttribute('class', 'flow-placeholder-icon');
  icon.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', `#i-${name}`);
  icon.append(use);
  return icon;
}

function updateCover(cover, active) {
  const album = Number(cover.dataset.album);
  const image = state.albums.get(album);
  const busy = busySlots.has(album);
  const type = busy ? 'busy' : image ? 'filled' : 'empty';
  const label = active
    ? busy ? 'Salvando foto no' : image ? 'Abrir foto do' : 'Adicionar foto ao'
    : 'Selecionar';
  cover.setAttribute('aria-label', `${label} álbum ${albumNumber(album)}`);
  if (active && busy) cover.setAttribute('aria-busy', 'true');
  else cover.removeAttribute('aria-busy');
  if (cover.dataset.state === type && cover.dataset.src === (image?.src ?? '')) return;

  cover.dataset.state = type;
  cover.dataset.src = image?.src ?? '';
  let content;
  if (image && !busy) {
    content = element('img', 'flow-image');
    content.src = image.src;
    content.alt = '';
    content.decoding = 'async';
    content.draggable = false;
  } else {
    content = element('span', 'flow-placeholder');
    content.append(placeholderIcon(busy ? 'upload' : 'plus'));
  }
  const reflection = content.cloneNode(true);
  reflection.classList.add('flow-reflection');
  reflection.setAttribute('aria-hidden', 'true');
  cover.replaceChildren(content, reflection);
}

function updateDetailAction() {
  const busy = replacing.has(viewedImage?.id);
  replaceDetail.disabled = !viewedImage || busy;
  replaceDetail.setAttribute('aria-busy', String(busy));
}

function clearDetailFeedback() {
  clearTimeout(feedbackTimer);
  detailFeedback.hidden = true;
  detailFeedback.textContent = '';
}

function openDetail(image) {
  viewedImage = image;
  clearDetailFeedback();
  updateDetailAction();
  detailPhoto.alt = image.parentId ? (image.title || 'Variação da capa') : `Foto do álbum ${albumNumber(image.slot)}`;
  detailPhoto.src = image.src;
  detail.showModal();
}

function renderAlbum(album) {
  for (const [slot, cover] of covers) {
    if (Number(cover.dataset.album) === album) updateCover(cover, slot === activeSlot);
  }
  if (activeIndex + 1 === album) updateCaption();
}

function rememberImage(image) {
  state.images.set(image.id, image);
  if (Number.isInteger(image.slot) && image.slot >= 1 && image.slot <= SLOT_COUNT) {
    state.albums.set(image.slot, image);
  }
}

function reportSlot(message) {
  slotAnnouncement.textContent = message;
  showToast(message);
}

async function refreshTakenSlot(slot, source) {
  try {
    const images = await source.listImages();
    const image = images.find(item => item.slot === slot);
    if (image && state.source === source) {
      rememberImage(image);
      for (const variant of images.filter(item => item.parentId === image.id)) rememberImage(variant);
      metadataDrafts.delete(slot);
    }
  } catch (error) {
    console.warn('O álbum ocupado será atualizado quando a galeria for recarregada.', error);
  }
}

function applyReplacement(image, saved) {
  // Caption and favorite edits can finish while a new file is uploading.
  for (const field of ['storagePath', 'src', 'width', 'height', 'fileName', 'fileSize']) {
    image[field] = saved[field];
  }
  if (image.slot) renderAlbum(image.slot);
  if (detail.open && viewedImage?.id === image.id) detailPhoto.src = image.src;
}

async function replacePhoto(image, file) {
  const source = state.source;
  if (!source || replacing.has(image.id)) return;
  replacing.add(image.id);
  updateDetailAction();
  const root = image.parentId ? state.images.get(image.parentId) : image;
  const label = image.parentId ? 'Variação' : 'Capa';
  let message;
  let failed = false;
  try {
    const photo = await prepareSlotPhoto(file);
    const key = JSON.stringify([image.storagePath, file.name, file.size, file.lastModified]);
    let attempt = replacementAttempts.get(image);
    if (!attempt || attempt.key !== key) {
      attempt = { key, id: crypto.randomUUID() };
      replacementAttempts.set(image, attempt);
    }
    const saved = await source.replaceImage({ image, file: photo, clientUploadId: attempt.id });
    applyReplacement(image, saved);
    replacementAttempts.delete(image);
    message = `${label} do álbum ${albumNumber(root.slot)} trocada.`;
  } catch (error) {
    if (error.currentImage?.id === image.id) {
      applyReplacement(image, error.currentImage);
      replacementAttempts.delete(image);
    }
    message = error.message;
    failed = true;
  } finally {
    replacing.delete(image.id);
    updateDetailAction();
    variations.refresh();
  }
  if (detail.open && viewedImage?.id === image.id) {
    if (failed) {
      detailFeedback.textContent = message;
      detailFeedback.hidden = false;
      feedbackTimer = setTimeout(clearDetailFeedback, 7000);
    }
  } else if (!variations.notifyImage(image, message, failed)) {
    reportSlot(message);
  }
}

async function prepareSlotUpload(slot, file) {
  const source = state.source;
  if (!source || busySlots.has(slot)) return;
  const metadata = albumMetadata(slot);
  busySlots.add(slot);
  renderAlbum(slot);
  slotAnnouncement.textContent = `Preparando foto ${slot}.`;
  try {
    const photo = await prepareSlotPhoto(file);
    const image = await source.uploadImage({
      file: photo,
      title: `Foto ${albumNumber(slot)}`,
      ...metadata,
      slot,
    });
    if (state.source === source) {
      rememberImage(image);
      metadataDrafts.delete(slot);
    }
    reportSlot(`Foto ${slot} salva no Supabase.`);
  } catch (error) {
    if (error.code === 'slot_occupied') await refreshTakenSlot(slot, source);
    reportSlot(error.message);
  } finally {
    busySlots.delete(slot);
    renderAlbum(slot);
  }
}

// Keep a retry tied to the same upload if the server saved it before the connection dropped.
const variationUploadIds = new Map();
async function uploadVariation(parent, file) {
  const source = state.source;
  if (!source) throw new Error('A conexão com o catálogo está indisponível.');
  const uploadKey = JSON.stringify([parent.id, file.name, file.size, file.lastModified]);
  const clientUploadId = variationUploadIds.get(uploadKey) ?? crypto.randomUUID();
  const photo = await prepareSlotPhoto(file);
  variationUploadIds.set(uploadKey, clientUploadId);
  const image = await source.uploadImage({
    file: photo, parentId: parent.id, clientUploadId,
    title: (file.name.replace(/\.[^.]+$/, '').trim() || 'Variação').slice(0, 120),
    author: parent.author, category: IMAGE_CATEGORIES.includes(parent.category) ? parent.category : null,
  });
  variationUploadIds.delete(uploadKey);
  if (source === state.source && !state.images.has(image.id)) rememberImage(image);
  return state.images.get(image.id) ?? image;
}

async function connectCatalog() {
  if (state.pending) return;
  const config = getCatalogConfig();
  state.source = null;

  if (!config) {
    state.error = 'O Acervo está aguardando a configuração do Supabase.';
    renderCollection();
    return;
  }

  state.error = '';
  state.pending = true;
  renderCollection();
  try {
    const source = createCatalogConnection(config);
    const images = await source.listImages();
    state.albums.clear();
    state.images.clear();
    for (const image of images) rememberImage(image);
    state.source = source;
    void importLocalFavorites(source, config.url);
  } catch (error) {
    state.error = error.message;
  } finally {
    state.pending = false;
    renderCollection();
  }
}

function showToast(message) {
  const toast = byId('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3800);
}

detail.querySelector('[data-close]').addEventListener('click', () => detail.close());
// Keep a picker attached to the cover the user tapped, even during a fling.
for (const select of [authorSelect, categorySelect]) {
  const settleCaption = () => motion.jumpTo(Math.round(motion.getPosition()));
  select.addEventListener('pointerdown', settleCaption);
  select.addEventListener('focus', settleCaption);
}

function editCustomAuthor(image, onSave) {
  applyCustomAuthor = onSave;
  authorCustom.value = isCustomAuthor(image.author) ? image.author : '';
  authorCustom.setCustomValidity('');
  authorDialog.showModal();
  authorCustom.focus();
  authorCustom.select();
}
authorCustom.addEventListener('input', () => authorCustom.setCustomValidity(''));
byId('cancel-author').addEventListener('click', () => authorDialog.close());
byId('author-form').addEventListener('submit', event => {
  event.preventDefault();
  const name = authorCustom.value.trim();
  if (!name) {
    authorCustom.setCustomValidity('Digite o nome do autor.');
    authorCustom.reportValidity();
    return;
  }
  const apply = applyCustomAuthor;
  authorDialog.close();
  if (apply) apply(name);
});
authorDialog.addEventListener('close', () => {
  if (!authorDialog.open) applyCustomAuthor = null;
});

slotFile.addEventListener('change', () => {
  const slot = pickerSlot;
  const file = slotFile.files?.[0];
  pickerSlot = 0;
  slotFile.value = '';
  if (slot && file) void prepareSlotUpload(slot, file);
});
replaceDetail.addEventListener('click', () => {
  if (!detail.open || !viewedImage || replacing.has(viewedImage.id) || !state.source) return;
  clearDetailFeedback();
  replacementTarget = viewedImage;
  replacementFile.value = '';
  replacementFile.click();
});
replacementFile.addEventListener('change', () => {
  const image = replacementTarget;
  const file = replacementFile.files?.[0];
  replacementTarget = null;
  replacementFile.value = '';
  if (image && file) void replacePhoto(image, file);
});
replacementFile.addEventListener('cancel', () => { replacementTarget = null; });
byId('empty-action').addEventListener('click', connectCatalog);
previousButton.addEventListener('click', () => motion.moveBy(-1));
nextButton.addEventListener('click', () => motion.moveBy(1));
variationsToggle.addEventListener('click', openVariations);
favoriteButton.addEventListener('click', () => {
  const image = state.albums.get(activeIndex + 1);
  if (image) void editImage(image, 'favorite', !image.favorite).catch(error => reportSlot(error.message));
});
viewport.addEventListener('keydown', event => {
  if (state.pending || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  if (event.target !== viewport) viewport.focus({ preventScroll: true });
  if (event.key === 'ArrowUp') {
    openVariations();
    return;
  }
  const cycleStart = Math.round(motion.getPosition()) - activeIndex;
  if (event.key === 'Home') motion.moveTo(cycleStart);
  if (event.key === 'End') motion.moveTo(cycleStart + SLOT_COUNT - 1);
  if (event.key === 'ArrowLeft') motion.moveBy(-1);
  if (event.key === 'ArrowRight') motion.moveBy(1);
});
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => {
    measureFlow();
    updateFlow(motion.getPosition());
  }).observe(viewport);
}
detail.addEventListener('close', () => {
  if (detail.open) return;
  viewedImage = null;
  detailPhoto.removeAttribute('src');
  clearDetailFeedback();
});

connectCatalog();
