// ===== STATE =====
let catalog = null;
let currentView = 'grid';
let currentFilterCategory = 'all';
let currentFilterTag = 'all';
let searchQuery = '';
let uploadedFileData = null; // Stores data from a successful upload for retry
let isSubmitting = false;

// ===== DOM REFS =====
const $ = (id) => document.getElementById(id);
const loginScreen = $('loginScreen');
const dashboard = $('dashboard');
const loginForm = $('loginForm');
const loginPassword = $('loginPassword');
const loginError = $('loginError');
const loginBtn = $('loginBtn');
const logoutBtn = $('logoutBtn');
const searchInput = $('searchInput');
const refreshBtn = $('refreshBtn');
const addBtn = $('addBtn');
const manageCategoriesBtn = $('manageCategoriesBtn');
const filterCategory = $('filterCategory');
const filterTag = $('filterTag');
const gridViewBtn = $('gridViewBtn');
const listViewBtn = $('listViewBtn');
const itemGrid = $('itemGrid');
const loadingIndicator = $('loadingIndicator');
const emptyState = $('emptyState');
const dropboxStatus = $('dropboxStatus');
const lastSync = $('lastSync');
const itemCount = $('itemCount');
const categoryCount = $('categoryCount');
const itemModal = $('itemModal');
const modalTitle = $('modalTitle');
const modalClose = $('modalClose');
const itemForm = $('itemForm');
const editItemId = $('editItemId');
const imageFile = $('imageFile');
const fileDropZone = $('fileDropZone');
const fileDropContent = $('fileDropContent');
const filePreview = $('filePreview');
const previewImage = $('previewImage');
const fileInfo = $('fileInfo');
const removeFileBtn = $('removeFileBtn');
const itemName = $('itemName');
const itemCategory = $('itemCategory');
const itemTags = $('itemTags');
const tagsDisplay = $('tagsDisplay');
const tagSuggestions = $('tagSuggestions');
const itemPrompt = $('itemPrompt');
const formError = $('formError');
const uploadProgress = $('uploadProgress');
const progressFill = $('progressFill');
const progressText = $('progressText');
const formSubmitBtn = $('formSubmitBtn');
const formCancelBtn = $('formCancelBtn');
const categoryModal = $('categoryModal');
const categoryModalClose = $('categoryModalClose');
const newCategoryName = $('newCategoryName');
const addCategoryBtn = $('addCategoryBtn');
const categoryList = $('categoryList');
const categoryError = $('categoryError');
const confirmDialog = $('confirmDialog');
const confirmTitle = $('confirmTitle');
const confirmMessage = $('confirmMessage');
const confirmOkBtn = $('confirmOkBtn');
const confirmCancelBtn = $('confirmCancelBtn');
const confirmClose = $('confirmClose');
const toast = $('toast');

// ===== AUTH =====
async function checkAuth() {
  try {
    const res = await fetch('/api/check-auth');
    console.log('[AUTH] check-auth response status:', res.status);
    const text = await res.text();
    console.log('[AUTH] check-auth response body:', text.substring(0, 500));
    if (res.ok) {
      showDashboard();
      return true;
    }
  } catch (err) {
    console.error('[AUTH] check-auth fetch error:', err);
  }
  showLogin();
  return false;
}

async function handleLogin(e) {
  e.preventDefault();
  const password = loginPassword.value.trim();
  if (!password) return;

  loginBtn.disabled = true;
  loginBtn.textContent = 'Signing in...';
  loginError.style.display = 'none';

  try {
      console.log('[LOGIN] Sending login request...');
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      console.log('[LOGIN] Response status:', res.status);
      const responseText = await res.text();
      console.log('[LOGIN] Response body:', responseText.substring(0, 500));

      if (res.ok) {
        showDashboard();
        loadCatalog();
      } else {
        loginError.textContent = 'Login failed (status ' + res.status + '). Check console.';
        loginError.style.display = 'block';
        loginBtn.disabled = false;
        loginBtn.textContent = 'Sign In';
      }
    } catch (err) {
      console.error('[LOGIN] Fetch error:', err);
      loginError.textContent = 'Connection error: ' + err.message;
      loginError.style.display = 'block';
      loginBtn.disabled = false;
      loginBtn.textContent = 'Sign In';
    }
}

