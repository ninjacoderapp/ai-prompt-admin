// ===== STATE =====
// `catalog` is the working draft: every add, edit, delete and category change
// is applied here only. `committedCatalog` is the last version saved to
// GitHub and is used to work out what is still pending. Nothing is written
// to GitHub until the user presses the sticky Commit button.
let catalog = null;
let committedCatalog = null;
let currentView = 'grid';
let currentFilterCategory = 'all';
let currentFilterTag = 'all';
let searchQuery = '';
let isSubmitting = false;
let isCommitting = false;
let pendingUploads = new Map(); // tempId -> { file, name }
let pendingDeletes = [];        // [{ id, name, path, filename }]
let pendingSeq = 0;

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
const storageStatus = $('storageStatus');
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
const itemTrending = $('itemTrending');
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
const commitBar = $('commitBar');
const commitSummary = $('commitSummary');
const commitDetail = $('commitDetail');
const commitBtn = $('commitBtn');
const discardBtn = $('discardBtn');
const commitDetailsBtn = $('commitDetailsBtn');
const pendingModal = $('pendingModal');
const pendingList = $('pendingList');
const pendingCommitBtn = $('pendingCommitBtn');
const pendingClose = $('pendingClose');
const pendingCloseBtn = $('pendingCloseBtn');

// Build a readable error message from an API response (error + details + hint).
async function apiErrorMessage(res, fallback) {
  let text = '';
  try { text = await res.text(); } catch { }
  let message = fallback + ' (HTTP ' + res.status + ')';
  try {
    const body = JSON.parse(text);
    if (body.error) message = body.error;
    if (body.details) message += ' — ' + body.details;
    if (body.hint) message += ' — ' + body.hint;
  } catch {
    if (text) message += ': ' + text.substring(0, 200);
  }
  console.error('[API] ' + fallback + ' failed:', res.status, text.substring(0, 1000));
  return message;
}

// Strip the client-only bookkeeping keys (they all start with "_") so the
// published catalog keeps exactly the documented item fields.
function stripInternal(item) {
  const copy = {};
  Object.keys(item || {}).forEach(key => {
    if (key.charAt(0) !== '_') copy[key] = item[key];
  });
  if (!Array.isArray(copy.tags)) copy.tags = [];
  return copy;
}

function cloneCatalog(value) {
  return value ? JSON.parse(JSON.stringify(value)) : null;
}

// Build the exact JSON that gets written to GitHub: only the two top-level
// keys allowed by the catalog schema, and tags always an array.
function catalogPayload(cat) {
  return {
    categories: (cat.categories || []).map(c => String(c).trim()).filter(Boolean),
    items: (cat.items || []).map(stripInternal),
  };
}

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
  committedCatalog = null;
  resetPendingState();
  refreshPendingUI();
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
  storageStatus.textContent = '⏳ Loading...';

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
        if (!Array.isArray(catalog.categories)) catalog.categories = [];
        if (!Array.isArray(catalog.items)) catalog.items = [];
        committedCatalog = cloneCatalog(catalog);
        resetPendingState();

        // The catalog endpoint reports when catalog.json was not found so a
        // wrong GITHUB_DATA_PATH is visible instead of a silent empty list.
        const catalogStatus = res.headers.get('X-Catalog-Status');
        const catalogPath = res.headers.get('X-Catalog-Path');
        if (catalogStatus === 'not-found') {
          storageStatus.textContent = '⚠️ No catalog.json at ' + (catalogPath || 'configured path');
          showToast('catalog.json not found at ' + (catalogPath || 'the configured path') + '. It will be created on the first save.', 'error');
        } else {
          storageStatus.textContent = '✅ GitHub connected';
        }

        lastSync.textContent = '\uD83D\uDCC5 ' + new Date().toLocaleString();
        updateStats();
        populateFilters();
        renderItems();
        await migrateTrendingCategory();
        refreshPendingUI();
  } catch (err) {
        console.error('[CATALOG] Error:', err);
        storageStatus.textContent = '❌ Disconnected';
        showToast('Failed to load catalog: ' + err.message, 'error');
        loadingIndicator.style.display = 'none';
        itemGrid.style.display = 'block';
        itemGrid.innerHTML = '<div class="empty-state"><p>Failed to load catalog.<br/>Error: ' + escapeHtml(err.message) + '</p></div>';
  }
}

