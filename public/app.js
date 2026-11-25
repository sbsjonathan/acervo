import { createFlowMotion } from './flow-motion.js';
import { prepareSlotPhoto } from './slot-photo.js';
import { createCatalogConnection, getCatalogConfig, saveCatalogConfig, clearCatalogConfig, SLOT_COUNT } from './supabase.js';

const byId = id => document.getElementById(id);
const element = (tag, className, content) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content) node.textContent = content;
  return node;
};
const settings = byId('settings-dialog');
const settingsForm = byId('settings-form');
const settingsError = byId('settings-error');
const detail = byId('detail-dialog');
const slotFile = byId('slot-file');
const slotAnnouncement = byId('slot-announcement');
const slotTokenDialog = byId('slot-token-dialog');
const slotTokenForm = byId('slot-token-form');
const busySlots = new Set();
const gallery = byId('gallery');
const viewport = byId('flow-viewport');
const previousButton = byId('previous-image');
const nextButton = byId('next-image');
const favoriteButton = byId('flow-favorite');
const flowTitle = byId('flow-title');
const flowCategory = byId('flow-category');
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
let uploadToken = '';
let pickerSlot = 0;
let deferredSlotUpload = null;
const covers = new Map();
const motion = createFlowMotion(viewport, {
  getStep: () => state.pending ? 0 : step,
  onPosition: updateFlow,
  onSettle: () => {
    announcement.textContent = `Álbum ${activeIndex + 1} de ${SLOT_COUNT}.`;
  },
});
let toastTimer;
let loadId = 0;

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

function updateCaption() {
  const album = activeIndex + 1;
  const image = state.albums.get(album);
  flowTitle.textContent = `Álbum ${albumNumber(album)}`;
  flowCategory.textContent = busySlots.has(album) ? 'Enviando foto…' : image ? '' : 'Toque para adicionar';
  flowCounter.textContent = `${albumNumber(album)} / ${SLOT_COUNT}`;
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

function deferSlotUpload(job, waiting) {
  if (deferredSlotUpload && deferredSlotUpload !== job) {
    throw new Error('Conclua o envio anterior e escolha esta foto novamente.');
  }
  deferredSlotUpload = job;
  job.waiting = waiting;
}

function finishSlotUpload(job) {
  if (deferredSlotUpload === job) deferredSlotUpload = null;
  busySlots.delete(job.slot);
  renderAlbum(job.slot);
}

function requestSlotToken(job, message = '') {
  deferSlotUpload(job, 'token');
  slotTokenForm.reset();
  slotTokenForm.querySelector('.form-message').textContent = message;
  slotTokenDialog.showModal();
}

async function storeSlotUpload(job, token) {
  const source = state.source;
  const image = await source.uploadImage({
    file: job.file,
    title: `Foto ${albumNumber(job.slot)}`,
    category: 'Fotos do aparelho',
    slot: job.slot,
  }, token);
  if (state.source === source) {
    uploadToken = token.trim();
    state.albums.set(job.slot, image);
  }
  finishSlotUpload(job);
  reportSlot(`Foto ${job.slot} salva no Supabase.`);
}

async function refreshTakenSlot(slot) {
  const source = state.source;
  if (!source) return;
  try {
    const images = await source.listImages();
    const image = images.find(item => item.slot === slot);
    if (image && state.source === source) state.albums.set(slot, image);
  } catch {}
}

async function continueSlotUpload(job) {
  try {
    if (state.albums.has(job.slot)) {
      finishSlotUpload(job);
      reportSlot(`O álbum ${job.slot} já tem uma foto.`);
    } else if (!state.source) {
      deferSlotUpload(job, 'connection');
      openSettings();
    } else if (!uploadToken) {
      requestSlotToken(job);
    } else {
      const token = uploadToken;
      try {
        await storeSlotUpload(job, token);
      } catch (error) {
        if (error.status !== 401 && error.status !== 403) throw error;
        if (uploadToken === token) uploadToken = '';
        requestSlotToken(job, 'Informe um token de envio válido para salvar esta foto.');
      }
    }
  } catch (error) {
    if (error.code === 'slot_occupied') await refreshTakenSlot(job.slot);
    finishSlotUpload(job);
    reportSlot(error.message);
  }
}

async function prepareSlotUpload(slot, file) {
  const job = { slot, file: null, waiting: null };
  busySlots.add(slot);
  renderAlbum(job.slot);
  slotAnnouncement.textContent = `Preparando foto ${slot}.`;
  try {
    job.file = await prepareSlotPhoto(file);
    await continueSlotUpload(job);
  } catch (error) {
    finishSlotUpload(job);
    reportSlot(error.message);
  }
}

function updateConnection() {
  const connected = Boolean(state.source && !state.pending && !state.error);
  byId('settings-button').dataset.connected = String(connected);
  byId('connection-label').textContent = connected ? 'Supabase conectado' : 'Conectar Supabase';
}

function openSettings() {
  if (settings.open) return;
  settingsForm.elements.url.value = state.config?.url ?? '';
  settingsForm.elements.key.value = state.config?.key ?? '';
  settingsError.textContent = deferredSlotUpload?.waiting === 'connection'
    ? 'Conecte o Supabase para salvar a foto que você selecionou.'
    : state.error;
  byId('disconnect').hidden = !state.config || Boolean(globalThis.CATALOGO_SUPABASE && state.config.url === globalThis.CATALOGO_SUPABASE.url && state.config.key === globalThis.CATALOGO_SUPABASE.key);
  updateConnection();
  settings.showModal();
}

async function useSavedConnection() {
  const config = getCatalogConfig();
  const currentLoad = ++loadId;
  state.config = config ?? null;
  state.source = null;
  state.error = '';
  state.pending = Boolean(config);
  state.albums = new Map();
  renderCollection();
  updateConnection();
  if (!config) return;
  try {
    const source = createCatalogConnection(config);
    const images = await source.listImages();
    if (currentLoad !== loadId) return;
    state.source = source;
    state.albums = albumEntries(images);
  } catch (error) {
    if (currentLoad === loadId) state.error = error.message;
  } finally {
    if (currentLoad === loadId) {
      state.pending = false;
        renderCollection();
      updateConnection();
    }
  }
}

function showToast(message) {
  const toast = byId('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3800);
}

function submit(form, callback) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submitButton = form.querySelector('[type="submit"]');
    if (submitButton.disabled) return;
    const message = form.querySelector('.form-message');
    message.textContent = '';
    submitButton.disabled = true;
    try {
      await callback(Object.fromEntries(new FormData(form)));
    } catch (error) {
      message.textContent = error.message;
    } finally {
      submitButton.disabled = false;
    }
  });
}

