import { createFlowMotion } from './flow-motion.js';
import { prepareSlotPhoto } from './slot-photo.js';
import {
  AUTHOR_MAX_LENGTH, AUTHOR_OPTIONS, createCatalogConnection, getCatalogConfig, IMAGE_CATEGORIES, SLOT_COUNT,
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
const slotAnnouncement = byId('slot-announcement');
const busySlots = new Set();
const gallery = byId('gallery');
const viewport = byId('flow-viewport');
const previousButton = byId('previous-image');
const nextButton = byId('next-image');
const favoriteButton = byId('flow-favorite');
const authorCaption = byId('author-caption');
const categoryCaption = byId('category-caption');
const authorDialog = byId('author-dialog');
const authorSelect = byId('author-select');
const authorCustom = byId('author-custom');
const categorySelect = byId('category-select');
const customAuthorOption = element('option');
customAuthorOption.value = 'custom';
customAuthorOption.disabled = true;
customAuthorOption.hidden = true;
authorSelect.insertBefore(customAuthorOption, authorSelect.lastElementChild);
const metadataDrafts = new Map();
let authorDialogSlot = 0;
const flowCounter = byId('results');
const announcement = byId('flow-announcement');
const favoritesKey = 'acervo-favoritos-v1';
const state = {
  albums: new Map(),
  config: null,
  source: null,
  favorites: readFavorites(),
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
const motion = createFlowMotion(viewport, {
  getStep: () => state.pending ? 0 : step,
  onPosition: updateFlow,
  onSettle: () => {
    announcement.textContent = `Álbum ${activeIndex + 1} de ${SLOT_COUNT}.`;
  },
});
let toastTimer;

function readFavorites() {
  try {
    const entries = JSON.parse(localStorage.getItem(favoritesKey));
    return new Set(Array.isArray(entries) ? entries : []);
  } catch {
    return new Set();
  }
}

function favoriteId(image) {
  return `${state.config?.url ?? 'demo'}:${image.id}`;
}

function isFavorite(image) {
  return state.favorites.has(favoriteId(image));
}

function toggleFavorite(image) {
  const id = favoriteId(image);
  if (state.favorites.has(id)) state.favorites.delete(id);
  else state.favorites.add(id);
  try {
    localStorage.setItem(favoritesKey, JSON.stringify([...state.favorites]));
  } catch {}
  updateFavoriteButton();
}

function albumNumber(album) {
  return String(album).padStart(2, '0');
}

function updateFavoriteButton() {
  const image = state.albums.get(activeIndex + 1);
  const favorite = image ? isFavorite(image) : false;
  favoriteButton.disabled = !image;
  favoriteButton.setAttribute('aria-pressed', String(favorite));
  favoriteButton.setAttribute('aria-label', favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos');
}

function albumMetadata(slot) {
  const image = state.albums.get(slot);
  return {
    author: image?.author ?? '',
    category: IMAGE_CATEGORIES.includes(image?.category) ? image.category : '',
    ...metadataDrafts.get(slot),
  };
}

function isCustomAuthor(author) {
  return Boolean(author) && (author === 'Outro' || !AUTHOR_OPTIONS.includes(author));
}

function renderMetadata(slot) {
  if (activeIndex + 1 !== slot) return;
  const { author, category } = albumMetadata(slot);
  const custom = isCustomAuthor(author);
  authorCaption.textContent = author || 'Autor';
  categoryCaption.textContent = category || 'Categoria';
  customAuthorOption.hidden = !custom;
  customAuthorOption.textContent = custom ? author : '';
  authorSelect.value = custom ? 'custom' : author;
  categorySelect.value = category;

  const saving = state.albums.has(slot) ? metadataDrafts.get(slot) : null;
  const unavailable = busySlots.has(slot) || !state.source;
  authorSelect.disabled = unavailable || Boolean(saving && Object.hasOwn(saving, 'author'));
  categorySelect.disabled = unavailable || Boolean(saving && Object.hasOwn(saving, 'category'));
}

async function changeCaption(slot, field, value) {
  const source = state.source;
  if (!source || busySlots.has(slot) || albumMetadata(slot)[field] === value) return;
  const image = state.albums.get(slot);
  const draft = metadataDrafts.get(slot) ?? {};
  if (image && Object.hasOwn(draft, field)) return;
  draft[field] = value;
  metadataDrafts.set(slot, draft);
  renderMetadata(slot);
  if (!image) return;

  try {
    const saved = await source.updateImageMetadata({ slot, [field]: value || null });
    if (source === state.source) image[field] = saved[field];
  } catch (error) {
    reportSlot(`Álbum ${albumNumber(slot)}: ${error.message}`);
  } finally {
    delete draft[field];
    if (!Object.keys(draft).length) metadataDrafts.delete(slot);
    renderMetadata(slot);
  }
}

function updateCaption() {
  const album = activeIndex + 1;
  flowCounter.textContent = `${albumNumber(album)} / ${SLOT_COUNT}`;
  renderMetadata(album);
  updateFavoriteButton();
}

function renderCollection() {
  byId('flow').hidden = state.pending;
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
      openDetail(image, album);
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
  if (cover.dataset.state === type && cover.dataset.image === (image?.id ?? '')) return;

  cover.dataset.state = type;
  cover.dataset.image = image?.id ?? '';
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

function openDetail(image, album) {
  const photo = byId('detail-image');
  photo.alt = `Foto do álbum ${albumNumber(album)}`;
  photo.src = image.src;
  detail.showModal();
}

function renderAlbum(album) {
  for (const [slot, cover] of covers) {
    if (Number(cover.dataset.album) === album) updateCover(cover, slot === activeSlot);
  }
  if (activeIndex + 1 === album) updateCaption();
}

function albumEntries(images) {
  return new Map(images.filter(image => Number.isInteger(image.slot) && image.slot >= 1 && image.slot <= SLOT_COUNT)
    .map(image => [image.slot, image]));
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
      state.albums.set(slot, image);
      metadataDrafts.delete(slot);
    }
  } catch (error) {
    console.warn('O álbum ocupado será atualizado quando a galeria for recarregada.', error);
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
      state.albums.set(slot, image);
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

async function connectCatalog() {
  if (state.pending) return;
  const config = getCatalogConfig();
  state.config = config;
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
    state.albums = albumEntries(images);
    state.source = source;
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
detail.addEventListener('click', event => {
  if (event.target !== detail) return;
  const box = detail.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) detail.close();
});

// Keep a picker attached to the cover the user tapped, even during a fling.
for (const select of [authorSelect, categorySelect]) {
  const settleCaption = () => motion.jumpTo(Math.round(motion.getPosition()));
  select.addEventListener('pointerdown', settleCaption);
  select.addEventListener('focus', settleCaption);
}

authorSelect.addEventListener('change', () => {
  const slot = activeIndex + 1;
  if (authorSelect.value !== 'other') {
    void changeCaption(slot, 'author', authorSelect.value);
    return;
  }
  authorDialogSlot = slot;
  const { author } = albumMetadata(slot);
  authorCustom.value = isCustomAuthor(author) ? author : '';
  authorCustom.setCustomValidity('');
  // Keep the committed selection if the visitor cancels the dialog.
  renderMetadata(slot);
  authorDialog.showModal();
  authorCustom.focus();
  authorCustom.select();
});
categorySelect.addEventListener('change', () => {
  void changeCaption(activeIndex + 1, 'category', categorySelect.value);
});
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
  const slot = authorDialogSlot;
  authorDialog.close();
  if (slot) void changeCaption(slot, 'author', name);
});
authorDialog.addEventListener('close', () => {
  if (!authorDialog.open) authorDialogSlot = 0;
});

slotFile.addEventListener('change', () => {
  const slot = pickerSlot;
  const file = slotFile.files?.[0];
  pickerSlot = 0;
  slotFile.value = '';
  if (slot && file) void prepareSlotUpload(slot, file);
});
byId('empty-action').addEventListener('click', connectCatalog);
previousButton.addEventListener('click', () => motion.moveBy(-1));
nextButton.addEventListener('click', () => motion.moveBy(1));
favoriteButton.addEventListener('click', () => {
  const image = state.albums.get(activeIndex + 1);
  if (image) toggleFavorite(image);
});
viewport.addEventListener('keydown', event => {
  if (state.pending || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  if (event.target !== viewport) viewport.focus({ preventScroll: true });
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
  if (!detail.open) byId('detail-image').removeAttribute('src');
});

connectCatalog();
