import { createCaptionControls } from './captions.js';
import { bindVerticalSwipes } from './flow-motion.js';

export function createVariations({
  getImages, uploadVariation, editImage, isSaving, editCustomAuthor, chooseReplacement, isReplacing, openPhoto, report,
}) {
  const byId = id => document.getElementById(id);
  const dialog = byId('variations-dialog');
  const toggle = byId('variations-toggle');
  const viewport = byId('variant-viewport');
  const preview = byId('variant-image');
  const zoom = byId('variant-zoom');
  const favorite = byId('variant-favorite');
  const context = byId('variations-context');
  const position = byId('variant-position');
  const strip = byId('variant-thumbnails');
  const add = byId('add-variations');
  const replace = byId('replace-variant');
  const replaceLabel = replace.querySelector('span') ?? replace;
  const picker = byId('variant-files');
  const status = byId('variant-status');

  const selections = new Map();
  const uploading = new Set();
  const notices = new Map();
  const thumbnails = new Map();
  let parent = null;
  let selected = null;
  let pickerParent = null;
  let transition = null;

  const captions = createCaptionControls({
    authorSelect: byId('variant-author-select'),
    categorySelect: byId('variant-category-select'),
    authorCaption: byId('variant-author-caption'),
    categoryCaption: byId('variant-category-caption'),
    onChange: (field, value) => save(parent, selected, field, value),
    onCustomAuthor: () => {
      const root = parent;
      const image = selected;
      if (image) editCustomAuthor(image, name => save(root, image, 'author', name));
    },
  });

  function renderNotice(root) {
    const notice = notices.get(root.id);
    const message = notice?.message ?? '';
    if (status.textContent !== message) status.textContent = message;
    status.dataset.state = notice?.error ? 'error' : '';
  }

  function notify(root, message, error = false) {
    notices.set(root.id, { message, error });
    if (dialog.open && parent?.id === root.id) renderNotice(root);
  }

  function notifyImage(image, message, error = false) {
    if (!dialog.open || parent?.id !== (image.parentId ?? image.id)) return false;
    notify(parent, message, error);
    return true;
  }

  async function save(root, image, field, value) {
    if (!root || !image || isSaving(image, field)) return;
    if (!uploading.has(root.id)) notify(root, '');
    try {
      await editImage(image, field, value);
    } catch (error) {
      notify(root, error.message, true);
      if (!dialog.open || parent?.id !== root.id) report(error.message);
    }
  }

  function createThumbnail(image) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'variant-thumb';
    button.dataset.imageId = image.id;
    const photo = document.createElement('img');
    photo.alt = '';
    photo.loading = 'lazy';
    photo.decoding = 'async';
    photo.draggable = false;
    const heart = document.createElement('span');
    heart.className = 'variant-thumb-heart';
    heart.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS(svg.namespaceURI, 'use');
    use.setAttribute('href', '#i-heart');
    svg.append(use);
    heart.append(svg);
    button.append(photo, heart);
    return button;
  }

  function renderThumbnails(images) {
    const ids = new Set(images.map(image => image.id));
    for (const [id, button] of thumbnails) {
      if (!ids.has(id)) {
        button.remove();
        thumbnails.delete(id);
      }
    }
    images.forEach((image, index) => {
      let button = thumbnails.get(image.id);
      if (!button) {
        button = createThumbnail(image);
        thumbnails.set(image.id, button);
      }
      if (strip.children[index] !== button) strip.insertBefore(button, strip.children[index] ?? null);
      const photo = button.firstElementChild;
      if (photo.getAttribute('src') !== image.src) photo.src = image.src;
      const name = index ? `Variação ${index}` : 'Capa original';
      button.setAttribute('aria-label', image.favorite ? `${name}, nos favoritos` : name);
      button.lastElementChild.hidden = !image.favorite;
      button.tabIndex = image.id === selected.id ? 0 : -1;
      if (image.id === selected.id) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    });
  }

  function refresh() {
    if (!dialog.open || !parent) return;
    const images = getImages(parent.id);
    if (!images.length) {
      dialog.close();
      return;
    }
    const id = selections.get(parent.id);
    const previousId = selected?.id;
    let index = images.findIndex(image => image.id === id);
    if (index < 0) index = images.length > 1 ? 1 : 0;
    selected = images[index];
    selections.set(parent.id, selected.id);
    const label = index ? `Variação ${index} de ${images.length - 1}` : 'Capa original';
    context.textContent = `Álbum ${String(parent.slot).padStart(2, '0')}`;
    if (position.textContent !== label) position.textContent = label;
    if (preview.getAttribute('src') !== selected.src) preview.src = selected.src;
    preview.alt = label;
    zoom.setAttribute('aria-label', `Ampliar imagem: ${label}`);
    favorite.setAttribute('aria-pressed', String(Boolean(selected.favorite)));
    favorite.setAttribute('aria-label', selected.favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos');
    favorite.disabled = isSaving(selected, 'favorite');
    captions.render(selected, {
      authorDisabled: isSaving(selected, 'author'),
      categoryDisabled: isSaving(selected, 'category'),
    });
    add.disabled = uploading.has(parent.id);
    const replacing = isReplacing(selected);
    replace.setAttribute('aria-disabled', String(replacing));
    const action = replacing ? 'Trocando…' : 'Trocar foto';
    if (replaceLabel.textContent !== action) replaceLabel.textContent = action;
    renderNotice(parent);
    renderThumbnails(images);
    if (selected.id !== previousId) {
      const bounds = strip.getBoundingClientRect();
      const active = thumbnails.get(selected.id).getBoundingClientRect();
      if (active.left < bounds.left) strip.scrollLeft += active.left - bounds.left;
      else if (active.right > bounds.right) strip.scrollLeft += active.right - bounds.right;
    }
  }

  function open(root) {
    if (!root) return;
    parent = root;
    selected = null;
    if (!uploading.has(root.id)) notices.delete(root.id);
    if (!dialog.open) dialog.showModal();
    toggle.setAttribute('aria-expanded', 'true');
    refresh();
  }

  function move(direction) {
    if (!dialog.open || !selected) return;
    const images = getImages(parent.id);
    const index = images.findIndex(image => image.id === selected.id);
    const next = index + direction;
    if (next < 0) {
      dialog.close();
      return;
    }
    if (next >= images.length) return;
    const focusThumbnail = strip.contains(document.activeElement);
    selections.set(parent.id, images[next].id);
    refresh();
    transition?.cancel();
    if (preview.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      transition = preview.animate([
        { transform: `translateY(${direction * 18}px)`, opacity: 0.85 },
        { transform: 'translateY(0)', opacity: 1 },
      ], { duration: 160, easing: 'ease-out' });
    }
    if (focusThumbnail) thumbnails.get(selected.id).focus({ preventScroll: true });
  }

  async function upload(root, files) {
    if (!files.length || uploading.has(root.id)) return;
    uploading.add(root.id);
    refresh();
    const failures = [];
    let uploaded = 0;
    const startingImage = selections.get(root.id);
    for (const [index, file] of files.entries()) {
      notify(root, `Enviando ${index + 1} de ${files.length}…`);
      try {
        const image = await uploadVariation(root, file);
        uploaded++;
        if (uploaded === 1 && selections.get(root.id) === startingImage) selections.set(root.id, image.id);
        refresh();
      } catch (error) {
        failures.push(`${file.name} (${error.message})`);
      }
    }
    uploading.delete(root.id);
    const summary = uploaded === 1 ? '1 variação salva.' : `${uploaded} variações salvas.`;
    const message = failures.length ? `${summary} Falha no envio de ${failures.join(', ')}` : summary;
    notify(root, message, failures.length > 0);
    refresh();
    if (!dialog.open || root.id !== parent?.id) report(`Álbum ${String(root.slot).padStart(2, '0')}: ${message}`);
  }

  const swipe = bindVerticalSwipes(viewport, direction => move(direction === 'up' ? 1 : -1));
  zoom.addEventListener('click', event => {
    if (event.detail !== 0 && swipe.shouldSuppressClick()) return;
    if (selected) openPhoto(selected);
  });
  favorite.addEventListener('click', () => {
    if (selected) void save(parent, selected, 'favorite', !selected.favorite);
  });
  replace.addEventListener('click', () => {
    if (selected && !isReplacing(selected)) chooseReplacement(selected);
  });
  strip.addEventListener('click', event => {
    const thumb = event.target.closest('.variant-thumb');
    if (!thumb || !parent) return;
    selections.set(parent.id, thumb.dataset.imageId);
    refresh();
  });
  add.addEventListener('click', () => {
    if (!parent || uploading.has(parent.id)) return;
    pickerParent = parent;
    picker.value = '';
    picker.click();
  });
  picker.addEventListener('change', () => {
    const root = pickerParent;
    const files = Array.from(picker.files ?? []);
    pickerParent = null;
    picker.value = '';
    if (root) void upload(root, files);
  });
  picker.addEventListener('cancel', () => { pickerParent = null; });
  byId('close-variations').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    toggle.setAttribute('aria-expanded', 'false');
    parent = null;
    selected = null;
  });
  dialog.addEventListener('keydown', event => {
    if (event.target.closest('select, input, textarea') || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      dialog.close();
      return;
    }
    const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    move(step);
  });

  return { open, refresh, notifyImage };
}