async function handleLogout() {
  document.cookie = 'admin_session=; Max-Age=0; Path=/; Secure; SameSite=Strict';
  showLogin();
  catalog = null;
}

function showLogin() {
  loginScreen.style.display = 'flex';
  dashboard.style.display = 'none';
  loginPassword.value = '';
  loginBtn.disabled = false;
  loginBtn.textContent = 'Sign In';
}

function showDashboard() {
  loginScreen.style.display = 'none';
  dashboard.style.display = 'flex';
}

// ===== CATALOG OPERATIONS =====
async function loadCatalog() {
  loadingIndicator.style.display = 'flex';
  itemGrid.style.display = 'none';
  emptyState.style.display = 'none';
  dropboxStatus.textContent = '⏳ Loading...';

  try {
        console.log('[CATALOG] Fetching catalog...');
        const res = await fetch('/api/catalog');
        console.log('[CATALOG] Response status:', res.status);
        const responseText = await res.text();
        console.log('[CATALOG] Response body (first 500 chars):', responseText.substring(0, 500));

        if (!res.ok) {
          let errMsg = 'HTTP ' + res.status;
          try {
            const err = JSON.parse(responseText);
            errMsg = err.error || errMsg;
            if (err.details) errMsg += ' - ' + err.details;
          } catch {
            errMsg += ' - ' + responseText.substring(0, 200);
          }
          throw new Error(errMsg);
        }

        catalog = JSON.parse(responseText);

        // The catalog endpoint reports when catalog.json was not found so a
        // wrong DROPBOX_SUBFOLDER is visible instead of a silent empty list.
        const catalogStatus = res.headers.get('X-Catalog-Status');
        const catalogPath = res.headers.get('X-Catalog-Path');
        if (catalogStatus === 'not-found') {
          dropboxStatus.textContent = '⚠️ No catalog.json at ' + (catalogPath || 'configured path');
          showToast('catalog.json not found at ' + (catalogPath || 'the configured path') + '. Check DROPBOX_SUBFOLDER.', 'error');
        } else {
          dropboxStatus.textContent = '✅ Connected';
        }

        lastSync.textContent = '\uD83D\uDCC5 ' + new Date().toLocaleString();
        updateStats();
        populateFilters();
        renderItems();
  } catch (err) {
        console.error('[CATALOG] Error:', err);
        dropboxStatus.textContent = '❌ Disconnected';
        showToast('Failed to load catalog: ' + err.message, 'error');
        loadingIndicator.style.display = 'none';
        itemGrid.style.display = 'block';
        itemGrid.innerHTML = '<div class="empty-state"><p>Failed to load catalog.<br/>Error: ' + escapeHtml(err.message) + '</p></div>';
  }
}

function updateStats() {
  if (!catalog) return;
  itemCount.textContent = `📦 ${catalog.items.length} items`;
  categoryCount.textContent = `🏷️ ${catalog.categories.length} categories`;
}

function populateFilters() {
  if (!catalog) return;

  // Category filter
  const currentCat = filterCategory.value;
  filterCategory.innerHTML = '<option value="all">All Categories</option>';
  catalog.categories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    filterCategory.appendChild(opt);
  });
  filterCategory.value = currentCat;

  // Tag filter
  const currentTag = filterTag.value;
  filterTag.innerHTML = '<option value="all">All Tags</option>';
  const allTags = getAllTags();
  allTags.forEach(tag => {
    const opt = document.createElement('option');
    opt.value = tag;
    opt.textContent = tag;
    filterTag.appendChild(opt);
  });
  filterTag.value = currentTag;
}

function getAllTags() {
  if (!catalog) return [];
  const tagSet = new Set();
  catalog.items.forEach(item => {
    item.tags.forEach(tag => tagSet.add(tag));
  });
  return Array.from(tagSet).sort();
}