// "trending" used to be a category; it is now a tag so an item can be both
// trending and belong to boy/girl/festival/other. Convert old data once.
async function migrateTrendingCategory() {
  if (!catalog || !Array.isArray(catalog.items)) return;

  const categories = Array.isArray(catalog.categories) ? catalog.categories : [];
  const isTrending = (value) => String(value || '').trim().toLowerCase() === 'trending';
  const hasTrendingCategory = categories.some(isTrending);
  const trendingItems = catalog.items.filter(item => isTrending(item.category));

  if (!hasTrendingCategory && trendingItems.length === 0) return;

  const remaining = categories.filter(c => !isTrending(c));
  const fallback = remaining.find(c => String(c).toLowerCase() === 'other') || remaining[0] || 'other';

  const updated = {
    categories: remaining.length ? remaining : ['other'],
    items: catalog.items.map(item => {
      const tags = Array.isArray(item.tags) ? [...item.tags] : [];
      if (!isTrending(item.category)) return { ...item, tags };
      if (!tags.some(isTrending)) tags.push('trending');
      return { ...item, category: fallback, tags };
    }),
  };

  // Staged locally: the user publishes it with the Commit button.
  catalog = updated;
  updateStats();
  populateFilters();
  renderItems();
  refreshPendingUI();
  showToast(
    trendingItems.length
      ? `"trending" is now a tag — ${trendingItems.length} item(s) moved to "${fallback}" and tagged trending. Press Commit to publish.`
      : '"trending" removed from categories — it is now a tag. Press Commit to publish.',
    'success'
  );
}

function updateStats() {
  if (!catalog) return;
  itemCount.textContent = `📦 ${catalog.items.length} items`;
  categoryCount.textContent = `🏷️ ${catalog.categories.length} categories`;
}

