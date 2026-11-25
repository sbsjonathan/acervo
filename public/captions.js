import { AUTHOR_OPTIONS, IMAGE_CATEGORIES } from './supabase.js';

export function isCustomAuthor(author) {
  return Boolean(author) && (author === 'Outro' || !AUTHOR_OPTIONS.includes(author));
}

export function createCaptionControls({
  authorSelect, categorySelect, authorCaption, categoryCaption, onChange, onCustomAuthor,
}) {
  const customOption = document.createElement('option');
  customOption.value = 'custom';
  customOption.disabled = true;
  customOption.hidden = true;
  authorSelect.insertBefore(customOption, authorSelect.lastElementChild);
  let displayedAuthor = '';

  authorSelect.addEventListener('change', () => {
    if (authorSelect.value === 'other') {
      authorSelect.value = displayedAuthor;
      onCustomAuthor();
    } else {
      onChange('author', authorSelect.value);
    }
  });
  categorySelect.addEventListener('change', () => onChange('category', categorySelect.value));

  function render({ author, category }, { authorDisabled = false, categoryDisabled = false } = {}) {
    const custom = isCustomAuthor(author);
    const group = IMAGE_CATEGORIES.includes(category) ? category : '';
    authorCaption.textContent = author || 'Autor';
    categoryCaption.textContent = group || 'Categoria';
    customOption.hidden = !custom;
    customOption.textContent = custom ? author : '';
    displayedAuthor = custom ? 'custom' : author || '';
    authorSelect.value = displayedAuthor;
    categorySelect.value = group;
    authorSelect.disabled = authorDisabled;
    categorySelect.disabled = categoryDisabled;
  }

  return { render };
}