// ===== RENDER ITEMS =====
function renderItems() {
  if (!catalog) return;

  loadingIndicator.style.display = 'none';

  let items = catalog.items;

  // Filter by category
  if (currentFilterCategory !== 'all') {
    items = items.filter(item => item.category === currentFilterCategory);
  }

  // Filter by tag
  if (currentFilterTag !== 'all') {
    items = items.filter(item => item.tags.includes(currentFilterTag));
  }

  // Search
  if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase();
    items = items.filter(item =>
      item.name.toLowerCase().includes(q) ||
      item.prompt.toLowerCase().includes(q) ||
      item.category.toLowerCase().includes(q) ||
      item.tags.some(tag => tag.toLowerCase().includes(q))
    );
  }

  if (items.length === 0) {
    itemGrid.style.display = 'none';
    emptyState.style.display = 'block';
    emptyState.querySelector('h2').textContent = catalog.items.length === 0 ? 'No images yet' : 'No matching items';
    emptyState.querySelector('p').textContent = catalog.items.length === 0
      ? 'Click "Add New Image" to add your first catalog entry.'
      : 'Try adjusting your search or filters.';
    return;
  }

  emptyState.style.display = 'none';
  itemGrid.style.display = 'grid';
  itemGrid.className = `item-grid ${currentView}-view`;

  itemGrid.innerHTML = items.map(item => `
    <div class="item-card ${currentView === 'list' ? 'list-view' : ''}" data-id="${item.id}">
      <img class="card-image" src="${escapeHtml(item.image)}" data-proxy="${escapeHtml(getImageProxyUrl(item) || '')}" alt="${escapeHtml(item.name)}" loading="lazy"
        onerror="handleImageError(this)" />
      <div class="card-body">
        <div class="card-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
        <span class="card-category">${escapeHtml(item.category)}</span>
        <div class="card-tags">
          ${item.tags.map(t => `<span class="card-tag">${escapeHtml(t)}</span>`).join('')}
        </div>
        <div class="card-prompt">${escapeHtml(truncatePrompt(item.prompt, 120))}</div>
        <div class="card-actions">
          <button class="btn btn-small btn-secondary edit-btn" data-id="${item.id}">✏️ Edit</button>
          <button class="btn btn-small btn-danger delete-btn" data-id="${item.id}">🗑️ Delete</button>
          <span class="card-status">ID: ${item.id}</span>
        </div>
      </div>
    </div>
  `).join('');

  // Attach event listeners
  itemGrid.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => openEditModal(parseInt(btn.dataset.id)));
  });
  itemGrid.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => confirmDelete(parseInt(btn.dataset.id)));
  });
}

function truncatePrompt(prompt, maxLen) {
  if (!prompt) return '';
  // Remove extra whitespace/newlines for preview
  const cleaned = prompt.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.substring(0, maxLen) + '...';
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Derive the Dropbox filename for an item. New items store filePath;
// older items only have the public URL, so extract the last path segment.
function getImageFilename(item) {
  if (!item) return null;
  if (item.filePath) {
    const parts = String(item.filePath).split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
  }
  if (!item.image) return null;
  try {
    const url = new URL(item.image, window.location.origin);
    const segment = url.pathname.split('/').filter(Boolean).pop() || '';
    const name = decodeURIComponent(segment);
    return /\.(webp|jpe?g|png|avif|gif)$/i.test(name) ? name : null;
  } catch {
    return null;
  }
}

// Worker-proxied URL - works even when Dropbox hotlinking is blocked.
function getImageProxyUrl(item) {
  if (!item) return null;
  if (item.filePath) return '/api/images?path=' + encodeURIComponent(item.filePath);
  const filename = getImageFilename(item);
  return filename ? '/api/images?filename=' + encodeURIComponent(filename) : null;
}

// First retry through the proxy, then show a placeholder.
function handleImageError(img) {
  const proxy = img.dataset.proxy;
  if (proxy) {
    img.dataset.proxy = '';
    img.src = proxy;
    return;
  }
  img.onerror = null;
  img.src = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' +
    '<rect fill="#1a1a2e" width="400" height="300"/>' +
    '<text x="50%" y="50%" text-anchor="middle" fill="#94a3b8" font-size="14">No Image</text>' +
    '</svg>'
  );
}

// ===== SEARCH & FILTER =====
let searchTimeout = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    searchQuery = searchInput.value;
    renderItems();
  }, 300);
});

filterCategory.addEventListener('change', () => {
  currentFilterCategory = filterCategory.value;
  renderItems();
});

filterTag.addEventListener('change', () => {
  currentFilterTag = filterTag.value;
  renderItems();
});