function populateFilters() {
  if (!catalog) return;

  // Category filter
  const currentCat = catalog.categories.includes(currentFilterCategory) ? currentFilterCategory : 'all';
  currentFilterCategory = currentCat;
  filterCategory.innerHTML = '<option value="all">All Categories</option>';
  catalog.categories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    filterCategory.appendChild(opt);
  });
  filterCategory.value = currentCat;

  // Tag filter
  const allTags = getAllTags();
  const currentTag = allTags.includes(currentFilterTag) ? currentFilterTag : 'all';
  currentFilterTag = currentTag;
  filterTag.innerHTML = '<option value="all">All Tags</option>';
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

  // Newest first: dateAdded when known, otherwise fall back to the numeric id.
  items = [...items].sort((a, b) => {
    const ta = Date.parse(a.dateAdded) || 0;
    const tb = Date.parse(b.dateAdded) || 0;
    if (ta !== tb) return tb - ta;
    return (Number(b.id) || 0) - (Number(a.id) || 0);
  });

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

  const baseById = new Map(((committedCatalog && committedCatalog.items) || []).map(i => [i.id, i]));

  itemGrid.innerHTML = items.map(item => `
    <div class="item-card ${currentView === 'list' ? 'list-view' : ''}" data-id="${item.id}">
      <img class="card-image" src="${escapeHtml(item.image)}" data-proxy="${escapeHtml(getImageProxyUrl(item) || '')}" alt="${escapeHtml(item.name)}" loading="lazy"
        onerror="handleImageError(this)" />
      <div class="card-body">
        <div class="card-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}${isTrendingItem(item) ? ' <span class="trending-badge" title="Trending">⭐</span>' : ''}${pendingBadge(item, baseById)}</div>
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

function isTrendingItem(item) {
  return Array.isArray(item && item.tags) &&
    item.tags.some(tag => String(tag).trim().toLowerCase() === 'trending');
}

// Marks cards that differ from the last committed catalog.
function pendingBadge(item, baseById) {
  if (!baseById) return '';
  const before = baseById.get(item.id);
  if (!before) return '<span class="card-pending">New</span>';
  if (JSON.stringify(stripInternal(before)) !== JSON.stringify(stripInternal(item))) {
    return '<span class="card-pending">Edited</span>';
  }
  return '';
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

// Derive the repository filename for an item. New items store filePath;
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

// Fallback for images the /images/<file> route cannot serve yet (freshly
// uploaded ones): the Function streams them straight from GitHub raw.
function getImageProxyUrl(item) {
  if (!item) return null;
  const filename = getImageFilename(item);
  return filename ? '/api/images?file=' + encodeURIComponent(filename) : null;
}

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
  const tBtn = $('trendingFilterBtn');
  if (tBtn) tBtn.classList.toggle('active', currentFilterTag === 'trending');
  renderItems();
});

// Quick shortcut for the tag-driven "trending" view.
const trendingFilterBtn = $('trendingFilterBtn');
if (trendingFilterBtn) {
  trendingFilterBtn.addEventListener('click', () => {
    const alreadyOn = currentFilterTag === 'trending';
    currentFilterTag = alreadyOn ? 'all' : 'trending';
    filterTag.value = currentFilterTag;
    trendingFilterBtn.classList.toggle('active', !alreadyOn);
    renderItems();
  });
}

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
refreshBtn.addEventListener('click', () => {
  if (hasPendingChanges()) {
    confirmTitle.textContent = 'Discard pending changes?';
    confirmMessage.textContent = 'Refreshing reloads the catalog from GitHub and throws away every uncommitted edit and queued upload.';
    confirmOkBtn.textContent = 'Discard & Refresh';
    confirmDialog.style.display = 'flex';
    confirmOkBtn.onclick = () => {
      confirmDialog.style.display = 'none';
      loadCatalog();
    };
    return;
  }
  loadCatalog();
});

// ===== MIGRATE IMAGE LINKS TO CLOUDFLARE PAGES =====
$('migrateLinksBtn').addEventListener('click', () => {
  if (hasPendingChanges()) {
    showToast('Commit or discard your pending changes first — link conversion rewrites the whole catalog on GitHub.', 'error');
    return;
  }
  confirmTitle.textContent = 'Use Cloudflare image links';
  confirmMessage.textContent = 'Rewrite every catalog image URL to its Cloudflare Pages URL? The images must already be committed to the repository images/ folder.';
  confirmOkBtn.textContent = 'Convert';
  confirmDialog.style.display = 'flex';

  confirmOkBtn.onclick = async () => {
    confirmDialog.style.display = 'none';
    try {
      const res = await fetch('/api/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'migrate-links' }),
      });
      if (!res.ok) throw new Error(await apiErrorMessage(res, 'Link conversion failed'));
      const data = await res.json();
      console.log('[MIGRATE] result:', data);

      const parts = [`${data.updated || 0} updated`, `${data.alreadyDirect || 0} already on Pages`];
      const failedCount = (data.failed || []).length;
      if (failedCount) parts.push(`${failedCount} failed`);
      showToast(parts.join(' · ') + (data.hint ? ' — ' + data.hint : ''), failedCount ? 'error' : 'success');

      if (data.updated) loadCatalog();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };
});

// ===== ADD NEW IMAGE =====
addBtn.addEventListener('click', () => openAddModal());

function openAddModal() {
  modalTitle.textContent = 'Add New Image';
  formSubmitBtn.textContent = 'Add to Pending Changes';
  editItemId.value = '';
  itemForm.reset();
  filePreview.style.display = 'none';
  fileDropContent.style.display = 'block';
  formError.style.display = 'none';
  uploadProgress.style.display = 'none';
  isSubmitting = false;
  formSubmitBtn.disabled = false;
  currentTags = [];
    tagsDisplay.innerHTML = '';
    itemTrending.checked = false;
    populateCategorySelect();
    itemModal.style.display = 'flex';
  }

function openEditModal(id) {
  const item = catalog.items.find(i => i.id === id);
  if (!item) return;

  // Reset the form first so a file picked earlier in the Add modal does not leak in.
  itemForm.reset();
  imageFile.value = '';

  modalTitle.textContent = 'Edit Image';
  formSubmitBtn.textContent = 'Update Pending Changes';
  editItemId.value = id;
  itemName.value = item.name;
  itemPrompt.value = item.prompt;
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

    itemTrending.checked = isTrendingItem(item);

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
  if (String(tag).trim().toLowerCase() === 'trending') itemTrending.checked = true;

  const el = document.createElement('span');
  el.className = 'tag-item';
  el.innerHTML = `${escapeHtml(tag)} <span class="tag-remove" data-tag="${escapeHtml(tag)}">&times;</span>`;
  tagsDisplay.appendChild(el);

  el.querySelector('.tag-remove').addEventListener('click', () => {
    currentTags = currentTags.filter(t => t !== tag);
    if (String(tag).trim().toLowerCase() === 'trending') itemTrending.checked = false;
    el.remove();
  });
}

// ===== FORM SUBMIT (staged, no network) =====
itemForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (isSubmitting) return;

  const name = itemName.value.trim();
  const category = itemCategory.value;
  const prompt = itemPrompt.value.trim();
  const editId = editItemId.value ? parseInt(editItemId.value) : null;

  if (!name) { showFormError('Name is required.'); return; }
  if (!category) { showFormError('Category is required.'); return; }
  if (!prompt) { showFormError('Prompt is required.'); return; }

  formError.style.display = 'none';

  const existing = editId ? catalog.items.find(i => i.id === editId) : null;
  const pickedFile = imageFile.files.length > 0 ? imageFile.files[0] : null;

  // A newly picked file is queued and uploaded only when the user commits.
  // Until then the card previews it from a local blob URL.
  let imageUrl = null;
  let pendingImageId = null;
  if (pickedFile) {
    if (existing && existing._pendingImageId) pendingUploads.delete(existing._pendingImageId);
    pendingImageId = 'img-' + (++pendingSeq);
    pendingUploads.set(pendingImageId, { file: pickedFile, name: pickedFile.name });
    imageUrl = URL.createObjectURL(pickedFile);
  } else if (existing) {
    imageUrl = existing.image;
  } else {
    showFormError('Please select an image file.');
    return;
  }

  if (!imageUrl) { showFormError('Please select an image file.'); return; }

  // The "trending" tag is driven by the checkbox so it can never be duplicated.
  const finalTags = currentTags.filter(t => String(t).trim().toLowerCase() !== 'trending');
  if (itemTrending.checked) finalTags.push('trending');

  if (editId) {
    const idx = catalog.items.findIndex(i => i.id === editId);
    if (idx === -1) { showFormError('Item not found in catalog'); return; }

    const prev = catalog.items[idx];
    const next = {
      ...prev,
      id: editId,
      name,
      category,
      tags: finalTags,
      image: imageUrl,
      prompt,
      dateAdded: prev.dateAdded || new Date().toISOString(),
    };

    if (pendingImageId) {
      delete next.filePath;
      next._pendingImageId = pendingImageId;
    } else {
      if (!prev.filePath) delete next.filePath;
      if (prev._pendingImageId) next._pendingImageId = prev._pendingImageId;
    }

    catalog.items[idx] = next;
  } else {
    catalog.items.push({
      id: generateNewId(catalog.items),
      name,
      category,
      tags: finalTags,
      image: imageUrl,
      prompt,
      dateAdded: new Date().toISOString(),
      ...(pendingImageId ? { _pendingImageId: pendingImageId } : {}),
    });
  }

  updateStats();
  populateFilters();
  renderItems();
  refreshPendingUI();
  closeModal(itemModal);
  showToast(
    editId
      ? 'Changes staged. Press ✓ Commit to publish them.'
      : 'Image staged. Press ✓ Commit to publish it.',
    'success'
  );
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

// ===== DELETE (staged) =====
function confirmDelete(id) {
  const item = catalog.items.find(i => i.id === id);
  if (!item) return;

  confirmTitle.textContent = 'Delete Image';
  confirmMessage.textContent = `Remove "${item.name}" from the draft? The entry disappears now and the image file is deleted from GitHub when you press Commit.`;
  confirmOkBtn.textContent = 'Remove';
  confirmDialog.style.display = 'flex';

  confirmOkBtn.onclick = () => {
    confirmDialog.style.display = 'none';
    deleteItem(id);
  };
}

function deleteItem(id) {
  const idx = catalog.items.findIndex(i => i.id === id);
  if (idx === -1) return;

  const item = catalog.items[idx];

  if (item._pendingImageId) {
    // Never uploaded, so there is nothing to delete on GitHub.
    pendingUploads.delete(item._pendingImageId);
  } else {
    const filename = getImageFilename(item);
    if (item.filePath || filename) {
      pendingDeletes.push({
        id: item.id,
        name: item.name,
        path: item.filePath || null,
        filename: filename || null,
      });
    }
  }

  catalog.items.splice(idx, 1);

  updateStats();
  populateFilters();
  renderItems();
  renderCategoryList();
  refreshPendingUI();
  showToast('Removed from the draft. Press ✓ Commit to publish.', 'success');
}

// ===== CATEGORY MANAGEMENT (staged) =====
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

  if (name.toLowerCase() === 'trending') {
    categoryError.textContent = '"trending" is a tag, not a category. Use the ⭐ Trending checkbox when editing an item.';
    categoryError.style.display = 'block';
    return;
  }

  if (catalog.categories.some(c => c.toLowerCase() === name.toLowerCase())) {
    categoryError.textContent = 'Category already exists.';
    categoryError.style.display = 'block';
    return;
  }

  catalog.categories.push(name);
  afterCategoryChange();
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

  afterCategoryChange();
}

function confirmDeleteCategory(cat) {
  confirmTitle.textContent = 'Delete Category';
  confirmMessage.textContent = `Delete category "${cat}"?`;
  confirmOkBtn.textContent = 'Delete';
  confirmDialog.style.display = 'flex';

  confirmOkBtn.onclick = async () => {
    confirmDialog.style.display = 'none';
    catalog.categories = catalog.categories.filter(c => c !== cat);
    afterCategoryChange();
  };
}

// Category edits stay in the draft; the Commit button publishes them.
function afterCategoryChange() {
  updateStats();
  populateFilters();
  renderItems();
  renderCategoryList();
  refreshPendingUI();
  showToast('Categories staged. Press ✓ Commit to publish.', 'success');
}

// ===== PENDING CHANGES / COMMIT =====
function resetPendingState() {
  pendingUploads = new Map();
  pendingDeletes = [];
}

// Diff the working draft against the last committed catalog.
function computeChanges() {
  const result = { added: [], edited: [], deleted: [], categories: false, uploads: [] };
  if (!catalog) return result;

  const base = committedCatalog || { categories: [], items: [] };
  const baseById = new Map((base.items || []).map(i => [i.id, i]));
  const draftById = new Map((catalog.items || []).map(i => [i.id, i]));

  (catalog.items || []).forEach(item => {
    const before = baseById.get(item.id);
    if (!before) {
      result.added.push(item);
    } else if (JSON.stringify(stripInternal(before)) !== JSON.stringify(stripInternal(item))) {
      result.edited.push(item);
    }
  });

  (base.items || []).forEach(item => {
    if (!draftById.has(item.id)) result.deleted.push(item);
  });

  result.categories = JSON.stringify(base.categories || []) !== JSON.stringify(catalog.categories || []);
  result.uploads = Array.from(pendingUploads.entries()).map(([id, entry]) => ({ id, name: entry.name }));
  return result;
}

function hasPendingChanges() {
  if (!catalog) return false;
  const c = computeChanges();
  return c.added.length > 0 || c.edited.length > 0 || c.deleted.length > 0 ||
    c.categories || pendingUploads.size > 0 || pendingDeletes.length > 0;
}

function refreshPendingUI() {
  if (!commitBar) return;

  const changes = computeChanges();
  const total = changes.added.length + changes.edited.length + changes.deleted.length + (changes.categories ? 1 : 0);
  const uploads = changes.uploads.length;
  const visible = total > 0 || uploads > 0 || pendingDeletes.length > 0;

  commitBar.style.display = visible ? 'flex' : 'none';
  document.body.classList.toggle('has-pending', visible);

  if (!visible) {
    commitSummary.textContent = 'No pending changes';
    commitDetail.textContent = '';
    if (pendingModal.style.display === 'flex') renderPendingList(changes);
    return;
  }

  const parts = [];
  if (changes.added.length) parts.push(changes.added.length + ' new');
  if (changes.edited.length) parts.push(changes.edited.length + ' edited');
  if (changes.deleted.length) parts.push(changes.deleted.length + ' deleted');
  if (changes.categories) parts.push('categories changed');
  if (uploads) parts.push(uploads + ' image' + (uploads === 1 ? '' : 's') + ' to upload');

  commitSummary.textContent = total + ' pending change' + (total === 1 ? '' : 's');
  if (total === 0 && pendingDeletes.length) {
    commitSummary.textContent = pendingDeletes.length + ' image file' + (pendingDeletes.length === 1 ? '' : 's') + ' to delete';
  }
  commitDetail.textContent = parts.join(' · ');

  if (pendingModal.style.display === 'flex') renderPendingList(changes);
}

function renderPendingList(changes) {
  const rows = [];
  changes.added.forEach(i => rows.push({ kind: 'add', label: 'New: ' + i.name }));
  changes.edited.forEach(i => rows.push({ kind: 'edit', label: 'Edited: ' + i.name }));
  changes.deleted.forEach(i => rows.push({ kind: 'delete', label: 'Deleted: ' + i.name }));
  if (changes.categories) {
    rows.push({ kind: 'category', label: 'Categories: ' + ((catalog.categories || []).join(', ') || 'none') });
  }
  changes.uploads.forEach(u => rows.push({ kind: 'image', label: 'Upload: ' + u.name }));

  if (!rows.length) {
    pendingList.innerHTML = '<div class="pending-empty">No pending changes.</div>';
    return;
  }

  pendingList.innerHTML = rows.map(r => `
    <div class="pending-row">
      <span class="pending-kind ${r.kind}">${r.kind}</span>
      <span class="pending-label">${escapeHtml(r.label)}</span>
    </div>
  `).join('');
}

function setCommitStatus(text, detail) {
  commitSummary.textContent = text;
  commitDetail.textContent = detail || 'Keep this tab open until it finishes';
}

// Uploads every queued image, deletes removed files, then saves the catalog
// exactly once. Failures leave the remaining work staged so it can be retried.
async function commitChanges() {
  if (isCommitting) return;

  const changes = computeChanges();
  if (!hasPendingChanges()) {
    showToast('Nothing to commit.', 'success');
    return;
  }

  isCommitting = true;
  commitBtn.disabled = true;
  pendingCommitBtn.disabled = true;
  discardBtn.disabled = true;
  commitBar.classList.add('busy');

  const failures = [];

  try {
    const queue = Array.from(pendingUploads.entries());
    for (let i = 0; i < queue.length; i++) {
      const [tempId, entry] = queue[i];
      setCommitStatus('Uploading image ' + (i + 1) + ' of ' + queue.length + '...', entry.name);

      const formData = new FormData();
      formData.append('image', entry.file);
      const res = await fetch('/api/images', { method: 'POST', body: formData });
      if (!res.ok) throw new Error(await apiErrorMessage(res, 'Image upload failed'));

      const data = await res.json();
      catalog.items.forEach(item => {
        if (item._pendingImageId !== tempId) return;
        if (data.imageUrl) item.image = data.imageUrl;
        if (data.path) item.filePath = data.path;
        delete item._pendingImageId;
      });
      pendingUploads.delete(tempId);
    }

    for (const del of [...pendingDeletes]) {
      setCommitStatus('Deleting image file...', del.name);
      try {
        const res = await fetch('/api/images', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'delete',
            path: del.path || undefined,
            filename: del.filename || undefined,
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          failures.push(del.name + ': ' + (data.error || 'HTTP ' + res.status));
        }
      } catch (err) {
        failures.push(del.name + ': ' + err.message);
      }
      pendingDeletes = pendingDeletes.filter(d => d !== del);
    }

    // Never publish a local blob: preview URL.
    const stranded = catalog.items.filter(i => i._pendingImageId);
    if (stranded.length) {
      throw new Error(stranded.length + ' staged image(s) are not queued for upload. Re-open those items and pick the image again.');
    }

    setCommitStatus('Saving catalog...', 'One commit with all your changes');
    const saveRes = await fetch('/api/catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(catalogPayload(catalog)),
    });
    if (!saveRes.ok) throw new Error(await apiErrorMessage(saveRes, 'Failed to save catalog'));

    committedCatalog = cloneCatalog(catalog);
    storageStatus.textContent = '✅ GitHub connected';
    lastSync.textContent = '\uD83D\uDCC5 ' + new Date().toLocaleString();

    updateStats();
    populateFilters();
    renderItems();

    const saved = changes.added.length + changes.edited.length + changes.deleted.length + (changes.categories ? 1 : 0);
    showToast(
      'Committed ' + saved + ' change' + (saved === 1 ? '' : 's') + ' to GitHub.' +
      (failures.length ? ' ' + failures.length + ' image file(s) could not be deleted.' : ''),
      failures.length ? 'warning' : 'success'
    );
  } catch (err) {
    showToast('Commit failed: ' + err.message + ' — your changes are still pending.', 'error');
  } finally {
    isCommitting = false;
    commitBtn.disabled = false;
    pendingCommitBtn.disabled = false;
    discardBtn.disabled = false;
    commitBar.classList.remove('busy');
    refreshPendingUI();
  }
}

function discardChanges() {
  confirmTitle.textContent = 'Discard pending changes';
  confirmMessage.textContent = 'Every uncommitted edit and queued upload will be thrown away and the catalog will be reloaded from GitHub.';
  confirmOkBtn.textContent = 'Discard';
  confirmDialog.style.display = 'flex';

  confirmOkBtn.onclick = () => {
    confirmDialog.style.display = 'none';
    resetPendingState();
    loadCatalog();
  };
}

commitBtn.addEventListener('click', commitChanges);
pendingCommitBtn.addEventListener('click', () => {
  pendingModal.style.display = 'none';
  commitChanges();
});
discardBtn.addEventListener('click', discardChanges);
commitDetailsBtn.addEventListener('click', () => {
  renderPendingList(computeChanges());
  pendingModal.style.display = 'flex';
});
pendingClose.addEventListener('click', () => pendingModal.style.display = 'none');
pendingCloseBtn.addEventListener('click', () => pendingModal.style.display = 'none');
pendingModal.addEventListener('click', (e) => {
  if (e.target === pendingModal) pendingModal.style.display = 'none';
});

window.addEventListener('beforeunload', (e) => {
  if (!hasPendingChanges()) return;
  e.preventDefault();
  e.returnValue = '';
});

// ===== DIAGNOSTICS =====
const diagModal = $('diagModal');
const diagOutput = $('diagOutput');
const diagSummary = $('diagSummary');

$('diagBtn').addEventListener('click', async () => {
  diagSummary.textContent = 'Running checks...';
  diagOutput.textContent = '';
  diagModal.style.display = 'flex';
  try {
    const res = await fetch('/api/catalog?diagnostics=1', { cache: 'no-store' });
    const text = await res.text();
    let report;
    try { report = JSON.parse(text); } catch { report = { raw: text.substring(0, 2000) }; }
    diagOutput.textContent = JSON.stringify(report, null, 2);

    const problems = [];
    if (!report.secretPresent) problems.push('GITHUB_SECRET is not set');
    if (report.token && report.token.ok === false) problems.push('Token error: ' + report.token.error);
    if (report.repoAccess && report.repoAccess.ok === false) {
      problems.push('Cannot access ' + report.owner + '/' + report.repo + ': ' + (report.repoAccess.error || 'unknown'));
    }
    if (report.read && report.read.ok === false) problems.push('Cannot read catalog: ' + (report.read.error || 'unknown'));
    if (report.write && report.write.ok === false) {
      problems.push('Cannot WRITE to GitHub: ' + (report.write.error || 'no push permission') + (report.write.hint ? ' — ' + report.write.hint : ''));
    }
    if (report.catalog && report.catalog.ok === false) problems.push('Catalog problem: ' + (report.catalog.error || 'unknown'));
    if (!res.ok) problems.unshift('Diagnostics endpoint returned HTTP ' + res.status);

    diagSummary.textContent = problems.length
      ? '⚠️ ' + problems.join(' • ')
      : '✅ Everything looks good: token, repo access, read and write checks passed.';
  } catch (err) {
    diagSummary.textContent = '❌ ' + err.message;
  }
});

$('diagClose').addEventListener('click', () => diagModal.style.display = 'none');
$('diagCloseBtn').addEventListener('click', () => diagModal.style.display = 'none');
diagModal.addEventListener('click', (e) => {
  if (e.target === diagModal) diagModal.style.display = 'none';
});
$('diagCopyBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(diagOutput.textContent);
    showToast('Diagnostics copied to clipboard', 'success');
  } catch {
    showToast('Copy failed — select the text manually', 'error');
  }
});

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
  }, type === 'error' ? 10000 : 4000);
}

function showFormError(message) {
  formError.textContent = message;
  formError.style.display = 'block';
}

// ===== KEYBOARD SHORTCUTS =====
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (confirmDialog.style.display === 'flex') confirmDialog.style.display = 'none';
    else if (diagModal.style.display === 'flex') diagModal.style.display = 'none';
    else if (pendingModal.style.display === 'flex') pendingModal.style.display = 'none';
    else if (categoryModal.style.display === 'flex') closeModal(categoryModal);
    else if (itemModal.style.display === 'flex') closeModal(itemModal);
  }
});

// ===== INIT =====
loginForm.addEventListener('submit', handleLogin);
logoutBtn.addEventListener('click', handleLogout);

async function showVersion() {
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    const data = await res.json();
    const badge = $('appVersion');
    if (badge && data.version) badge.textContent = 'v' + data.version;
  } catch { }
}

document.addEventListener('DOMContentLoaded', async () => {
  showVersion();
  const authed = await checkAuth();
  if (authed) {
    loadCatalog();
  }
});