submit(settingsForm, async fields => {
  const source = createCatalogConnection(fields);
  const images = await source.listImages();
  const config = saveCatalogConfig(fields);
  ++loadId;
  if (state.config?.url !== config.url) uploadToken = '';
  state.config = config;
  state.source = source;
  state.albums = albumEntries(images);
  state.pending = false;
  state.error = '';
  renderCollection();
  updateConnection();
  const waiting = deferredSlotUpload?.waiting === 'connection' ? deferredSlotUpload : null;
  if (waiting) waiting.waiting = null;
  settings.close();
  if (waiting) await continueSlotUpload(waiting);
  else showToast('Supabase conectado.');
});

submit(slotTokenForm, async ({ token }) => {
  const job = deferredSlotUpload;
  if (job?.waiting !== 'token') return;
  if (!token.trim()) throw new Error('Informe o token de envio.');
  try {
    await storeSlotUpload(job, token);
    slotTokenDialog.close();
  } catch (error) {
    if (error.code !== 'slot_occupied') throw error;
    await refreshTakenSlot(job.slot);
    finishSlotUpload(job);
    slotTokenDialog.close();
    reportSlot(error.message);
  }
});

for (const dialog of document.querySelectorAll('dialog')) {
  const close = () => {
    if (!dialog.querySelector('[type="submit"]:disabled')) dialog.close();
  };
  dialog.querySelector('[data-close]').addEventListener('click', close);
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
  });
  dialog.addEventListener('cancel', event => {
    if (dialog.querySelector('[type="submit"]:disabled')) event.preventDefault();
  });
}
for (const [dialog, waiting] of [[settings, 'connection'], [slotTokenDialog, 'token']]) {
  dialog.addEventListener('close', () => {
    if (!dialog.open && deferredSlotUpload?.waiting === waiting) finishSlotUpload(deferredSlotUpload);
  });
}
slotFile.addEventListener('change', () => {
  const slot = pickerSlot;
  const file = slotFile.files?.[0];
  pickerSlot = 0;
  slotFile.value = '';
  if (slot && file) void prepareSlotUpload(slot, file);
});
byId('disconnect').addEventListener('click', () => {
  if (settingsForm.querySelector('[type="submit"]').disabled) return;
  uploadToken = '';
  clearCatalogConfig();
  settings.close();
  useSavedConnection();
  showToast('Conexão removida deste navegador.');
});
byId('settings-button').addEventListener('click', openSettings);
byId('empty-action').addEventListener('click', openSettings);
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

useSavedConnection();