// ===== VIEW TOGGLE =====
gridViewBtn.addEventListener('click', () => {
  currentView = 'grid';
  gridViewBtn.classList.add('active');
  listViewBtn.classList.remove('active');
  renderItems();
});

listViewBtn.addEventListener('click', () => {
  currentView = 'list';
  listViewBtn.classList.add('active');
  gridViewBtn.classList.remove('active');
  renderItems();
});

// ===== REFRESH =====
refreshBtn.addEventListener('click', loadCatalog);

// ===== ADD NEW IMAGE =====
addBtn.addEventListener('click', () => openAddModal());

function openAddModal() {
  modalTitle.textContent = 'Add New Image';
  formSubmitBtn.textContent = 'Upload and Save';
  editItemId.value = '';
  itemForm.reset();
  filePreview.style.display = 'none';
  fileDropContent.style.display = 'block';
  formError.style.display = 'none';
  uploadProgress.style.display = 'none';
  uploadedFileData = null;
  isSubmitting = false;
  formSubmitBtn.disabled = false;
  currentTags = [];
    tagsDisplay.innerHTML = '';
    populateCategorySelect();
    itemModal.style.display = 'flex';
  }

  function openEditModal(id) {
  const item = catalog.items.find(i => i.id === id);
  if (!item) return;

  modalTitle.textContent = 'Edit Image';
  formSubmitBtn.textContent = 'Save Changes';
  editItemId.value = id;
  itemName.value = item.name;
  itemPrompt.value = item.prompt;
  uploadedFileData = null;
  formError.style.display = 'none';
  uploadProgress.style.display = 'none';
  isSubmitting = false;
  formSubmitBtn.disabled = false;

  // Show existing image preview
  previewImage.src = item.image;
  fileInfo.textContent = `Current image (ID: ${item.id})`;
  filePreview.style.display = 'block';
  fileDropContent.style.display = 'none';

  populateCategorySelect();
  itemCategory.value = item.category;

    // Tags - reset and populate
    currentTags = [];
    tagsDisplay.innerHTML = '';
    item.tags.forEach(tag => addTagToDisplay(tag));

    itemModal.style.display = 'flex';
}

function populateCategorySelect() {
  if (!catalog) return;
  itemCategory.innerHTML = '<option value="">Select category...</option>';
  catalog.categories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    itemCategory.appendChild(opt);
  });
}

// ===== FILE HANDLING =====
imageFile.addEventListener('change', handleFileSelect);

fileDropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  fileDropZone.classList.add('drag-over');
});

fileDropZone.addEventListener('dragleave', () => {
  fileDropZone.classList.remove('drag-over');
});

fileDropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  fileDropZone.classList.remove('drag-over');
  if (e.dataTransfer.files.length > 0) {
    imageFile.files = e.dataTransfer.files;
    handleFileSelect();
  }
});

function handleFileSelect() {
  const file = imageFile.files[0];
  if (!file) return;

  // Validate type
  const allowedTypes = ['image/webp', 'image/jpeg', 'image/png', 'image/avif'];
  if (!allowedTypes.includes(file.type)) {
    showFormError('Invalid file type. Allowed: WebP, JPEG, PNG, AVIF');
    imageFile.value = '';
    return;
  }

  // Validate size (20MB)
  if (file.size > 20 * 1024 * 1024) {
    showFormError('File too large. Maximum size is 20MB');
    imageFile.value = '';
    return;
  }

  // Show preview
  const reader = new FileReader();
  reader.onload = (e) => {
    previewImage.src = e.target.result;
    const sizeStr = file.size > 1024 * 1024
      ? (file.size / (1024 * 1024)).toFixed(1) + ' MB'
      : (file.size / 1024).toFixed(0) + ' KB';
    fileInfo.textContent = `${file.name} (${sizeStr})`;
    filePreview.style.display = 'block';
    fileDropContent.style.display = 'none';
    formError.style.display = 'none';
  };
  reader.readAsDataURL(file);
}

removeFileBtn.addEventListener('click', () => {
  imageFile.value = '';
  filePreview.style.display = 'none';
  fileDropContent.style.display = 'block';
  uploadedFileData = null;
});

// ===== TAGS =====
let currentTags = [];

itemTags.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    addTagFromInput();
  }
});

itemTags.addEventListener('blur', () => {
  setTimeout(() => {
    tagSuggestions.classList.remove('show');
  }, 200);
});

