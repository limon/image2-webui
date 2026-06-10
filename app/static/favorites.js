(function() {
  const LS_THEME = 'img_ui_theme';
  const LS_FAVORITES = 'img_ui_favorites';
  const LS_REUSE_SNAPSHOT = 'img_ui_reuse_snapshot';
  const LS_FAVORITES_LAYOUT = 'img_ui_favorites_layout';
  const $ = (id) => document.getElementById(id);

  let favorites = [];
  let currentView = 'active';
  let currentCounts = { active: 0, archived: 0 };
  let currentDetailItem = null;
  let currentLayout = 'masonry';

  function applyTheme(theme) {
    if (theme === 'auto') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }

  async function api(path, init) {
    const resp = await fetch(path, init);
    const text = await resp.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (e) {}
    if (!resp.ok) {
      const msg = payload?.detail || payload?.error || text || `HTTP ${resp.status}`;
      const error = new Error(msg);
      error.status = resp.status;
      throw error;
    }
    return payload;
  }

  function readViewFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('view') === 'archived' ? 'archived' : 'active';
  }

  function applyViewState() {
    currentView = readViewFromUrl();
    $('activeLink').classList.toggle('active', currentView === 'active');
    $('archivedLink').classList.toggle('active', currentView === 'archived');
  }

  function readLayout() {
    const value = localStorage.getItem(LS_FAVORITES_LAYOUT);
    return value === 'grid' ? 'grid' : 'masonry';
  }

  function applyLayout(layout) {
    currentLayout = layout === 'masonry' ? 'masonry' : 'grid';
    $('favoritesGrid').classList.toggle('masonry', currentLayout === 'masonry');
    $('gridLayoutBtn').classList.toggle('active', currentLayout === 'grid');
    $('masonryLayoutBtn').classList.toggle('active', currentLayout === 'masonry');
  }

  function setLayout(layout) {
    localStorage.setItem(LS_FAVORITES_LAYOUT, layout === 'masonry' ? 'masonry' : 'grid');
    applyLayout(layout);
  }

  function renderCounts() {
    const legacyCount = readLegacyFavorites().length;
    $('activeCount').textContent = `(${(currentCounts.active || 0) + legacyCount})`;
    $('archivedCount').textContent = `(${currentCounts.archived || 0})`;
  }

  function readLegacyFavorites() {
    try {
      const payload = JSON.parse(localStorage.getItem(LS_FAVORITES) || '[]');
      return Array.isArray(payload) ? payload : [];
    } catch (e) {
      return [];
    }
  }

  function writeLegacyFavorites(items) {
    localStorage.setItem(LS_FAVORITES, JSON.stringify(items));
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
      reader.readAsDataURL(blob);
    });
  }

  async function migrateLegacyFavorites() {
    const legacy = readLegacyFavorites();
    if (!legacy.length) return;
    const unresolved = [];
    for (const item of legacy) {
      try {
        await api('/api/favorites/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item),
        });
        continue;
      } catch (e) {}
      try {
        const resp = await fetch(item.src, { cache: 'force-cache' });
        if (!resp.ok) {
          unresolved.push(item);
          continue;
        }
        const blob = await resp.blob();
        const imageDataUrl = await blobToDataUrl(blob);
        await api('/api/favorites/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...item, imageDataUrl }),
        });
      } catch (e) {
        unresolved.push(item);
      }
    }
    if (unresolved.length) {
      writeLegacyFavorites(unresolved);
    } else {
      localStorage.removeItem(LS_FAVORITES);
    }
  }

  function openLightbox(src, prompt) {
    $('lightboxImg').src = src;
    $('lightboxCaption').textContent = prompt || '';
    $('lightboxCaption').hidden = !prompt;
    $('lightbox').classList.add('active');
  }

  function closeLightbox() {
    $('lightbox').classList.remove('active');
    $('lightboxImg').src = '';
    $('lightboxCaption').textContent = '';
  }

  function closeSnapshotDetail() {
    currentDetailItem = null;
    $('snapshotOverlay').classList.remove('active');
    $('snapshotImage').src = '';
    $('snapshotPrompt').textContent = '';
    $('snapshotMeta').innerHTML = '';
    $('snapshotRefs').innerHTML = '';
    $('snapshotRefsWrap').hidden = true;
  }

  function downloadUrl(url, filename) {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function snapshotFilename(item) {
    const type = item?.type || 'favorite';
    const suffix = Number.isFinite(Number(item?.slot_index)) ? `-${Number(item.slot_index) + 1}` : '';
    return `${type}-favorite${suffix}.png`;
  }

  function buildReuseSnapshot(item) {
    return {
      type: item?.type || 'generate',
      prompt: item?.prompt || '',
      size: item?.size || '1024x1024',
      n: Number.isFinite(Number(item?.n)) ? Number(item.n) : 1,
      source_urls: Array.isArray(item?.source_urls) ? item.source_urls.filter(Boolean) : [],
      mask_url: item?.mask_url || null,
    };
  }

  function legacyFavoriteItems() {
    return readLegacyFavorites().map((item) => ({
      id: item.id,
      job_id: item.jobId || null,
      slot_index: Number.isFinite(Number(item.slotIndex)) ? Number(item.slotIndex) : 0,
      prompt: item.prompt || '',
      type: item.type || 'generate',
      label: item.label || '',
      size: '',
      n: 1,
      image_url: item.src,
      source_urls: [],
      mask_url: null,
      created_at: item.createdAt || Date.now(),
      updated_at: item.createdAt || Date.now(),
      job_available: false,
      legacy: true,
    }));
  }

  function snapshotReferenceAssets(item) {
    const assets = [];
    const sourceUrls = Array.isArray(item?.source_urls) ? item.source_urls.filter(Boolean) : [];
    if (item?.type === 'edit') {
      if (sourceUrls[0]) assets.push({ label: '原图', url: sourceUrls[0] });
      if (item?.mask_url) assets.push({ label: '蒙版', url: item.mask_url });
      return { label: '关联图片', items: assets };
    }
    if (item?.type === 'reference') {
      sourceUrls.forEach((url, index) => assets.push({ label: `参考图 ${index + 1}`, url }));
      return { label: '参考图', items: assets };
    }
    sourceUrls.forEach((url, index) => assets.push({ label: `关联图 ${index + 1}`, url }));
    return { label: '关联图片', items: assets };
  }

  function openSnapshotDetail(item) {
    if (!item) return;
    currentDetailItem = item;
    $('snapshotImage').src = item.image_url;
    $('snapshotImage').alt = item.label || '';
    $('snapshotImage').onclick = () => openLightbox(item.image_url, item.prompt || '');
    $('snapshotPrompt').textContent = item.prompt || '(无 prompt)';

    const meta = $('snapshotMeta');
    meta.innerHTML = '';
    [item.type || '', item.size || '', item.n > 1 ? `${item.n} 张` : '', item.label || ''].filter(Boolean).forEach((value) => {
      const node = document.createElement('span');
      node.textContent = value;
      meta.appendChild(node);
    });

    const refsWrap = $('snapshotRefsWrap');
    const refsLabel = $('snapshotRefsLabel');
    const refs = $('snapshotRefs');
    refs.innerHTML = '';
    const assets = snapshotReferenceAssets(item);
    if (!assets.items.length) {
      refsWrap.hidden = true;
    } else {
      refsLabel.textContent = assets.label;
      assets.items.forEach((asset) => {
        const card = document.createElement('div');
        card.className = 'snapshot-ref';
        const button = document.createElement('button');
        button.type = 'button';
        button.onclick = () => openLightbox(asset.url, item.prompt || '');
        const img = document.createElement('img');
        img.src = asset.url;
        img.alt = asset.label;
        button.appendChild(img);
        const caption = document.createElement('span');
        caption.textContent = asset.label;
        card.appendChild(button);
        card.appendChild(caption);
        refs.appendChild(card);
      });
      refsWrap.hidden = false;
    }

    $('snapshotDownloadBtn').disabled = !item.image_url;
    $('snapshotReuseBtn').disabled = item.legacy;
    $('snapshotOverlay').classList.add('active');
  }

  async function openFavoriteDetail(item) {
    if (!item) return;
    if (item.legacy) {
      alert('原任务已删除，且这条旧收藏还没有迁移成可独立保存的快照。');
      return;
    }
    try {
      const snapshot = await api(`/api/favorites/${encodeURIComponent(item.id)}`);
      openSnapshotDetail(snapshot);
    } catch (e) {}
  }

  async function removeFavorite(id) {
    const target = favorites.find((item) => item.id === id);
    if (target?.legacy) {
      writeLegacyFavorites(readLegacyFavorites().filter((item) => item.id !== id));
      favorites = favorites.filter((item) => item.id !== id);
      renderCounts();
      renderFavorites();
    } else {
      await api(`/api/favorites/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadFavorites();
    }
  }

  async function restoreFavorite(id) {
    await api(`/api/favorites/${encodeURIComponent(id)}/restore`, { method: 'POST' });
    await loadFavorites();
  }

  function renderFavorites() {
    const grid = $('favoritesGrid');
    grid.innerHTML = '';
    applyLayout(currentLayout);
    if (!favorites.length) {
      grid.innerHTML = '<div class="empty">还没有收藏的图片</div>';
      return;
    }
    favorites.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'card';

      const media = document.createElement('div');
      media.className = 'media';

      const img = document.createElement('img');
      img.className = 'thumb';
      img.src = item.image_url;
      img.alt = item.label || '';
      img.onclick = () => openFavoriteDetail(item);
      img.onerror = () => {
        img.remove();
        const missing = document.createElement('div');
        missing.className = 'missing-thumb';
        missing.textContent = '图片已丢失';
        media.prepend(missing);
      };
      media.appendChild(img);

      const fav = document.createElement('button');
      fav.className = 'fav';
      fav.type = 'button';
      fav.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
      fav.title = currentView === 'archived' ? '恢复收藏' : '取消收藏';
      fav.onclick = async () => {
        if (currentView === 'archived' && !item.legacy) {
          await restoreFavorite(item.id);
        } else {
          await removeFavorite(item.id);
        }
      };
      media.appendChild(fav);

      card.appendChild(media);
      grid.appendChild(card);
    });
  }

  async function loadFavorites() {
    const archived = currentView === 'archived' ? '1' : '0';
    const payload = await api(`/api/favorites?archived=${archived}`);
    currentCounts = payload?.counts || { active: 0, archived: 0 };
    favorites = [...(Array.isArray(payload?.items) ? payload.items : []), ...(currentView === 'active' ? legacyFavoriteItems() : [])];
    favorites.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    renderCounts();
    renderFavorites();
  }

  applyTheme(localStorage.getItem(LS_THEME) || 'auto');
  currentLayout = readLayout();
  applyLayout(currentLayout);
  applyViewState();

  (async () => {
    await migrateLegacyFavorites();
    await loadFavorites();
  })().catch(() => {
    $('favoritesGrid').innerHTML = '<div class="empty">收藏读取失败</div>';
  });

  window.addEventListener('popstate', () => {
    applyViewState();
    loadFavorites().catch(() => {});
  });

  $('lightbox').addEventListener('click', closeLightbox);
  $('snapshotCloseBtn').addEventListener('click', closeSnapshotDetail);
  $('snapshotDownloadBtn').addEventListener('click', () => {
    if (!currentDetailItem?.image_url) return;
    downloadUrl(currentDetailItem.image_url, snapshotFilename(currentDetailItem));
  });
  $('snapshotReuseBtn').addEventListener('click', () => {
    if (!currentDetailItem || currentDetailItem.legacy) return;
    localStorage.setItem(LS_REUSE_SNAPSHOT, JSON.stringify(buildReuseSnapshot(currentDetailItem)));
    window.location.href = '/';
  });
  $('snapshotOverlay').addEventListener('click', (e) => {
    if (e.target === $('snapshotOverlay')) closeSnapshotDetail();
  });
  $('gridLayoutBtn').addEventListener('click', () => setLayout('grid'));
  $('masonryLayoutBtn').addEventListener('click', () => setLayout('masonry'));
})();