itemTags.addEventListener('input', () => {
  const val = itemTags.value.trim().toLowerCase();
  if (!val) {
    tagSuggestions.classList.remove('show');
    return;
  }

  const allTags = getAllTags();
  const matches = allTags.filter(t =>
    t.toLowerCase().includes(val) &&
    !currentTags.includes(t)
  );

  if (matches.length > 0) {
    tagSuggestions.innerHTML = matches.map(t =>
      `<div class="tag-suggestion" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</div>`
    ).join('');
    tagSuggestions.classList.add('show');

    tagSuggestions.querySelectorAll('.tag-suggestion').forEach(el => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        addTagToDisplay(el.dataset.tag);
        itemTags.value = '';
        tagSuggestions.classList.remove('show');
      });
    });
  } else {
    tagSuggestions.classList.remove('show');
  }
});

function addTagFromInput() {
  const val = itemTags.value.trim();
  if (!val) return;
  addTagToDisplay(val);
  itemTags.value = '';
  tagSuggestions.classList.remove('show');
}

function addTagToDisplay(tag) {
  if (currentTags.includes(tag)) return;
  currentTags.push(tag);

  const el = document.createElement('span');
  el.className = 'tag-item';
  el.innerHTML = `${escapeHtml(tag)} <span class="tag-remove" data-tag="${escapeHtml(tag)}">&times;</span>`;
  tagsDisplay.appendChild(el);

  el.querySelector('.tag-remove').addEventListener('click', () => {
    currentTags = currentTags.filter(t => t !== tag);
    el.remove();
  });
}

// ===== FORM SUBMIT =====
itemForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (isSubmitting) return;

  const name = itemName.value.trim();
  const category = itemCategory.value;
  const prompt = itemPrompt.value.trim();
  const editId = editItemId.value ? parseInt(editItemId.value) : null;

  // Validate
  if (!name) { showFormError('Name is required.'); return; }
  if (!category) { showFormError('Category is required.'); return; }
  if (!prompt) { showFormError('Prompt is required.'); return; }

  isSubmitting = true;
  formSubmitBtn.disabled = true;
  formError.style.display = 'none';

  try {
    let imageUrl = null;

    // Upload image if a new file is selected
    if (imageFile.files.length > 0) {
      if (uploadedFileData) {
        // Reuse previously uploaded file data (retry scenario)
        imageUrl = uploadedFileData.imageUrl;
      } else {
        uploadProgress.style.display = 'block';
        progressFill.style.width = '30%';
        progressText.textContent = 'Uploading image...';

        const formData = new FormData();
        formData.append('image', imageFile.files[0]);

        // Cloudflare Pages maps functions/api/images.js to /api/images.
        // /api/images/upload does not exist and returns 404.
        const uploadRes = await fetch('/api/images', {
          method: 'POST',
          body: formData,
        });

        if (!uploadRes.ok) {
                  const errText = await uploadRes.text();
                  console.error('[UPLOAD] Error response:', uploadRes.status, errText);
                  let errMsg = 'Image upload failed (HTTP ' + uploadRes.status + ')';
                  try { const err = JSON.parse(errText); errMsg = err.error || err.details || errMsg; } catch {}
                  throw new Error(errMsg);
                }

        progressFill.style.width = '80%';
        progressText.textContent = 'Processing...';

                const uploadData = await uploadRes.json();
                console.log('[UPLOAD] Success:', uploadData);
                uploadedFileData = uploadData;
                imageUrl = uploadedFileData.imageUrl;
      }
    } else if (editId) {
      // Editing without replacing image - keep existing URL
      const existingItem = catalog.items.find(i => i.id === editId);
      if (existingItem) {
        imageUrl = existingItem.image;
      }
    } else {
      showFormError('Please select an image file.');
      isSubmitting = false;
      formSubmitBtn.disabled = false;
      return;
    }

    if (!imageUrl) {
      throw new Error('Could not obtain image URL');
    }

    progressFill.style.width = '90%';
    progressText.textContent = 'Saving catalog...';

    // Build catalog update
    let updatedCatalog = JSON.parse(JSON.stringify(catalog));

    if (editId) {
          // Update existing item - preserve any extra fields (e.g., prompt2)
      const idx = updatedCatalog.items.findIndex(i => i.id === editId);
      if (idx === -1) throw new Error('Item not found in catalog');

          const existing = updatedCatalog.items[idx];
          updatedCatalog.items[idx] = {
            ...existing,
            id: editId,
            name,
            category,
            tags: [...currentTags],
            image: imageUrl,
            prompt,
            ...(uploadedFileData && uploadedFileData.path ? { filePath: uploadedFileData.path } : {}),
          };
        } else {
      // Add new item
      const newId = generateNewId(updatedCatalog.items);
      updatedCatalog.items.push({
        id: newId,
        name,
        category,
        tags: [...currentTags],
        image: imageUrl,
        prompt,
        ...(uploadedFileData && uploadedFileData.path ? { filePath: uploadedFileData.path } : {}),
      });
    }

    // Save catalog
    const saveRes = await fetch('/api/catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedCatalog),
    });

    if (!saveRes.ok) {
      const err = await saveRes.json();
      throw new Error(err.error || 'Failed to save catalog');
    }

    progressFill.style.width = '100%';
    progressText.textContent = 'Done!';

    // Update local catalog
    catalog = updatedCatalog;
    updateStats();
    populateFilters();
    renderItems();

    closeModal(itemModal);
    showToast(editId ? 'Item updated successfully!' : 'Item added successfully!', 'success');
  } catch (err) {
    showFormError(err.message);
    showToast('Error: ' + err.message, 'error');
  } finally {
    isSubmitting = false;
    formSubmitBtn.disabled = false;
    uploadProgress.style.display = 'none';
  }
});

function generateNewId(items) {
  const maxId = items.reduce((max, item) => Math.max(max, item.id), 0);
  let newId = maxId + 1;
  // Ensure no collision
  while (items.some(i => i.id === newId)) {
    newId++;
  }
  return newId;
}

// ===== DELETE =====
function confirmDelete(id) {
  const item = catalog.items.find(i => i.id === id);
  if (!item) return;

  confirmTitle.textContent = 'Delete Image';
  confirmMessage.textContent = `Delete "${item.name}"? This removes the catalog entry and permanently deletes the image file from Dropbox.`;
  confirmOkBtn.textContent = 'Delete';
  confirmDialog.style.display = 'flex';

  confirmOkBtn.onclick = async () => {
    confirmDialog.style.display = 'none';
    await deleteItem(id);
  };
}

async function deleteItem(id) {
  const item = catalog.items.find(i => i.id === id);
  if (!item) return;

  try {
    // 1. Delete the image file from Dropbox
    let fileDeleted = false;
    let fileError = null;
    const filename = getImageFilename(item);

    if (item.filePath || filename) {
      try {
        const fileRes = await fetch('/api/images', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'delete',
            path: item.filePath || undefined,
            filename: filename || undefined,
          }),
        });
        const fileData = await fileRes.json().catch(() => ({}));
        if (fileRes.ok) {
          fileDeleted = true;
        } else {
          fileError = fileData.error || ('HTTP ' + fileRes.status);
          if (fileData.details) fileError += ' - ' + fileData.details;
        }
      } catch (err) {
        fileError = err.message;
      }
    }

    // 2. Remove the entry from catalog.json
    const updatedCatalog = JSON.parse(JSON.stringify(catalog));
    updatedCatalog.items = updatedCatalog.items.filter(i => i.id !== id);

    const res = await fetch('/api/catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedCatalog),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to save catalog');
    }

    catalog = updatedCatalog;
    updateStats();
    populateFilters();
    renderItems();

    if (fileError) {
      showToast('Removed from catalog, but the Dropbox file was NOT deleted: ' + fileError, 'error');
    } else if (fileDeleted) {
      showToast('Image deleted from Dropbox and catalog.', 'success');
    } else {
      showToast('Removed from catalog (no image file was linked).', 'success');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// ===== CATEGORY MANAGEMENT =====
manageCategoriesBtn.addEventListener('click', () => {
  renderCategoryList();
  categoryError.style.display = 'none';
  newCategoryName.value = '';
  categoryModal.style.display = 'flex';
});

function renderCategoryList() {
  if (!catalog) return;
  categoryList.innerHTML = '';

  catalog.categories.forEach(cat => {
    const count = catalog.items.filter(i => i.category === cat).length;
    const div = document.createElement('div');
    div.className = 'category-item';
    div.innerHTML = `
      <div>
        <span class="cat-name">${escapeHtml(cat)}</span>
        <span class="cat-count">(${count} items)</span>
      </div>
      <div class="cat-actions">
        <button class="btn btn-small btn-secondary rename-cat-btn" data-cat="${escapeHtml(cat)}">✏️ Rename</button>
        <button class="btn btn-small btn-danger delete-cat-btn" data-cat="${escapeHtml(cat)}" ${count > 0 ? 'disabled title="Reassign items first"' : ''}>🗑️</button>
      </div>
    `;
    categoryList.appendChild(div);

    div.querySelector('.rename-cat-btn').addEventListener('click', () => {
      promptRenameCategory(cat);
    });

    div.querySelector('.delete-cat-btn').addEventListener('click', () => {
      if (count === 0) confirmDeleteCategory(cat);
    });
  });
}

addCategoryBtn.addEventListener('click', () => {
  const name = newCategoryName.value.trim();
  if (!name) return;

  if (catalog.categories.some(c => c.toLowerCase() === name.toLowerCase())) {
    categoryError.textContent = 'Category already exists.';
    categoryError.style.display = 'block';
    return;
  }

  catalog.categories.push(name);
  saveCategoryChange();
  newCategoryName.value = '';
});

function promptRenameCategory(oldName) {
  const newName = prompt(`Rename "${oldName}" to:`, oldName);
  if (!newName || newName.trim() === oldName) return;

  const trimmed = newName.trim();

  if (catalog.categories.some(c => c.toLowerCase() === trimmed.toLowerCase() && c !== oldName)) {
    showToast('Category name already exists.', 'error');
    return;
  }

  // Update category in categories array
  const idx = catalog.categories.indexOf(oldName);
  if (idx === -1) return;
  catalog.categories[idx] = trimmed;

  // Update all items with this category
  catalog.items.forEach(item => {
    if (item.category === oldName) {
      item.category = trimmed;
    }
  });

  saveCategoryChange();
}

function confirmDeleteCategory(cat) {
  confirmTitle.textContent = 'Delete Category';
  confirmMessage.textContent = `Delete category "${cat}"?`;
  confirmOkBtn.textContent = 'Delete';
  confirmDialog.style.display = 'flex';

  confirmOkBtn.onclick = async () => {
    confirmDialog.style.display = 'none';
    catalog.categories = catalog.categories.filter(c => c !== cat);
    await saveCategoryChange();
  };
}

async function saveCategoryChange() {
  try {
    const res = await fetch('/api/catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(catalog),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to save');
    }

    updateStats();
    populateFilters();
    renderItems();
    renderCategoryList();
    showToast('Categories updated!', 'success');
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// ===== MODAL HELPERS =====
function closeModal(modal) {
  modal.style.display = 'none';
}

modalClose.addEventListener('click', () => closeModal(itemModal));
formCancelBtn.addEventListener('click', () => closeModal(itemModal));
itemModal.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModal(itemModal);
});

categoryModalClose.addEventListener('click', () => closeModal(categoryModal));
categoryModal.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModal(categoryModal);
});

confirmClose.addEventListener('click', () => confirmDialog.style.display = 'none');
confirmCancelBtn.addEventListener('click', () => confirmDialog.style.display = 'none');
confirmDialog.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) confirmDialog.style.display = 'none';
});

// ===== TOAST =====
function showToast(message, type = 'success') {
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.style.display = 'block';

  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => {
    toast.style.display = 'none';
  }, 4000);
}

function showFormError(message) {
  formError.textContent = message;
  formError.style.display = 'block';
}

// ===== KEYBOARD SHORTCUTS =====
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (confirmDialog.style.display === 'flex') confirmDialog.style.display = 'none';
    else if (categoryModal.style.display === 'flex') closeModal(categoryModal);
    else if (itemModal.style.display === 'flex') closeModal(itemModal);
  }
});

// ===== INIT =====
loginForm.addEventListener('submit', handleLogin);
logoutBtn.addEventListener('click', handleLogout);

document.addEventListener('DOMContentLoaded', async () => {
  const authed = await checkAuth();
  if (authed) {
    loadCatalog();
  }
});