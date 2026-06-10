(function() {
  const $ = (id) => document.getElementById(id);
  const LS_KEY = 'img_ui_api_key';
  const LS_BASE = 'img_ui_base_url';
  const LS_MODEL = 'img_ui_model';
  const LS_QUALITY = 'img_ui_quality';
  const LS_MODERATION = 'img_ui_moderation';
  const LS_ACTIVE_JOBS = 'img_ui_active_jobs';
  const LS_THEME = 'img_ui_theme';
  const LS_DEBUG_HIDDEN = 'img_ui_debug_hidden';
  const LS_DEBUG_CLEAR_TS = 'img_ui_debug_clear_ts';
  const LS_FAVORITES = 'img_ui_favorites';
  const LS_REUSE_SNAPSHOT = 'img_ui_reuse_snapshot';
  const DEFAULT_BASE_URL = 'https://img-cn.65535.space/v1';
  const DEFAULT_MODEL = 'gpt-5.4-mini';
  const DEFAULT_QUALITY = 'high';
  const DEFAULT_MODERATION = 'low';
  const DEFAULT_BATCH_MODE = 'fanout';
  const DEFAULT_IMAGE_COUNT = 1;

  const MULTIPLE_OF = 16;
  const MAX_LONGEST = 3840;
  const MIN_PIXELS = 700_000;
  const MAX_PIXELS = 8_850_000;
  const MAX_REF_IMAGES = 10;
  const MAX_IMAGE_COUNT = 4;
  const MAX_UPLOAD_DIMENSION = 1536;
  const FEATURED_GRID_SLOTS = 32;
  const MOBILE_FEATURED_PREVIEW_COUNT = 5;
  const TYPE_LABELS = { generate: '文生图', edit: '编辑', reference: '参考图' };
  const BATCH_MODE_LABELS = {
    fanout: '多图:扇出',
    direct: '多图:直传n',
  };
  const STATUS_LABELS = {
    queued: '排队中',
    running: '处理中',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };

  let refImages = [];
  let maskFileFromEditor = null;
  let searchT = null;
  let featuredJob = null;
  let featuredServerJobs = [];
  let lightboxState = { items: [], index: 0 };
  let favoriteItems = [];
  let favoriteKeys = new Set();
  let currentHistoryView = 'active';
  let featuredGridPage = 0;
  let featuredCounts = { active: 0, trash: 0 };
  let featuredTotalPages = 1;
  let featuredTotalItems = 0;
  let featuredRequestSeq = 0;
  let mobileFeaturedExpanded = false;
  let featuredSelectionMode = false;
  let featuredSelectedIds = new Set();
  let featuredSelectionAnchorId = '';
  let settingsProfiles = [];
  let activeProfileId = '';
  let settingsDirty = false;
  let suppressSettingsDirty = false;
  let settingsReady = null;
  const activeWatchers = new Map();
  const liveFeaturedJobs = new Map();
  const recentCompletionHints = new Map();
  const debugJobs = new Map();
  const TASK_UI = {
    generate: { statusId: 'genStatus', resultId: 'genResult', failureText: '生成失败', stopBtnId: 'genStopBtn' },
    edit: { statusId: 'editStatus', resultId: 'editResult', failureText: '编辑失败', stopBtnId: 'editStopBtn' },
    reference: { statusId: 'refStatus', resultId: 'refResult', failureText: '生成失败', stopBtnId: 'refStopBtn' },
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
      throw new Error(msg);
    }
    return payload;
  }

  function setStatus(el, msg, type) {
    el.className = 'status' + (type ? ' ' + type : '');
    el.textContent = '';
    if (type === 'loading') {
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      spinner.style.marginRight = '8px';
      el.appendChild(spinner);
    }
    el.appendChild(document.createTextNode(msg));
  }

  function readActiveJobs() {
    try {
      const payload = JSON.parse(localStorage.getItem(LS_ACTIVE_JOBS) || '{}');
      return payload && typeof payload === 'object' ? payload : {};
    } catch (e) {
      return {};
    }
  }

  function writeActiveJobs(value) {
    localStorage.setItem(LS_ACTIVE_JOBS, JSON.stringify(value));
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

  function setSettingsStatus(message, tone = 'ok') {
    const el = $('keyStatus');
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('dirty', tone === 'dirty');
    el.classList.toggle('error', tone === 'error');
  }

  function refreshSettingsStatus() {
    if (settingsDirty) {
      setSettingsStatus('当前 profile 有未保存修改', 'dirty');
      return;
    }
    if (getCurrentProfile()) {
      setSettingsStatus('当前 Profile 已加载', 'ok');
      return;
    }
    setSettingsStatus('', 'ok');
  }

  function getCurrentProfile() {
    return settingsProfiles.find((item) => item.id === activeProfileId) || null;
  }

  function normalizeProfileRecord(profile) {
    return {
      id: String(profile?.id || ''),
      name: String(profile?.name || '默认'),
      api_key: String(profile?.api_key || ''),
      base_url: String(profile?.base_url || DEFAULT_BASE_URL),
      model: String(profile?.model || DEFAULT_MODEL),
      quality: String(profile?.quality || DEFAULT_QUALITY),
      moderation: String(profile?.moderation || DEFAULT_MODERATION),
      batch_mode: normalizeBatchMode(profile?.batch_mode || DEFAULT_BATCH_MODE),
      is_active: Boolean(profile?.is_active),
    };
  }

  function renderSettingsProfileOptions() {
    const select = $('settingsProfileSelect');
    if (!select) return;
    select.innerHTML = '';
    settingsProfiles.forEach((profile) => {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = profile.name || '未命名 Profile';
      option.selected = profile.id === activeProfileId;
      select.appendChild(option);
    });
    $('deleteProfileBtn').disabled = settingsProfiles.length <= 1;
  }

  function applyProfileToForm(profile, options = {}) {
    if (!profile) return;
    suppressSettingsDirty = true;
    $('profileName').value = profile.name || '';
    $('apiKey').value = profile.api_key || '';
    $('baseUrl').value = profile.base_url || DEFAULT_BASE_URL;
    $('model').value = profile.model || DEFAULT_MODEL;
    $('quality').value = profile.quality || DEFAULT_QUALITY;
    $('moderation').value = profile.moderation || DEFAULT_MODERATION;
    setBatchMode(profile.batch_mode || DEFAULT_BATCH_MODE);
    const select = $('settingsProfileSelect');
    if (select) select.value = profile.id;
    suppressSettingsDirty = false;
    settingsDirty = false;
    if (options.message) setSettingsStatus(options.message, options.tone || 'ok');
    else refreshSettingsStatus();
  }

  function applySettingsPayload(payload, options = {}) {
    settingsProfiles = Array.isArray(payload?.items) ? payload.items.map(normalizeProfileRecord) : [];
    activeProfileId = String(payload?.active_profile_id || settingsProfiles[0]?.id || '');
    renderSettingsProfileOptions();
    const profile = getCurrentProfile() || settingsProfiles[0] || null;
    if (profile) {
      activeProfileId = profile.id;
      applyProfileToForm(profile, options);
    }
  }

  function getProfileFormPayload() {
    return {
      name: $('profileName')?.value?.trim() || '',
      api_key: $('apiKey')?.value?.trim() || '',
      base_url: (($('baseUrl')?.value) || DEFAULT_BASE_URL).trim(),
      model: (($('model')?.value) || DEFAULT_MODEL).trim(),
      quality: (($('quality')?.value) || DEFAULT_QUALITY).trim(),
      moderation: (($('moderation')?.value) || DEFAULT_MODERATION).trim(),
      batch_mode: normalizeBatchMode(($('batchMode')?.value) || DEFAULT_BATCH_MODE),
      activate: true,
    };
  }

  function getLegacyStoredProfile() {
    const profile = {
      api_key: (localStorage.getItem(LS_KEY) || '').trim(),
      base_url: (localStorage.getItem(LS_BASE) || DEFAULT_BASE_URL).trim(),
      model: (localStorage.getItem(LS_MODEL) || DEFAULT_MODEL).trim(),
      quality: (localStorage.getItem(LS_QUALITY) || DEFAULT_QUALITY).trim(),
      moderation: (localStorage.getItem(LS_MODERATION) || DEFAULT_MODERATION).trim(),
      batch_mode: DEFAULT_BATCH_MODE,
    };
    const hasLegacy = profile.api_key
      || localStorage.getItem(LS_BASE)
      || localStorage.getItem(LS_MODEL)
      || localStorage.getItem(LS_QUALITY)
      || localStorage.getItem(LS_MODERATION);
    return hasLegacy ? profile : null;
  }

  function clearLegacyStoredProfile() {
    localStorage.removeItem(LS_KEY);
    localStorage.removeItem(LS_BASE);
    localStorage.removeItem(LS_MODEL);
    localStorage.removeItem(LS_QUALITY);
    localStorage.removeItem(LS_MODERATION);
  }

  function profileLooksUnconfigured(profile) {
    if (!profile) return true;
    return !profile.api_key
      && (profile.base_url || DEFAULT_BASE_URL) === DEFAULT_BASE_URL
      && (profile.model || DEFAULT_MODEL) === DEFAULT_MODEL
      && (profile.quality || DEFAULT_QUALITY) === DEFAULT_QUALITY
      && (profile.moderation || DEFAULT_MODERATION) === DEFAULT_MODERATION
      && normalizeBatchMode(profile.batch_mode || DEFAULT_BATCH_MODE) === DEFAULT_BATCH_MODE;
  }

  async function maybeMigrateLegacyProfile() {
    const legacy = getLegacyStoredProfile();
    const current = getCurrentProfile();
    if (!legacy || !current || !profileLooksUnconfigured(current)) return;
    const payload = await api(`/api/settings/profiles/${current.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...legacy,
        name: current.name || '默认',
        activate: true,
      }),
    });
    clearLegacyStoredProfile();
    applySettingsPayload(payload, { message: '✓ 浏览器设置已迁移到数据库' });
  }

  async function loadSettingsProfiles(options = {}) {
    const payload = await api('/api/settings/profiles');
    applySettingsPayload(payload, options);
  }

  function markSettingsDirty() {
    if (suppressSettingsDirty) return;
    settingsDirty = true;
    setSettingsStatus('当前 profile 有未保存修改', 'dirty');
  }

  async function saveCurrentProfile(options = {}) {
    await settingsReady;
    if (!activeProfileId) throw new Error('当前没有可用 profile');
    const payload = await api(`/api/settings/profiles/${activeProfileId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(getProfileFormPayload()),
    });
    clearLegacyStoredProfile();
    applySettingsPayload(payload, {
      message: options.message || '✓ 已保存到数据库',
      tone: options.tone || 'ok',
    });
  }

  async function activateProfile(profileId) {
    await settingsReady;
    if (!profileId || profileId === activeProfileId) return;
    const payload = await api(`/api/settings/profiles/${profileId}/activate`, { method: 'POST' });
    applySettingsPayload(payload, { message: '✓ 已切换 profile' });
  }

  async function createProfile() {
    await settingsReady;
    const raw = prompt('新 profile 名称');
    if (raw === null) return;
    const name = raw.trim();
    const payload = await api('/api/settings/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        clone_from_id: activeProfileId || null,
      }),
    });
    applySettingsPayload(payload, { message: '✓ 已新建 profile' });
  }

  async function deleteCurrentProfile() {
    await settingsReady;
    const current = getCurrentProfile();
    if (!current) return;
    if (!confirm(`确定删除 profile「${current.name}」吗？`)) return;
    const payload = await api(`/api/settings/profiles/${current.id}`, { method: 'DELETE' });
    applySettingsPayload(payload, { message: '✓ 已删除 profile' });
  }

  async function ensureSettingsSaved() {
    await settingsReady;
    if (settingsDirty) await saveCurrentProfile({ message: '✓ 已自动保存到数据库' });
  }

  async function initSettingsProfiles() {
    await loadSettingsProfiles();
    await maybeMigrateLegacyProfile();
    const current = getCurrentProfile();
    if (current) applyProfileToForm(current);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
      reader.readAsDataURL(blob);
    });
  }

  function clampUploadSize(width, height, maxDimension = MAX_UPLOAD_DIMENSION) {
    const longest = Math.max(width || 0, height || 0);
    if (!longest || longest <= maxDimension) {
      return { width, height, scaled: false };
    }
    const scale = maxDimension / longest;
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      scaled: true,
    };
  }

  function fileExtForMime(mimeType) {
    if (mimeType === 'image/jpeg') return 'jpg';
    if (mimeType === 'image/webp') return 'webp';
    return 'png';
  }

  function renameFileExt(name, ext) {
    const base = String(name || 'image').replace(/\.[^.]+$/, '');
    return `${base}.${ext}`;
  }

  async function loadImageFromBlob(blob) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('读取图片失败'));
        el.src = url;
      });
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function canvasToBlob(canvas, mimeType, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('导出缩小图片失败'));
      }, mimeType, quality);
    });
  }

  async function resizeImageFile(file, options = {}) {
    const img = await loadImageFromBlob(file);
    const targetWidth = options.targetWidth || img.naturalWidth;
    const targetHeight = options.targetHeight || img.naturalHeight;
    const sameSize = targetWidth === img.naturalWidth && targetHeight === img.naturalHeight;
    if (sameSize && !options.forceReencode) {
      return { file, changed: false, width: targetWidth, height: targetHeight };
    }
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
    const mimeType = options.mimeType || ((file.type === 'image/jpeg' || file.type === 'image/webp') ? file.type : 'image/png');
    const blob = await canvasToBlob(canvas, mimeType, mimeType === 'image/jpeg' ? 0.92 : undefined);
    const output = new File([blob], renameFileExt(file.name, fileExtForMime(mimeType)), {
      type: mimeType,
      lastModified: Date.now(),
    });
    return { file: output, changed: true, width: targetWidth, height: targetHeight };
  }

  async function resizeImageFileToMax(file, maxDimension = MAX_UPLOAD_DIMENSION) {
    const img = await loadImageFromBlob(file);
    const target = clampUploadSize(img.naturalWidth, img.naturalHeight, maxDimension);
    if (!target.scaled) {
      return { file, changed: false, width: img.naturalWidth, height: img.naturalHeight };
    }
    return resizeImageFile(file, { targetWidth: target.width, targetHeight: target.height });
  }

  async function prepareEditUploadFiles(imageFile, maskFile, maxDimension = MAX_UPLOAD_DIMENSION) {
    const image = await loadImageFromBlob(imageFile);
    const target = clampUploadSize(image.naturalWidth, image.naturalHeight, maxDimension);
    const resizedImage = target.scaled
      ? await resizeImageFile(imageFile, { targetWidth: target.width, targetHeight: target.height })
      : { file: imageFile, changed: false };
    let resizedMask = null;
    if (maskFile) {
      resizedMask = target.scaled
        ? await resizeImageFile(maskFile, {
            targetWidth: target.width,
            targetHeight: target.height,
            mimeType: 'image/png',
          })
        : { file: maskFile, changed: false };
    }
    return {
      image: resizedImage.file,
      mask: resizedMask ? resizedMask.file : null,
      changed: Boolean(target.scaled || resizedMask?.changed),
    };
  }

  async function tryImportLegacyFavorite(item) {
    try {
      await api('/api/favorites/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item),
      });
      return true;
    } catch (e) {}
    try {
      const resp = await fetch(item.src, { cache: 'force-cache' });
      if (!resp.ok) return false;
      const blob = await resp.blob();
      const imageDataUrl = await blobToDataUrl(blob);
      await api('/api/favorites/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...item, imageDataUrl }),
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  function favoriteId(jobId, slotIndex) {
    return `${jobId}:${slotIndex}`;
  }

  function isFavorite(jobId, slotIndex) {
    return favoriteKeys.has(favoriteId(jobId, slotIndex));
  }

  function upsertFavoriteItem(item) {
    const index = favoriteItems.findIndex((entry) => entry.id === item.id);
    if (index >= 0) {
      favoriteItems.splice(index, 1, item);
    } else {
      favoriteItems.unshift(item);
    }
    favoriteKeys = new Set(
      favoriteItems.map((entry) => entry.job_slot_key || favoriteId(entry.job_id, entry.slot_index))
    );
  }

  function removeFavoriteItemStateByKey(jobId, slotIndex) {
    const key = favoriteId(jobId, slotIndex);
    favoriteItems = favoriteItems.filter(
      (entry) => (entry.job_slot_key || favoriteId(entry.job_id, entry.slot_index)) !== key
    );
    favoriteKeys.delete(key);
  }

  function refreshFavoriteButtons() {
    document.querySelectorAll('.result-card-fav[data-favorite-key]').forEach((button) => {
      const active = favoriteKeys.has(button.dataset.favoriteKey);
      button.classList.toggle('active', active);
      button.title = active ? '取消收藏' : '收藏';
    });
    updateLightboxFavoriteButton();
  }

  async function loadFavoritesFromServer() {
    const payload = await api('/api/favorites');
    favoriteItems = Array.isArray(payload?.items) ? payload.items : [];
    const keys = favoriteItems.map((entry) => entry.job_slot_key || favoriteId(entry.job_id, entry.slot_index));
    readLegacyFavorites().forEach((entry) => {
      if (entry?.jobId != null && entry?.slotIndex != null) {
        keys.push(favoriteId(entry.jobId, entry.slotIndex));
      }
    });
    favoriteKeys = new Set(keys);
    refreshFavoriteButtons();
  }

  async function migrateLegacyFavorites() {
    const legacy = readLegacyFavorites();
    if (!legacy.length) return;
    const unresolved = [];
    for (const item of legacy) {
      const ok = await tryImportLegacyFavorite(item);
      if (!ok) unresolved.push(item);
    }
    if (unresolved.length) {
      writeLegacyFavorites(unresolved);
    } else {
      localStorage.removeItem(LS_FAVORITES);
    }
  }

  async function initFavorites() {
    await migrateLegacyFavorites();
    await loadFavoritesFromServer();
  }

  async function toggleFavoriteItem(item) {
    const key = favoriteId(item.jobId, item.slotIndex);
    const existing = favoriteItems.find(
      (entry) => (entry.job_slot_key || favoriteId(entry.job_id, entry.slot_index)) === key
    );
    if (existing) {
      await api(`/api/favorites/${encodeURIComponent(existing.id)}`, { method: 'DELETE' });
      removeFavoriteItemStateByKey(item.jobId, item.slotIndex);
      refreshFavoriteButtons();
      return false;
    }
    const created = await api('/api/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: item.jobId,
        slot_index: item.slotIndex,
      }),
    });
    upsertFavoriteItem(created);
    refreshFavoriteButtons();
    return true;
  }

  function rememberActiveJob(type, jobId) {
    const items = readActiveJobs();
    items[type] = { jobId, ts: Date.now() };
    writeActiveJobs(items);
    syncTaskCancelButtons();
  }

  function forgetActiveJob(type, jobId) {
    const items = readActiveJobs();
    if (!items[type]) return;
    if (jobId && items[type].jobId !== jobId) return;
    delete items[type];
    writeActiveJobs(items);
    syncTaskCancelButtons();
  }

  function forgetActiveJobById(jobId) {
    const items = readActiveJobs();
    let changed = false;
    Object.keys(items).forEach((type) => {
      if (items[type]?.jobId === jobId) {
        delete items[type];
        changed = true;
      }
    });
    if (changed) {
      writeActiveJobs(items);
      syncTaskCancelButtons();
    }
  }

  function clearAllActiveJobs() {
    writeActiveJobs({});
    syncTaskCancelButtons();
  }

  function fmtDebugTime(ts) {
    const date = new Date(ts);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
  }

  function readDebugHidden() {
    return localStorage.getItem(LS_DEBUG_HIDDEN) === '1';
  }

  function writeDebugHidden(hidden) {
    localStorage.setItem(LS_DEBUG_HIDDEN, hidden ? '1' : '0');
  }

  function readDebugClearTs() {
    const raw = parseInt(localStorage.getItem(LS_DEBUG_CLEAR_TS) || '0', 10);
    return Number.isFinite(raw) ? raw : 0;
  }

  function writeDebugClearTs(ts) {
    localStorage.setItem(LS_DEBUG_CLEAR_TS, String(ts));
  }

  function ingestDebugJob(job) {
    if (!job?.id) return;
    debugJobs.set(job.id, {
      id: job.id,
      status: job.status,
      updatedAt: job.updated_at || 0,
      items: Array.isArray(job.debug_log) ? job.debug_log : [],
    });
  }

  function ingestDebugJobs(items) {
    (items || []).forEach((job) => ingestDebugJob(job));
    renderGlobalDebugLog();
  }

  function removeJobDebug(jobId) {
    if (!jobId) return;
    debugJobs.delete(jobId);
    renderGlobalDebugLog();
  }

  async function maybeOpenDeepLinkedJob() {
    const params = new URLSearchParams(window.location.search);
    const jobId = params.get('job');
    if (!jobId) return;
    try {
      const job = await api(`/api/jobs/${jobId}`);
      openRecentDetail(job);
    } catch (e) {
    } finally {
      params.delete('job');
      const next = params.toString();
      history.replaceState({}, '', next ? `/?${next}` : '/');
    }
  }

  async function maybeApplyReuseSnapshot() {
    const raw = localStorage.getItem(LS_REUSE_SNAPSHOT);
    if (!raw) return false;
    localStorage.removeItem(LS_REUSE_SNAPSHOT);
    try {
      const payload = JSON.parse(raw);
      if (!payload || typeof payload !== 'object' || !payload.type) return false;
      await reuseRecord(payload);
      return true;
    } catch (e) {
      return false;
    }
  }

  function renderGlobalDebugLog() {
    const card = $('globalDebugCard');
    const container = $('globalDebugLog');
    const countEl = $('globalDebugCount');
    const toggleBtn = $('toggleDebugBtn');
    if (!card || !container || !countEl || !toggleBtn) return;

    const hidden = readDebugHidden();
    card.classList.toggle('collapsed', hidden);
    toggleBtn.textContent = hidden ? '展开' : '关闭';

    const cutoff = readDebugClearTs();
    const lines = [];
    debugJobs.forEach((entry) => {
      (entry.items || []).forEach((item) => {
        const ts = item?.ts || 0;
        if (ts <= cutoff) return;
        lines.push({
          jobId: entry.id,
          ts,
          kind: item?.kind || 'info',
          message: item?.message || '',
        });
      });
    });
    lines.sort((a, b) => a.ts - b.ts);
    countEl.textContent = lines.length ? `(${lines.length})` : '';

    container.innerHTML = '';
    if (!lines.length) {
      container.innerHTML = '<div class="debug-empty">服务端调试消息会显示在这里</div>';
      return;
    }

    lines.forEach((item) => {
      const line = document.createElement('div');
      line.className = `debug-line ${item.kind}`;

      const jobId = document.createElement('span');
      jobId.className = 'debug-jobid';
      jobId.textContent = `[${item.jobId}]`;
      line.appendChild(document.createTextNode(`[${fmtDebugTime(item.ts)}] `));
      line.appendChild(jobId);
      line.appendChild(document.createTextNode(item.message));
      container.appendChild(line);
    });
    container.scrollTop = container.scrollHeight;
  }

  function getCreds() {
    const key = (($('apiKey')?.value) || '').trim();
    const base = (($('baseUrl')?.value) || DEFAULT_BASE_URL).trim().replace(/\/$/, '');
    const model = (($('model')?.value) || DEFAULT_MODEL).trim();
    const quality = (($('quality')?.value) || DEFAULT_QUALITY).trim();
    const moderation = (($('moderation')?.value) || DEFAULT_MODERATION).trim();
    const batchMode = normalizeBatchMode(($('batchMode')?.value) || DEFAULT_BATCH_MODE);
    return { key, base, model, quality, moderation, batchMode };
  }

  function normalizeBatchMode(value) {
    return value === 'direct' ? 'direct' : DEFAULT_BATCH_MODE;
  }

  function setBatchMode(value) {
    if ($('batchMode')) $('batchMode').value = normalizeBatchMode(value);
  }

  function batchModeLabel(value) {
    return BATCH_MODE_LABELS[normalizeBatchMode(value)] || BATCH_MODE_LABELS[DEFAULT_BATCH_MODE];
  }

  function getTaskCount(selectId) {
    const rawCount = parseInt($(selectId)?.value || String(DEFAULT_IMAGE_COUNT), 10);
    return Number.isFinite(rawCount) ? Math.min(MAX_IMAGE_COUNT, Math.max(1, rawCount)) : DEFAULT_IMAGE_COUNT;
  }

  function setTaskCount(selectId, count) {
    const nextCount = Number.isFinite(count) ? Math.min(MAX_IMAGE_COUNT, Math.max(1, count)) : DEFAULT_IMAGE_COUNT;
    if ($(selectId)) $(selectId).value = String(nextCount);
  }

  function canRenderInlineResult(resultEl) {
    return Boolean(resultEl && !resultEl.hidden);
  }

  function syncTaskCancelButtons() {
    const activeJobs = readActiveJobs();
    Object.entries(TASK_UI).forEach(([type, ui]) => {
      const button = $(ui.stopBtnId);
      if (!button) return;
      const jobId = activeJobs[type]?.jobId || '';
      button.dataset.jobId = jobId;
      button.disabled = !jobId;
      button.hidden = !jobId;
    });
  }

  async function cancelJobRequest(jobId) {
    return api(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
  }

  async function cancelTrackedTask(taskType) {
    const ui = TASK_UI[taskType];
    const button = ui ? $(ui.stopBtnId) : null;
    const statusEl = ui ? $(ui.statusId) : null;
    const resultEl = ui ? $(ui.resultId) : null;
    const jobId = button?.dataset.jobId || readActiveJobs()[taskType]?.jobId;
    if (!jobId) return null;
    if (!confirm('确定结束当前任务吗？')) return null;
    if (button) button.disabled = true;
    if (statusEl) setStatus(statusEl, '正在结束任务…', 'loading');
    try {
      const job = await cancelJobRequest(jobId);
      forgetActiveJob(taskType, jobId);
      syncFeaturedJob(job);
      ingestDebugJob(job);
      renderGlobalDebugLog();
      if (canRenderInlineResult(resultEl)) {
        renderJobGallery(resultEl, job, {
          emptyText: ui?.failureText || '任务已取消',
          showPendingSlots: true,
          showFailureSlots: true,
        });
      }
      if (statusEl) setStatus(statusEl, '任务已取消', 'error');
      await refreshFeaturedJob();
      await updateHistoryBtnCount(false);
      return job;
    } catch (e) {
      if (statusEl) setStatus(statusEl, `结束失败: ${e.message}`, 'error');
      return null;
    } finally {
      syncTaskCancelButtons();
    }
  }

  function setHistoryView(view) {
    currentHistoryView = view === 'trash' ? 'trash' : 'active';
    $('historyViewActiveBtn')?.classList.toggle('active', currentHistoryView === 'active');
    $('historyViewTrashBtn')?.classList.toggle('active', currentHistoryView === 'trash');
  }

  function renderHistoryViewCounts(counts) {
    $('historyViewActiveCount').textContent = `(${counts?.active || 0})`;
    $('historyViewTrashCount').textContent = `(${counts?.trash || 0})`;
  }

  async function updateHistoryBtnCount(bump = false) {
    try {
      const payload = await api('/api/jobs/count');
      const n = payload.count || 0;
      const el = $('historyBtnCount');
      if (!el) return;
      el.textContent = n > 99 ? '99+' : String(n);
      el.classList.toggle('empty', n === 0);
      if (bump && n > 0) {
        el.classList.remove('bump');
        void el.offsetWidth;
        el.classList.add('bump');
      }
    } catch (e) {}
  }

  function applyTheme(theme) {
    if (theme === 'auto') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
    document.querySelectorAll('#themeToggle button').forEach((button) => {
      button.classList.toggle('active', button.dataset.themeVal === theme);
    });
  }

  function getRequestedImageCount(job) {
    const raw = parseInt(job?.n ?? DEFAULT_IMAGE_COUNT, 10);
    if (!Number.isFinite(raw)) return DEFAULT_IMAGE_COUNT;
    return Math.min(MAX_IMAGE_COUNT, Math.max(1, raw));
  }

  function getJobPreviewSlots(job) {
    if (Array.isArray(job?.preview_urls) && job.preview_urls.length) return job.preview_urls.slice();
    return job?.preview_url ? [job.preview_url] : [];
  }

  function getJobResultSlots(job) {
    if (Array.isArray(job?.result_urls) && job.result_urls.length) return job.result_urls.slice();
    return job?.result_url ? [job.result_url] : [];
  }

  function normalizeSlotNotes(values, totalSlots) {
    return Array.from({ length: totalSlots }, (_, index) => {
      const value = Array.isArray(values) ? values[index] : '';
      return typeof value === 'string' ? value.trim() : '';
    });
  }

  function getJobSlotErrors(job) {
    const totalSlots = Math.max(
      getRequestedImageCount(job),
      Array.isArray(job?.slot_errors) ? job.slot_errors.length : 0,
      1
    );
    return normalizeSlotNotes(job?.slot_errors, totalSlots);
  }

  function getJobSlotRevisedPrompts(job) {
    const totalSlots = Math.max(
      getRequestedImageCount(job),
      Array.isArray(job?.slot_revised_prompts) ? job.slot_revised_prompts.length : 0,
      1
    );
    const slotPrompts = normalizeSlotNotes(job?.slot_revised_prompts, totalSlots);
    if (totalSlots === 1 && !slotPrompts[0] && typeof job?.revised_prompt === 'string') {
      slotPrompts[0] = job.revised_prompt.trim();
    }
    return slotPrompts;
  }

  function getJobSlotPreviewPhases(job) {
    const totalSlots = Math.max(
      getRequestedImageCount(job),
      Array.isArray(job?.slot_preview_phases) ? job.slot_preview_phases.length : 0,
      1
    );
    return Array.from({ length: totalSlots }, (_, index) => {
      const value = Array.isArray(job?.slot_preview_phases) ? job.slot_preview_phases[index] : 0;
      return Number.isFinite(value) ? Math.max(0, Number(value) || 0) : 0;
    });
  }

  function compactUrls(items) {
    return (items || []).filter(Boolean);
  }

  function getJobPreviewUrls(job) {
    return compactUrls(getJobPreviewSlots(job));
  }

  function getJobResultUrls(job) {
    return compactUrls(getJobResultSlots(job));
  }

  function getJobImageUrl(job) {
    return getJobResultUrls(job)[0] || getJobPreviewUrls(job)[0] || null;
  }

  function getFirstFinalImageUrl(job) {
    const resultSlots = getJobResultSlots(job);
    const previewSlots = getJobPreviewSlots(job);
    const totalSlots = Math.max(getRequestedImageCount(job), resultSlots.length || 0, previewSlots.length || 0, 1);
    for (let index = 0; index < totalSlots; index += 1) {
      const finalUrl = resultSlots[index] || null;
      const previewUrl = previewSlots[index] || null;
      if (!finalUrl || isPreviewFallbackUrl(finalUrl, previewUrl)) continue;
      return finalUrl;
    }
    return null;
  }

  function getHistoryThumbUrl(job) {
    if (job?.thumb_url) return job.thumb_url;
    const finalUrl = getFirstFinalImageUrl(job);
    if (finalUrl) return finalUrl;
    if (job?.status === 'failed' && Array.isArray(job?.source_urls) && job.source_urls[0]) {
      return job.source_urls[0];
    }
    return getJobImageUrl(job) || (Array.isArray(job?.source_urls) ? job.source_urls[0] : null) || null;
  }

  function isRunningStatus(status) {
    return status === 'queued' || status === 'running';
  }

  function isTerminalStatus(status) {
    return status === 'succeeded' || status === 'failed' || status === 'cancelled';
  }

  function countRenderedImages(job) {
    if (!Array.isArray(job?.result_urls) && !Array.isArray(job?.preview_urls) && Number.isFinite(job?.rendered_count)) {
      return Math.max(0, Number(job.rendered_count) || 0);
    }
    const resultSlots = getJobResultSlots(job);
    const previewSlots = getJobPreviewSlots(job);
    const totalSlots = Math.max(getRequestedImageCount(job), resultSlots.length || 0, previewSlots.length || 0, 1);
    let count = 0;
    for (let index = 0; index < totalSlots; index += 1) {
      if (resultSlots[index] || previewSlots[index]) count += 1;
    }
    return count;
  }

  function countFinalImages(job) {
    if (!Array.isArray(job?.result_urls) && Number.isFinite(job?.final_count)) {
      return Math.max(0, Number(job.final_count) || 0);
    }
    const resultSlots = getJobResultSlots(job);
    const previewSlots = getJobPreviewSlots(job);
    const totalSlots = Math.max(getRequestedImageCount(job), resultSlots.length || 0, previewSlots.length || 0, 1);
    let count = 0;
    for (let index = 0; index < totalSlots; index += 1) {
      const finalUrl = resultSlots[index] || null;
      const previewUrl = previewSlots[index] || null;
      if (!finalUrl || isPreviewFallbackUrl(finalUrl, previewUrl)) continue;
      count += 1;
    }
    return count;
  }

  function getJobStatusText(job) {
    if (job?.status === 'succeeded') {
      if (getRequestedImageCount(job) <= 1) return '';
      return `${countFinalImages(job)}/${getRequestedImageCount(job)}`;
    }
    return STATUS_LABELS[job?.status] || job?.status || '';
  }

  function cleanupCompletionHints() {
    const now = Date.now();
    Array.from(recentCompletionHints.entries()).forEach(([jobId, ts]) => {
      if (now - ts > 12000) recentCompletionHints.delete(jobId);
    });
  }

  function getCurrentHistoryFilterValue() {
    return $('historyFilter')?.value || 'all';
  }

  function getCurrentHistorySearchValue() {
    return String($('historySearch')?.value || '').trim().toLowerCase();
  }

  function matchesFeaturedHistoryFilter(job, filterValue = getCurrentHistoryFilterValue()) {
    const normalized = String(filterValue || 'all').trim().toLowerCase();
    if (!job || normalized === 'all' || !normalized) return true;
    if (['succeeded', 'failed', 'cancelled', 'queued', 'running'].includes(normalized)) {
      return job.status === normalized;
    }
    if (['generate', 'edit', 'reference'].includes(normalized)) {
      return job.type === normalized;
    }
    return true;
  }

  function matchesFeaturedHistorySearch(job, searchText = getCurrentHistorySearchValue()) {
    const needle = String(searchText || '').trim().toLowerCase();
    if (!needle) return true;
    return String(job?.prompt || '').toLowerCase().includes(needle);
  }

  function canShowNewFeaturedJob(job) {
    return Boolean(
      job
      && job.id
      && currentHistoryView === 'active'
      && !job.trashed
      && featuredGridPage === 0
      && matchesFeaturedHistoryFilter(job)
      && matchesFeaturedHistorySearch(job)
    );
  }

  function shouldMergeLiveFeaturedJob(job) {
    return Boolean(
      job
      && job.id
      && featuredGridPage === 0
      && currentHistoryView === 'active'
      && !job.trashed
      && isRunningStatus(job.status)
      && matchesFeaturedHistoryFilter(job)
      && matchesFeaturedHistorySearch(job)
    );
  }

  function applyFeaturedOptimisticCounts(job) {
    if (!job?.id || job.trashed) return;
    featuredCounts = {
      ...featuredCounts,
      active: Math.max(0, Number(featuredCounts?.active || 0) + 1),
    };
    if (currentHistoryView !== 'active') return;
    if (!matchesFeaturedHistoryFilter(job) || !matchesFeaturedHistorySearch(job)) return;
    featuredTotalItems = Math.max(0, Number(featuredTotalItems || 0) + 1);
    featuredTotalPages = Math.max(1, Math.ceil(featuredTotalItems / FEATURED_GRID_SLOTS));
  }

  function syncFeaturedJob(job, options = {}) {
    if (!job?.id) return;
    liveFeaturedJobs.set(job.id, job);
    const nextItem = { ...job, thumb_url: getHistoryThumbUrl(job) || job.thumb_url || null };
    const existingIndex = featuredServerJobs.findIndex((item) => item.id === job.id);
    if (existingIndex >= 0) {
      featuredServerJobs = featuredServerJobs.map((item) => (
        item.id === job.id
          ? { ...item, ...nextItem, thumb_url: nextItem.thumb_url || item.thumb_url || null }
          : item
      ));
    } else {
      if (options.newlyCreated) applyFeaturedOptimisticCounts(job);
      if (options.newlyCreated && canShowNewFeaturedJob(job)) {
        featuredServerJobs = [nextItem, ...featuredServerJobs].slice(0, FEATURED_GRID_SLOTS);
      }
    }
    if (featuredJob?.id === job.id && $('recentDetailOverlay')?.classList.contains('active')) {
      renderRecentDetail(job);
    }
    if (options.completed && job.status === 'succeeded') {
      recentCompletionHints.set(job.id, Date.now());
    }
    cleanupCompletionHints();
    renderMergedFeaturedJobs();
  }

  function removeFeaturedJob(jobId) {
    if (!jobId) return;
    liveFeaturedJobs.delete(jobId);
    recentCompletionHints.delete(jobId);
    featuredServerJobs = featuredServerJobs.filter((job) => job.id !== jobId);
    renderMergedFeaturedJobs();
  }

  function getMergedFeaturedJobs() {
    cleanupCompletionHints();
    if (featuredGridPage !== 0 || currentHistoryView !== 'active') return featuredServerJobs;
    const merged = [];
    const seen = new Set();
    Array.from(liveFeaturedJobs.values())
      .filter((job) => shouldMergeLiveFeaturedJob(job))
      .sort((a, b) => Number(b?.created_at || 0) - Number(a?.created_at || 0))
      .forEach((job) => {
        if (seen.has(job.id)) return;
        merged.push(job);
        seen.add(job.id);
      });
    featuredServerJobs.forEach((job) => {
      if (!job?.id || seen.has(job.id)) return;
      merged.push(job);
      seen.add(job.id);
    });
    return merged.slice(0, FEATURED_GRID_SLOTS);
  }

  function primeNewFeaturedJob(job) {
    if (!job?.id) return;
    if (currentHistoryView === 'active') featuredGridPage = 0;
    syncFeaturedJob(job, { newlyCreated: true });
    void refreshFeaturedJob();
  }

  function resultFilename(job, slotIndex, totalSlots) {
    if (totalSlots <= 1) return `${job.type}-${job.id}.png`;
    return `${job.type}-${job.id}-${slotIndex + 1}.png`;
  }

  function downloadJobResults(job) {
    const slots = getJobResultSlots(job);
    const totalSlots = Math.max(getRequestedImageCount(job), slots.length || 0, 1);
    slots.forEach((url, index) => {
      if (!url) return;
      setTimeout(() => {
        void downloadUrl(url, resultFilename(job, index, totalSlots));
      }, index * 120);
    });
  }

  function gallerySignature(job) {
    return JSON.stringify({
      status: job?.status || '',
      n: getRequestedImageCount(job),
      preview: getJobPreviewSlots(job),
      result: getJobResultSlots(job),
      errors: getJobSlotErrors(job),
      previewPhases: getJobSlotPreviewPhases(job),
    });
  }

  function buildJobLightboxItems(job, options = {}) {
    const resultSlots = getJobResultSlots(job);
    const previewSlots = getJobPreviewSlots(job);
    const previewPhases = getJobSlotPreviewPhases(job);
    const totalSlots = Math.max(
      getRequestedImageCount(job),
      resultSlots.length || 0,
      previewSlots.length || 0,
      1
    );
    const showPendingSlots = options.showPendingSlots ?? !isTerminalStatus(job?.status);
    const items = [];
    for (let index = 0; index < totalSlots; index += 1) {
      if (!showPendingSlots && !resultSlots[index] && !previewSlots[index]) continue;
      const finalUrl = resultSlots[index] || null;
      const previewUrl = previewSlots[index] || null;
      const url = finalUrl || previewUrl;
      if (!url) continue;
      const isFallback = isPreviewFallbackUrl(finalUrl, previewUrl);
      const isFinal = Boolean(finalUrl) && !isFallback;
      const previewPhase = previewPhases[index] || 0;
      items.push({
        src: url,
        jobId: job.id,
        slotIndex: index,
        canFavorite: Boolean(isFinal),
        favoriteKey: isFinal ? favoriteId(job.id, index) : '',
        label: isFinal
          ? `最终图 ${index + 1}`
          : (isFallback ? `预览代结果 ${index + 1}` : (previewPhase ? `预览阶段 ${previewPhase}` : `预览 ${index + 1}`)),
      });
    }
    return items;
  }

  function isPreviewFallbackUrl(finalUrl, previewUrl) {
    if (!finalUrl) return false;
    if (previewUrl && finalUrl === previewUrl) return true;
    return /\/preview-\d+\.png(?:\?|$)/.test(finalUrl);
  }

  function summarizeFailureHint(job) {
    const raw = String(job?.error_message || '').trim();
    if (!raw) return '未收到图片';
    if (/响应里没有图片数据|提前结束/.test(raw)) return '流提前结束';
    if (/timeout|超时/i.test(raw)) return '上游超时';
    const httpMatch = raw.match(/HTTP\s+\d{3}/i);
    if (httpMatch) return httpMatch[0].toUpperCase();
    return truncate(raw.replace(/^失败:\s*/, ''), 32);
  }

  function isSafetyBlockedMessage(raw) {
    return /rejected by the safety system|safety_violations/i.test(String(raw || ''));
  }

  function summarizeSlotErrorHint(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    if (isSafetyBlockedMessage(text)) return 'failed: safety violation';
    if (/响应里没有图片数据|提前结束/.test(text)) return 'failed: stream ended';
    if (/timeout|超时/i.test(text)) return 'failed: timeout';
    const httpMatch = text.match(/HTTP\s+\d{3}/i);
    if (httpMatch) return `failed: ${httpMatch[0].toUpperCase()}`;
    return 'failed: upstream error';
  }

  function failureSlotText(job, index) {
    const slotErrors = getJobSlotErrors(job);
    const raw = slotErrors[index] || String(job?.error_message || '').trim();
    const hint = summarizeSlotErrorHint(raw) || summarizeFailureHint(job);
    return {
      label: hint || 'failed',
      hint: '',
    };
  }

  function createGalleryCard({
    src,
    label,
    downloadName,
    emptyLabel,
    emptyHint,
    emptyTone,
    onClick,
    final,
    fallbackHint,
    favoriteButton,
    actionButtons = [],
  }) {
    const card = document.createElement('div');
    card.className = 'result-card'
      + (emptyLabel ? ' empty' : '')
      + (fallbackHint ? ' fallback' : '')
      + (emptyTone ? ` ${emptyTone}` : '');
    if (emptyLabel) {
      const placeholder = document.createElement('div');
      placeholder.className = 'result-slot-placeholder';
      const title = document.createElement('div');
      title.className = 'result-slot-title';
      title.textContent = emptyLabel;
      placeholder.appendChild(title);
      if (emptyHint) {
        const hint = document.createElement('div');
        hint.className = 'result-slot-hint';
        hint.textContent = emptyHint;
        placeholder.appendChild(hint);
      }
      card.appendChild(placeholder);
      return card;
    }

    const img = document.createElement('img');
    img.src = src;
    img.alt = label;
    img.style.opacity = final ? '1' : '0.92';
    img.style.filter = final ? 'none' : 'brightness(0.96)';
    if (onClick) {
      img.style.cursor = 'zoom-in';
      img.onclick = onClick;
    }
    card.appendChild(img);

    const meta = document.createElement('div');
    meta.className = 'result-card-meta';

    const caption = document.createElement('div');
    caption.className = 'result-card-label';
    caption.textContent = label;
    if (!favoriteButton) meta.appendChild(caption);

    if (favoriteButton) {
      const fav = document.createElement('button');
      fav.type = 'button';
      fav.className = `result-card-fav${favoriteButton.active ? ' active' : ''}`;
      fav.dataset.favoriteKey = favoriteButton.key || '';
      fav.title = favoriteButton.active ? '取消收藏' : '收藏';
      fav.textContent = '♥';
      fav.onclick = async (e) => {
        e.stopPropagation();
        if (fav.disabled) return;
        fav.disabled = true;
        try {
          await favoriteButton.onToggle(fav);
        } finally {
          fav.disabled = false;
        }
      };
      meta.appendChild(fav);
    }

    if (fallbackHint) {
      const hint = document.createElement('div');
      hint.className = 'result-card-hint';
      hint.textContent = fallbackHint;
      meta.appendChild(hint);
    }

    if (downloadName || actionButtons.length) {
      const actions = document.createElement('div');
      actions.className = 'result-card-actions';

      const appendActionButton = (buttonConfig) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = buttonConfig.className || 'result-card-download secondary';
        button.textContent = buttonConfig.label;
        if (buttonConfig.title) button.title = buttonConfig.title;
        button.onclick = (event) => {
          event.stopPropagation();
          buttonConfig.onClick?.(event);
        };
        actions.appendChild(button);
      };

      actionButtons.filter((buttonConfig) => buttonConfig.beforeDownload).forEach(appendActionButton);

      if (downloadName) {
        const downloadBtn = document.createElement('button');
        downloadBtn.type = 'button';
        downloadBtn.className = 'result-card-download';
        downloadBtn.textContent = '下载';
        downloadBtn.onclick = async (event) => {
          event.stopPropagation();
          await downloadUrl(src, downloadName);
        };
        actions.appendChild(downloadBtn);
      }

      actionButtons.filter((buttonConfig) => !buttonConfig.beforeDownload).forEach(appendActionButton);

      meta.appendChild(actions);
    }

    card.appendChild(meta);
    return card;
  }

  function renderJobGallery(container, job, options = {}) {
    const resultSlots = getJobResultSlots(job);
    const previewSlots = getJobPreviewSlots(job);
    const slotErrors = getJobSlotErrors(job);
    const slotRevisedPrompts = getJobSlotRevisedPrompts(job);
    const slotPreviewPhases = getJobSlotPreviewPhases(job);
    const hasFinal = resultSlots.some(Boolean);
    const failed = job?.status === 'failed';
    const totalSlots = options.totalSlots || Math.max(
      getRequestedImageCount(job),
      resultSlots.length || 0,
      previewSlots.length || 0,
      slotErrors.length || 0,
      slotRevisedPrompts.length || 0,
      1
    );
    const hasSlotErrors = slotErrors.some(Boolean);
    const showPendingSlots = options.showPendingSlots ?? (!isTerminalStatus(job?.status) || hasSlotErrors || countRenderedImages(job) < totalSlots);
    const showFailureSlots = options.showFailureSlots ?? false;

    container.dataset.submitted = '1';
    container.innerHTML = '';

    if (!showPendingSlots && !hasFinal && !previewSlots.some(Boolean)) {
      container.innerHTML = `<div class="placeholder">${options.emptyText || '当前任务还没有可展示的图片'}</div>`;
      return;
    }

    const gallery = document.createElement('div');
    gallery.className = options.className || 'result-gallery';
    const indexes = [];
    for (let index = 0; index < totalSlots; index += 1) {
      if (showPendingSlots || resultSlots[index] || previewSlots[index] || slotErrors[index]) indexes.push(index);
    }
    if (!indexes.length) {
      container.innerHTML = `<div class="placeholder">${options.emptyText || '当前任务还没有可展示的图片'}</div>`;
      return;
    }
    const lightboxItems = buildJobLightboxItems(job, { showPendingSlots });
    const originalPrompt = String(job?.prompt || '').trim();
    indexes.forEach((index) => {
      const finalUrl = resultSlots[index] || null;
      const previewUrl = previewSlots[index] || null;
      const slotError = slotErrors[index] || '';
      const slotErrorHint = summarizeSlotErrorHint(slotError);
      const url = finalUrl || previewUrl;
      if (!url) {
        if (slotError || (showFailureSlots && isTerminalStatus(job?.status))) {
          const failedText = failureSlotText(job, index);
          gallery.appendChild(createGalleryCard({
            emptyLabel: failedText.label,
            emptyHint: failedText.hint,
            emptyTone: 'failed-slot',
          }));
        } else {
          gallery.appendChild(createGalleryCard({ emptyLabel: `等待第 ${index + 1} 张…` }));
        }
        return;
      }
      const isFallback = isPreviewFallbackUrl(finalUrl, previewUrl);
      const isFinal = Boolean(finalUrl) && !isFallback;
      const previewPhase = slotPreviewPhases[index] || 0;
      const favoriteButton = options.favoriteMode && isFinal
        ? {
            key: favoriteId(job.id, index),
            active: isFavorite(job.id, index),
            onToggle: async (buttonEl) => {
              const active = await toggleFavoriteItem({
                jobId: job.id,
                slotIndex: index,
              });
              buttonEl.classList.toggle('active', active);
              buttonEl.title = active ? '取消收藏' : '收藏';
            },
          }
        : null;
      const revisedPrompt = slotRevisedPrompts[index] || '';
      const actionButtons = [];
      if (options.enableAppendAction && isFinal) {
        actionButtons.push({
          label: '+',
          title: '追加到当前编辑器',
          className: 'result-card-download secondary result-card-icon-btn',
          beforeDownload: true,
          onClick: async () => {
            await appendJobImageToActiveEditor(job, finalUrl, index, totalSlots);
          },
        });
      }
      if (options.showRevisedPrompt && isFinal && revisedPrompt && revisedPrompt !== originalPrompt) {
        actionButtons.push({
          label: '改写词',
          className: 'result-card-download secondary',
          onClick: () => openTextDialog(`改写词 · 第 ${index + 1} 张`, revisedPrompt),
        });
      }
      const lightboxIndex = lightboxItems.findIndex((item) => item.slotIndex === index);
      gallery.appendChild(
        createGalleryCard({
          src: url,
          label: isFinal
            ? `最终图 ${index + 1}`
            : (isFallback ? `预览代结果 ${index + 1}` : (previewPhase ? `预览阶段 ${previewPhase}` : `预览 ${index + 1}`)),
          downloadName: isFinal ? resultFilename(job, index, totalSlots) : null,
          onClick: () => openLightbox(url, lightboxItems, lightboxIndex >= 0 ? lightboxIndex : 0),
          final: isFinal,
          fallbackHint: slotErrorHint || (isFallback ? '未收到最终图' : ''),
          favoriteButton,
          actionButtons,
        })
      );
    });
    container.appendChild(gallery);
  }

  function truncate(text, max = 150) {
    const value = String(text || '').trim();
    if (!value) return '';
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }

  function jobStatNodes(job) {
    const stats = [];
    if (!job) return stats;
    stats.push(TYPE_LABELS[job.type] || job.type);
    if (getJobStatusText(job)) stats.push(getJobStatusText(job));
    if (getRequestedImageCount(job) > 1) stats.push(batchModeLabel(job.batch_mode));
    if (job.size) stats.push(job.size);
    if (job.quality) stats.push(`quality:${job.quality}`);
    if (job.moderation) stats.push(`moderation:${job.moderation}`);
    if (job.duration_ms) stats.push(`${(job.duration_ms / 1000).toFixed(1)}s`);
    stats.push(fmtTime(job.created_at));
    return stats;
  }

  function renderStatList(container, values) {
    container.innerHTML = '';
    values.forEach((value) => {
      const item = document.createElement('span');
      item.className = 'featured-stat';
      item.textContent = value;
      container.appendChild(item);
    });
  }

  function pruneFeaturedSelection(items) {
    const visibleIds = new Set((items || []).map((item) => item.id));
    let changed = false;
    Array.from(featuredSelectedIds).forEach((jobId) => {
      if (visibleIds.has(jobId)) return;
      featuredSelectedIds.delete(jobId);
      changed = true;
    });
    if (featuredSelectionAnchorId && !visibleIds.has(featuredSelectionAnchorId)) {
      featuredSelectionAnchorId = '';
      changed = true;
    }
    return changed;
  }

  function setFeaturedSelectionMode(enabled) {
    const next = Boolean(enabled);
    if (featuredSelectionMode === next) return;
    featuredSelectionMode = next;
    if (!next) {
      featuredSelectedIds.clear();
      featuredSelectionAnchorId = '';
    }
    renderMergedFeaturedJobs();
  }

  function handleFeaturedThumbSelection(jobId, shiftKey) {
    const pageIds = featuredServerJobs.map((item) => item.id);
    if (shiftKey && featuredSelectionAnchorId && pageIds.includes(featuredSelectionAnchorId) && pageIds.includes(jobId)) {
      const start = pageIds.indexOf(featuredSelectionAnchorId);
      const end = pageIds.indexOf(jobId);
      const [from, to] = start <= end ? [start, end] : [end, start];
      pageIds.slice(from, to + 1).forEach((id) => featuredSelectedIds.add(id));
    } else if (featuredSelectedIds.has(jobId)) {
      featuredSelectedIds.delete(jobId);
      featuredSelectionAnchorId = jobId;
    } else {
      featuredSelectedIds.add(jobId);
      featuredSelectionAnchorId = jobId;
    }
    renderMergedFeaturedJobs();
  }

  function isCompactFeaturedMobileMode() {
    return window.innerWidth <= 760 && !mobileFeaturedExpanded && !featuredSelectionMode;
  }

  function renderFeaturedJobs(items) {
    const grid = $('featuredGrid');
    const pageInfoEl = $('featuredPageInfo');
    const prevBtn = $('featuredPrevBtn');
    const nextBtn = $('featuredNextBtn');
    const collapseBtn = $('featuredCollapseBtn');
    const selectionBtn = $('featuredSelectionBtn');
    const bulkActionBtn = $('featuredBulkActionBtn');
    const featuredCard = document.querySelector('.featured-card');
    const trashView = currentHistoryView === 'trash';
    featuredGridPage = Math.min(Math.max(featuredGridPage, 0), Math.max(featuredTotalPages - 1, 0));
    pruneFeaturedSelection(items);
    const selectedCount = featuredSelectedIds.size;
    const selectedJobs = items.filter((job) => featuredSelectedIds.has(job.id));
    const hasRunningSelected = !trashView && selectedJobs.some((job) => isRunningStatus(job.status));
    const compactMobile = isCompactFeaturedMobileMode();

    grid.innerHTML = '';
    grid.classList.toggle('compact-mobile', compactMobile);
    if (featuredCard) {
      featuredCard.classList.toggle('mobile-collapsed', compactMobile);
      featuredCard.classList.toggle('mobile-expanded', window.innerWidth <= 760 && !compactMobile);
    }
    renderHistoryViewCounts(featuredCounts);
    $('clearTrashBtn').hidden = !trashView;
    $('clearFailedHistoryBtn').hidden = trashView;
    if (collapseBtn) collapseBtn.hidden = !window.innerWidth || window.innerWidth > 760 || compactMobile;
    if (selectionBtn) {
      selectionBtn.textContent = featuredSelectionMode ? '结束' : '多选';
      selectionBtn.classList.toggle('is-active', featuredSelectionMode);
    }
    if (bulkActionBtn) {
      bulkActionBtn.hidden = !featuredSelectionMode || selectedCount === 0;
      bulkActionBtn.textContent = trashView ? `恢复 ${selectedCount}` : `回收 ${selectedCount}`;
      bulkActionBtn.classList.toggle('danger', !trashView);
      bulkActionBtn.disabled = hasRunningSelected;
      bulkActionBtn.title = hasRunningSelected ? '运行中的任务请先单独结束' : '';
    }
    if (pageInfoEl) pageInfoEl.textContent = `${featuredGridPage + 1} / ${featuredTotalPages}`;
    if (prevBtn) prevBtn.disabled = featuredGridPage <= 0;
    if (nextBtn) nextBtn.disabled = featuredGridPage >= featuredTotalPages - 1;

    const renderedItems = compactMobile ? items.slice(0, MOBILE_FEATURED_PREVIEW_COUNT) : items;

    if (!renderedItems.length) {
      grid.innerHTML = `<div class="featured-empty">${
        featuredTotalItems === 0
          ? '还没有任务。提交后会在这里按分页矩阵展示。'
          : (trashView ? '回收站没有匹配的记录' : '没有匹配的记录')
      }</div>`;
      return;
    }

    renderedItems.forEach((job) => {
      const imageUrl = getHistoryThumbUrl(job) || placeholderThumb(STATUS_LABELS[job.status] || '处理中');
      const requestedCount = getRequestedImageCount(job);
      const generatedCount = countFinalImages(job);
      const running = isRunningStatus(job.status);
      const justCompleted = recentCompletionHints.has(job.id) && job.status === 'succeeded';
      const selected = featuredSelectedIds.has(job.id);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `featured-thumb${running ? ' running' : ''}${justCompleted ? ' just-completed' : ''}${featuredSelectionMode ? ' selection-mode' : ''}${selected ? ' selected' : ''}`;
      card.onclick = (event) => {
        if (featuredSelectionMode) {
          handleFeaturedThumbSelection(job.id, event.shiftKey);
          return;
        }
        ensureJobDetail(job).then(openRecentDetail).catch((err) => {
          alert(`加载任务详情失败: ${err.message}`);
        });
      };

      const img = document.createElement('img');
      img.src = imageUrl;
      img.alt = truncate(job.prompt || TYPE_LABELS[job.type] || 'output', 80);
      card.appendChild(img);

      if (featuredSelectionMode) {
        const indicator = document.createElement('div');
        indicator.className = 'featured-select-indicator';
        indicator.textContent = selected ? '✓' : '';
        card.appendChild(indicator);
      }

      const badge = document.createElement('div');
      badge.className = 'featured-badge';
      const statusText = running ? '' : getJobStatusText(job);
      badge.textContent = statusText ? `${TYPE_LABELS[job.type] || job.type} · ${statusText}` : (TYPE_LABELS[job.type] || job.type);
      if (justCompleted) badge.classList.add('is-complete');

      if (running) {
        const progress = document.createElement('div');
        progress.className = 'featured-progress';
        progress.innerHTML = '<span></span>';
        card.appendChild(progress);
      }

      let reuseBtn = null;
      if (!featuredSelectionMode) {
        reuseBtn = document.createElement('button');
        reuseBtn.type = 'button';
        reuseBtn.className = 'featured-reuse';
        reuseBtn.title = '复用配置';
        reuseBtn.textContent = '↺';
        reuseBtn.onclick = async (e) => {
          e.stopPropagation();
          const detail = await ensureJobDetail(job);
          await reuseRecord(detail);
        };
        card.appendChild(reuseBtn);
      }

      const meta = document.createElement('div');
      meta.className = 'featured-meta';

      if (running) {
        const mini = document.createElement('div');
        mini.className = 'featured-mini';
        const progressStat = document.createElement('span');
        progressStat.className = 'featured-stat';
        progressStat.textContent = `已生成 ${generatedCount}/${requestedCount}`;
        mini.appendChild(progressStat);
        meta.appendChild(mini);
      }

      const prompt = document.createElement('div');
      prompt.className = 'featured-prompt';
      prompt.textContent = truncate(job.prompt || '(无 prompt)', 88);
      meta.appendChild(prompt);

      const footer = document.createElement('div');
      footer.className = 'featured-footer';
      footer.appendChild(badge);
      if (reuseBtn) footer.appendChild(reuseBtn);
      meta.appendChild(footer);

      card.appendChild(meta);
      grid.appendChild(card);
    });

    if (compactMobile) {
      if (items.length > MOBILE_FEATURED_PREVIEW_COUNT || featuredTotalPages > 1) {
        const moreBtn = document.createElement('button');
        moreBtn.type = 'button';
        moreBtn.className = 'featured-more-slot';
        moreBtn.innerHTML = `<strong>+</strong><span>更多缩略图</span>`;
        moreBtn.onclick = () => {
          mobileFeaturedExpanded = true;
          renderMergedFeaturedJobs();
        };
        grid.appendChild(moreBtn);
      }
      return;
    }

    for (let idx = renderedItems.length; idx < FEATURED_GRID_SLOTS; idx += 1) {
      const empty = document.createElement('div');
      empty.className = 'featured-empty-slot';
      grid.appendChild(empty);
    }

  }

  function renderMergedFeaturedJobs() {
    renderFeaturedJobs(getMergedFeaturedJobs());
  }

  async function refreshFeaturedJob() {
    const requestSeq = ++featuredRequestSeq;
    const filter = $('historyFilter')?.value || 'all';
    const search = ($('historySearch')?.value || '').trim();
    const trashed = currentHistoryView === 'trash' ? '1' : '0';
    const page = featuredGridPage + 1;
    const params = new URLSearchParams({
      limit: String(FEATURED_GRID_SLOTS),
      page: String(page),
      trashed,
      filter,
    });
    if (search) params.set('search', search);
    try {
      const payload = await api(`/api/jobs/summary?${params.toString()}`);
      if (requestSeq !== featuredRequestSeq) return;
      featuredTotalItems = Number(payload?.total || 0);
      featuredTotalPages = Math.max(1, Number(payload?.total_pages || 1));
      if (page > featuredTotalPages) {
        featuredGridPage = Math.max(0, featuredTotalPages - 1);
        return await refreshFeaturedJob();
      }
      featuredServerJobs = payload.items || [];
      featuredCounts = payload?.counts || { active: 0, trash: 0 };
      renderMergedFeaturedJobs();
    } catch (e) {
      if (requestSeq !== featuredRequestSeq) return;
      renderMergedFeaturedJobs();
    }
  }

  function bindUpload(inputId, boxId, labelId, previewId, metaId) {
    const input = $(inputId);
    const box = $(boxId);
    const label = $(labelId);
    const preview = $(previewId);
    const meta = metaId ? $(metaId) : null;
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return;
      box.classList.add('has-file');
      if (meta) {
        meta.textContent = `${file.name} (${(file.size / 1024).toFixed(0)} KB)`;
        meta.classList.add('active');
      } else {
        label.textContent = `${file.name} (${(file.size / 1024).toFixed(0)} KB)`;
      }
      const reader = new FileReader();
      reader.onload = () => {
        preview.src = reader.result;
        preview.style.display = 'block';
      };
      reader.readAsDataURL(file);
    });
    box.addEventListener('dragover', (e) => {
      e.preventDefault();
      box.style.borderColor = 'var(--accent)';
    });
    box.addEventListener('dragleave', () => {
      box.style.borderColor = '';
    });
    box.addEventListener('drop', (e) => {
      e.preventDefault();
      box.style.borderColor = '';
      if (e.dataTransfer.files[0]) {
        input.files = e.dataTransfer.files;
        input.dispatchEvent(new Event('change'));
      }
    });
  }

  function setFileToInput(inputId, file) {
    const input = $(inputId);
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) {
      return false;
    }
  }

  function updateRefLabel() {
    const label = $('refUploadLabel');
    if (!label) return;
    if (refImages.length === 0) {
      label.textContent = '点击 / 拖拽 / Ctrl+V 粘贴参考图';
      $('refUploadBox').classList.remove('has-file');
    } else {
      label.textContent = `已选择 ${refImages.length} 张参考图`;
      $('refUploadBox').classList.add('has-file');
    }
  }

  document.addEventListener('paste', (e) => {
    if ($('meOverlay').classList.contains('active')) return;

    const editActive = $('panel-edit')?.classList.contains('active');
    const refActive = $('panel-reference')?.classList.contains('active');
    if (!editActive && !refActive) return;

    const items = e.clipboardData?.items || [];
    const pastedFiles = [];
    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        if (!blob) continue;
        const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        pastedFiles.push(new File([blob], `pasted-${Date.now()}-${pastedFiles.length}.${ext}`, { type: blob.type }));
      }
    }
    if (pastedFiles.length === 0) return;
    e.preventDefault();

    if (editActive) {
      if (setFileToInput('editImage', pastedFiles[0])) {
        const box = $('editImageBox');
        const original = box.style.borderColor;
        box.style.borderColor = 'var(--ok)';
        setTimeout(() => {
          box.style.borderColor = original;
        }, 400);
      }
    } else {
      addRefImages(pastedFiles);
      const box = $('refUploadBox');
      const original = box.style.borderColor;
      box.style.borderColor = 'var(--ok)';
      setTimeout(() => {
        box.style.borderColor = original;
      }, 400);
    }
  });

  function updateMaskSourceHint() {
    const hint = $('maskSource');
    const clearBtn = $('clearMask');
    const editorBtn = $('openMaskEditor');
    const hasBaseImage = Boolean($('editImage').files[0]);
    const hasMaskImage = Boolean(maskFileFromEditor || $('editMask').files[0]);
    if (editorBtn) editorBtn.style.display = (hasBaseImage || hasMaskImage) ? '' : 'none';
    if (maskFileFromEditor) {
      if (hint) {
        hint.textContent = '';
        hint.style.color = '';
      }
      if (clearBtn) clearBtn.style.display = '';
    } else if ($('editMask').files[0]) {
      if (hint) {
        hint.textContent = '';
        hint.style.color = '';
      }
      if (clearBtn) clearBtn.style.display = '';
    } else {
      if (hint) {
        hint.textContent = '';
        hint.style.color = '';
      }
      if (clearBtn) clearBtn.style.display = 'none';
    }
  }

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  function openMaskEditor(imgFile) {
    return new Promise(async (resolve) => {
      const img = await loadImageFromFile(imgFile);
      const overlay = $('meOverlay');
      const imgCanvas = $('meImgCanvas');
      const paintCanvas = $('mePaintCanvas');
      const stack = $('meStack');
      const maxW = Math.min(window.innerWidth * 0.85, 1000);
      const maxH = window.innerHeight * 0.6;
      const scale = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
      const dispW = Math.round(img.naturalWidth * scale);
      const dispH = Math.round(img.naturalHeight * scale);

      [imgCanvas, paintCanvas].forEach((canvas) => {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.style.width = `${dispW}px`;
        canvas.style.height = `${dispH}px`;
      });
      stack.style.width = `${dispW}px`;
      stack.style.height = `${dispH}px`;

      const imgCtx = imgCanvas.getContext('2d');
      imgCtx.drawImage(img, 0, 0);

      const paintCtx = paintCanvas.getContext('2d');
      paintCtx.clearRect(0, 0, paintCanvas.width, paintCanvas.height);

      let painting = false;
      let lastX = 0;
      let lastY = 0;
      let mode = 'paint';
      let brushSize = parseInt($('brushSize').value, 10) || 40;
      const cursor = $('meCursor');
      const displayScale = dispW / img.naturalWidth;

      function updateCursorSize() {
        const size = brushSize * displayScale;
        cursor.style.width = `${size}px`;
        cursor.style.height = `${size}px`;
      }

      function showCursorAt(clientX, clientY) {
        const rect = paintCanvas.getBoundingClientRect();
        cursor.style.display = 'block';
        cursor.style.left = `${clientX - rect.left}px`;
        cursor.style.top = `${clientY - rect.top}px`;
      }

      function setMode(nextMode) {
        mode = nextMode;
        $('mePaintBtn').classList.toggle('active', nextMode === 'paint');
        $('meEraseBtn').classList.toggle('active', nextMode === 'erase');
        cursor.classList.toggle('erase', nextMode === 'erase');
      }

      function getPos(e) {
        const rect = paintCanvas.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * paintCanvas.width;
        const y = ((e.clientY - rect.top) / rect.height) * paintCanvas.height;
        return [x, y];
      }

      function drawStroke(x0, y0, x1, y1) {
        if (mode === 'paint') {
          paintCtx.globalCompositeOperation = 'source-over';
          paintCtx.strokeStyle = 'rgba(255, 60, 60, 0.5)';
        } else {
          paintCtx.globalCompositeOperation = 'destination-out';
          paintCtx.strokeStyle = 'rgba(0, 0, 0, 1)';
        }
        paintCtx.lineWidth = brushSize;
        paintCtx.lineCap = 'round';
        paintCtx.lineJoin = 'round';
        paintCtx.beginPath();
        paintCtx.moveTo(x0, y0);
        paintCtx.lineTo(x1, y1);
        paintCtx.stroke();
      }

      function cleanup() {
        overlay.classList.remove('active');
      }

      updateCursorSize();
      setMode('paint');
      $('mePaintBtn').onclick = () => setMode('paint');
      $('meEraseBtn').onclick = () => setMode('erase');
      $('brushSize').oninput = (e) => {
        brushSize = parseInt(e.target.value, 10) || 40;
        $('brushSizeVal').textContent = String(brushSize);
        updateCursorSize();
      };
      $('brushSizeVal').textContent = String(brushSize);
      $('meClearBtn').onclick = () => paintCtx.clearRect(0, 0, paintCanvas.width, paintCanvas.height);

      paintCanvas.onpointerdown = (e) => {
        painting = true;
        paintCanvas.setPointerCapture?.(e.pointerId);
        [lastX, lastY] = getPos(e);
        drawStroke(lastX, lastY, lastX + 0.01, lastY + 0.01);
        showCursorAt(e.clientX, e.clientY);
        e.preventDefault();
      };
      paintCanvas.onpointermove = (e) => {
        showCursorAt(e.clientX, e.clientY);
        if (!painting) return;
        const [x, y] = getPos(e);
        drawStroke(lastX, lastY, x, y);
        lastX = x;
        lastY = y;
        e.preventDefault();
      };
      paintCanvas.onpointerup = () => {
        painting = false;
      };
      paintCanvas.onpointercancel = () => {
        painting = false;
      };
      paintCanvas.onpointerenter = (e) => {
        showCursorAt(e.clientX, e.clientY);
      };
      paintCanvas.onpointerleave = () => {
        painting = false;
        cursor.style.display = 'none';
      };

      $('meCancelBtn').onclick = () => {
        cleanup();
        resolve(null);
      };
      $('meDoneBtn').onclick = () => {
        const data = paintCtx.getImageData(0, 0, paintCanvas.width, paintCanvas.height).data;
        let hasPaint = false;
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] > 0) {
            hasPaint = true;
            break;
          }
        }
        if (!hasPaint) {
          alert('你还没有涂抹任何区域');
          return;
        }

        const outCanvas = document.createElement('canvas');
        outCanvas.width = img.naturalWidth;
        outCanvas.height = img.naturalHeight;
        const outCtx = outCanvas.getContext('2d');
        outCtx.drawImage(img, 0, 0);
        outCtx.globalCompositeOperation = 'destination-out';
        outCtx.drawImage(paintCanvas, 0, 0);

        outCanvas.toBlob((blob) => {
          const file = new File([blob], 'mask.png', { type: 'image/png' });
          cleanup();
          resolve(file);
        }, 'image/png');
      };

      overlay.classList.add('active');
    });
  }

  function bindSizeSelect(selectId, customId) {
    const sel = $(selectId);
    const inp = $(customId);
    sel.addEventListener('change', () => {
      inp.style.display = sel.value === '__custom__' ? 'block' : 'none';
      if (sel.value === '__custom__') inp.focus();
    });
  }

  function validateSize(w, h) {
    if (w % MULTIPLE_OF !== 0 || h % MULTIPLE_OF !== 0) {
      return `宽和高必须都能被 ${MULTIPLE_OF} 整除（你输入的是 ${w}×${h}）`;
    }
    if (Math.max(w, h) > MAX_LONGEST) {
      return `最长边不能超过 ${MAX_LONGEST}（你输入的是 ${Math.max(w, h)}）`;
    }
    const pixels = w * h;
    if (pixels > MAX_PIXELS) {
      return `总像素不能超过 ${(MAX_PIXELS / 1e6).toFixed(2)} MP（你输入的是 ${(pixels / 1e6).toFixed(2)} MP）`;
    }
    if (pixels < MIN_PIXELS) {
      return `总像素至少 ${(MIN_PIXELS / 1e6).toFixed(2)} MP（你输入的是 ${(pixels / 1e6).toFixed(2)} MP）`;
    }
    return null;
  }

  function resolveSize(selectId, customId) {
    const value = $(selectId).value;
    if (value !== '__custom__') return { size: value };
    const raw = $(customId).value.trim().toLowerCase().replace(/\s+/g, '');
    const match = raw.match(/^(\d+)x(\d+)$/);
    if (!match) return { error: '自定义尺寸格式应为 宽x高，例如 1024x1024' };
    const width = parseInt(match[1], 10);
    const height = parseInt(match[2], 10);
    const err = validateSize(width, height);
    if (err) return { error: err };
    return { size: raw };
  }

  async function watchJob(jobId, statusEl, resultEl, failurePlaceholder, taskType) {
    let lastGallery = '';
    let lastStatus = null;
    while (true) {
      let job;
      try {
        job = await api(`/api/jobs/${jobId}`);
      } catch (e) {
        if (!taskType || activeWatchers.get(taskType) === jobId) {
          setStatus(statusEl, `任务已提交，但查询状态失败：${e.message}`, 'error');
        }
        return null;
      }

      syncFeaturedJob(job, { completed: lastStatus !== 'succeeded' && job.status === 'succeeded' });
      lastStatus = job.status;
      ingestDebugJob(job);
      renderGlobalDebugLog();
      const isPrimaryTask = !taskType || activeWatchers.get(taskType) === jobId;
      const renderInline = canRenderInlineResult(resultEl);

      const nextGallery = gallerySignature(job);
      if (!isTerminalStatus(job.status) && nextGallery !== lastGallery && renderInline) {
        renderJobGallery(resultEl, job, {
          emptyText: failurePlaceholder,
          showFailureSlots: true,
          favoriteMode: true,
        });
        lastGallery = nextGallery;
      }

      if (job.status === 'succeeded') {
        if (renderInline && (getJobResultUrls(job).length || getJobPreviewUrls(job).length)) {
          renderJobGallery(resultEl, job, {
            emptyText: failurePlaceholder,
            favoriteMode: true,
          });
          lastGallery = nextGallery;
        }
        const duration = job.duration_ms ? `，用时 ${(job.duration_ms / 1000).toFixed(1)}s` : '';
        if (isPrimaryTask) setStatus(statusEl, `✓ 成功${duration}`, 'ok');
        if (taskType) forgetActiveJob(taskType, jobId);
        await updateHistoryBtnCount(true);
        await refreshFeaturedJob();
        return job;
      }

      if (job.status === 'failed') {
        if (isPrimaryTask) setStatus(statusEl, `失败: ${job.error_message || '任务失败'}`, 'error');
        if (renderInline) {
          renderJobGallery(resultEl, job, {
            emptyText: failurePlaceholder,
            showPendingSlots: true,
            showFailureSlots: true,
            favoriteMode: true,
          });
        }
        lastGallery = nextGallery;
        if (taskType) forgetActiveJob(taskType, jobId);
        await updateHistoryBtnCount(false);
        await refreshFeaturedJob();
        return job;
      }

      if (job.status === 'cancelled') {
        if (isPrimaryTask) setStatus(statusEl, '任务已取消', 'error');
        if (renderInline) {
          renderJobGallery(resultEl, job, {
            emptyText: '任务已取消',
            showPendingSlots: true,
            showFailureSlots: true,
            favoriteMode: true,
          });
        }
        lastGallery = nextGallery;
        if (taskType) forgetActiveJob(taskType, jobId);
        await updateHistoryBtnCount(false);
        await refreshFeaturedJob();
        return job;
      }

      const progress = job.progress_message || (job.status === 'queued' ? '任务排队中…' : '服务端处理中…');
      if (isPrimaryTask) setStatus(statusEl, `${progress} 可关闭页面，稍后在历史记录查看。`, 'loading');
      await sleep(2000);
    }
  }

  function startWatchingJob(taskType, jobId, statusEl, resultEl, failurePlaceholder) {
    if (!jobId) return;
    if (activeWatchers.get(taskType) === jobId) return Promise.resolve(null);
    activeWatchers.set(taskType, jobId);
    return watchJob(jobId, statusEl, resultEl, failurePlaceholder, taskType)
      .catch((e) => {
        if (activeWatchers.get(taskType) === jobId) {
          setStatus(statusEl, `任务恢复失败：${e.message}`, 'error');
        }
        return null;
      })
      .finally(() => {
        if (activeWatchers.get(taskType) === jobId) activeWatchers.delete(taskType);
      });
  }

  function resumeTrackedJobs() {
    const items = readActiveJobs();
    Object.entries(items).forEach(([type, payload]) => {
      const ui = TASK_UI[type];
      if (!ui || !payload?.jobId) return;
      const statusEl = $(ui.statusId);
      const resultEl = $(ui.resultId);
      if (!statusEl || !resultEl) return;
      setStatus(statusEl, '正在恢复任务状态…', 'loading');
      if (resultEl.dataset.submitted !== '1') resultEl.dataset.submitted = '1';
      startWatchingJob(type, payload.jobId, statusEl, resultEl, ui.failureText);
    });
  }

  function placeholderThumb(label) {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="88" height="88">
        <rect width="100%" height="100%" fill="#1f2937"/>
        <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#9ca3af" font-size="12">${label}</text>
      </svg>
    `;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  function fmtTime(ts) {
    const diff = Date.now() - ts;
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${sec} 秒前`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} 分钟前`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} 小时前`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day} 天前`;
    const date = new Date(ts);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  async function urlToFile(url, fallbackName) {
    const resp = await fetch(url);
    const blob = await resp.blob();
    return new File([blob], fallbackName, { type: blob.type || 'image/png' });
  }

  function getActiveEditorTab() {
    return document.querySelector('.tab.active')?.dataset.tab || 'generate';
  }

  function activateEditorTab(tabName) {
    document.querySelector(`.tab[data-tab="${tabName}"]`)?.click();
  }

  let appendChoiceResolver = null;

  function closeAppendChoice(choice = null) {
    $('appendChoiceOverlay').classList.remove('active');
    if (appendChoiceResolver) {
      appendChoiceResolver(choice);
      appendChoiceResolver = null;
    }
  }

  function chooseAppendTarget() {
    $('appendChoiceOverlay').classList.add('active');
    return new Promise((resolve) => {
      appendChoiceResolver = resolve;
    });
  }

  async function appendFileToActiveEditor(file) {
    let targetTab = getActiveEditorTab();
    if (targetTab === 'generate') {
      const choice = await chooseAppendTarget();
      if (!choice) return;
      targetTab = choice;
      activateEditorTab(targetTab);
    }
    if (targetTab === 'edit') {
      maskFileFromEditor = null;
      resetUploadBox('editMask', 'editMaskBox', 'editMaskLabel', 'editMaskPreview', '点击 / 拖拽上传蒙版', 'editMaskMeta');
      setFileToInput('editImage', file);
      updateMaskSourceHint();
      return;
    }
    if (targetTab === 'reference') addRefImages([file]);
  }

  async function appendUrlToActiveEditor(url, fallbackName) {
    if (!url) return;
    try {
      const file = await urlToFile(url, fallbackName);
      await appendFileToActiveEditor(file);
    } catch (err) {
      alert(`追加图片失败: ${err.message}`);
    }
  }

  async function appendJobImageToActiveEditor(job, url, slotIndex, totalSlots) {
    await appendUrlToActiveEditor(url, resultFilename(job, slotIndex, totalSlots));
  }

  function triggerDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    if (filename) a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function downloadUrl(url, filename) {
    if (!url) return;
    try {
      const resp = await fetch(url, { credentials: 'same-origin' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const objectUrl = URL.createObjectURL(blob);
      triggerDownload(objectUrl, filename);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
      return;
    } catch (err) {
      console.warn('download fallback to direct URL', err);
    }
    triggerDownload(url, filename);
  }

  function normalizeLightboxItems(items, fallbackSrc) {
    const normalized = (items || [])
      .map((item) => {
        if (!item) return null;
        if (typeof item === 'string') return { src: item, label: '' };
        if (!item.src) return null;
        return {
          src: item.src,
          label: item.label || '',
          jobId: item.jobId || '',
          slotIndex: Number.isFinite(item.slotIndex) ? item.slotIndex : -1,
          canFavorite: Boolean(item.canFavorite),
          favoriteKey: item.favoriteKey || '',
        };
      })
      .filter(Boolean);
    if (normalized.length) return normalized;
    return fallbackSrc ? [{ src: fallbackSrc, label: '' }] : [];
  }

  function updateLightboxFavoriteButton() {
    const button = $('lightboxFavBtn');
    if (!button) return;
    const item = lightboxState.items[lightboxState.index];
    if (!item?.canFavorite || !item?.favoriteKey) {
      button.hidden = true;
      button.disabled = true;
      button.dataset.favoriteKey = '';
      return;
    }
    const active = favoriteKeys.has(item.favoriteKey);
    button.hidden = false;
    button.disabled = false;
    button.dataset.favoriteKey = item.favoriteKey;
    button.classList.toggle('active', active);
    button.title = active ? '取消收藏' : '收藏';
  }

  function syncLightboxView() {
    const item = lightboxState.items[lightboxState.index];
    if (!item) return;
    $('lightboxImg').src = item.src;
    $('lightboxImg').alt = item.label || '';
    $('lightboxPrev').disabled = lightboxState.index <= 0;
    $('lightboxNext').disabled = lightboxState.index >= lightboxState.items.length - 1;
    updateLightboxFavoriteButton();
  }

  function openLightbox(src, items = null, index = 0) {
    lightboxState.items = normalizeLightboxItems(items, src);
    if (!lightboxState.items.length) return;
    lightboxState.index = Math.max(0, Math.min(index, lightboxState.items.length - 1));
    syncLightboxView();
    $('lightbox').classList.add('active');
  }

  function moveLightbox(step) {
    if (!$('lightbox').classList.contains('active')) return;
    const total = lightboxState.items.length;
    if (total <= 1) return;
    const nextIndex = lightboxState.index + step;
    if (nextIndex < 0 || nextIndex >= total) return;
    lightboxState.index = nextIndex;
    syncLightboxView();
  }

  function closeLightbox() {
    $('lightbox').classList.remove('active');
    $('lightboxImg').src = '';
    $('lightboxImg').alt = '';
    $('lightboxFavBtn').hidden = true;
    $('lightboxFavBtn').disabled = true;
    $('lightboxFavBtn').dataset.favoriteKey = '';
    lightboxState = { items: [], index: 0 };
  }

  function openTextDialog(title, text) {
    $('textDialogTitle').textContent = title || '文本';
    $('textDialogContent').textContent = text || '';
    $('textDialogOverlay').classList.add('active');
  }

  function closeTextDialog() {
    $('textDialogOverlay').classList.remove('active');
    $('textDialogTitle').textContent = '';
    $('textDialogContent').textContent = '';
  }

  let lastLightboxWheelTs = 0;

  function getJobReferenceAssets(job) {
    const items = [];
    const sourceUrls = Array.isArray(job?.source_urls) ? job.source_urls.filter(Boolean) : [];
    if (job?.type === 'edit') {
      if (sourceUrls[0]) items.push({ label: '原图', url: sourceUrls[0], appendable: true, fallbackName: `edit-source-${job.id}.png` });
      if (job?.mask_url) items.push({ label: '蒙版', url: job.mask_url, appendable: false, fallbackName: `edit-mask-${job.id}.png` });
      return { label: '关联图片', items };
    }
    if (job?.type === 'reference') {
      sourceUrls.forEach((url, index) => {
        items.push({ label: `参考图 ${index + 1}`, url, appendable: true, fallbackName: `reference-source-${job.id}-${index + 1}.png` });
      });
      return { label: '参考图', items };
    }
    return { label: '参考图', items: [] };
  }

  function renderDetailReferences(job) {
    const wrap = $('recentDetailRefsWrap');
    const label = $('recentDetailRefsLabel');
    const container = $('recentDetailRefs');
    const assets = getJobReferenceAssets(job);
    container.innerHTML = '';
    if (!assets.items.length) {
      wrap.hidden = true;
      return;
    }
    label.textContent = assets.label;
    const lightboxItems = assets.items.map((asset) => ({ src: asset.url, label: asset.label }));
    assets.items.forEach((asset, index) => {
      const item = document.createElement('div');
      item.className = 'detail-ref';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'detail-ref-media';
      button.onclick = () => openLightbox(asset.url, lightboxItems, index);
      const img = document.createElement('img');
      img.src = asset.url;
      img.alt = asset.label;
      button.appendChild(img);
      const caption = document.createElement('span');
      caption.textContent = asset.label;
      item.appendChild(button);
      item.appendChild(caption);
      if (asset.appendable) {
        const appendBtn = document.createElement('button');
        appendBtn.type = 'button';
        appendBtn.className = 'secondary detail-ref-append';
        appendBtn.textContent = '+';
        appendBtn.title = '追加到当前编辑器';
        appendBtn.onclick = async () => {
          await appendUrlToActiveEditor(asset.url, asset.fallbackName || `${asset.label}.png`);
        };
        item.appendChild(appendBtn);
      }
      container.appendChild(item);
    });
    wrap.hidden = false;
  }

  function renderRecentDetail(job) {
    if (!job) return;
    featuredJob = job;
    const imageWrap = $('recentDetailImage');
    const prompt = $('recentDetailPrompt');
    const stats = $('recentDetailStats');
    const resultUrls = getJobResultUrls(job);
    const originalPrompt = String(job.prompt || '').trim();
    const hasSlotErrors = getJobSlotErrors(job).some(Boolean);
    const showPendingSlots = !isTerminalStatus(job.status) || hasSlotErrors || countRenderedImages(job) < getRequestedImageCount(job);
    const showFailureSlots = hasSlotErrors || job.status !== 'succeeded';

    renderJobGallery(imageWrap, job, {
      className: 'detail-gallery',
      emptyText: '当前任务还没有可展示的图片',
      showPendingSlots,
      showFailureSlots,
      favoriteMode: true,
      enableAppendAction: true,
      showRevisedPrompt: true,
    });

    renderStatList(stats, jobStatNodes(job));
    prompt.textContent = originalPrompt || '(无 prompt)';
    renderDetailReferences(job);
    $('recentDetailDownloadBtn').disabled = !resultUrls.length;
    $('recentDetailDownloadBtn').textContent = resultUrls.length > 1 ? '下载全部' : '下载';
    const running = isRunningStatus(job.status);
    $('recentDetailDeleteBtn').textContent = running ? '结束任务' : (job.trashed ? '恢复' : '🗑');
    $('recentDetailDeleteBtn').classList.toggle('is-restore', Boolean(job.trashed) && !running);
    $('recentDetailDeleteBtn').classList.toggle('is-icon', !job.trashed && !running);
    $('recentDetailDeleteBtn').title = running ? '主动结束任务' : (job.trashed ? '恢复任务' : '移入回收站');
  }

  function openRecentDetail(job) {
    if (!job) return;
    if (recentCompletionHints.has(job.id)) {
      recentCompletionHints.delete(job.id);
      renderMergedFeaturedJobs();
    }
    renderRecentDetail(job);
    $('recentDetailOverlay').classList.add('active');
  }

  function closeRecentDetail() {
    $('recentDetailOverlay').classList.remove('active');
  }

  async function moveJobToTrash(jobId) {
    await api(`/api/jobs/${jobId}`, { method: 'DELETE' });
    forgetActiveJobById(jobId);
    removeFeaturedJob(jobId);
    removeJobDebug(jobId);
  }

  async function restoreJobFromTrash(jobId) {
    await api(`/api/jobs/${jobId}/restore`, { method: 'POST' });
  }

  function hasFullJobDetail(job) {
    return Boolean(
      job
      && ('result_urls' in job || 'preview_urls' in job || 'source_urls' in job || 'mask_url' in job || 'quality' in job)
    );
  }

  async function ensureJobDetail(job) {
    if (!job?.id) return job;
    if (hasFullJobDetail(job)) return job;
    return api(`/api/jobs/${job.id}`);
  }

  async function reuseRecord(rec) {
    document.querySelector(`.tab[data-tab="${rec.type}"]`)?.click();
    if (rec.type === 'generate') {
      $('genPrompt').value = rec.prompt || '';
      setSize('genSize', 'genSizeCustom', rec.size);
      setTaskCount('genCount', getRequestedImageCount(rec));
    } else if (rec.type === 'edit') {
      $('editPrompt').value = rec.prompt || '';
      setSize('editSize', 'editSizeCustom', rec.size);
      setTaskCount('editCount', getRequestedImageCount(rec));
      if (rec.source_urls && rec.source_urls[0]) {
        const file = await urlToFile(rec.source_urls[0], 'reused-source.png');
        setFileToInput('editImage', file);
      }
      if (rec.mask_url) {
        maskFileFromEditor = null;
        const file = await urlToFile(rec.mask_url, 'reused-mask.png');
        setFileToInput('editMask', file);
      }
      updateMaskSourceHint();
    } else if (rec.type === 'reference') {
      $('refPrompt').value = rec.prompt || '';
      setSize('refSize', 'refSizeCustom', rec.size);
      setTaskCount('refCount', getRequestedImageCount(rec));
      if (rec.source_urls && rec.source_urls.length) {
        refImages = [];
        for (let i = 0; i < rec.source_urls.length; i += 1) {
          refImages.push(await urlToFile(rec.source_urls[i], `reused-ref-${i + 1}.png`));
        }
        renderRefThumbs();
      }
    }
    setBatchMode(rec.batch_mode || DEFAULT_BATCH_MODE);
    $('quality').value = rec.quality || DEFAULT_QUALITY;
    $('moderation').value = rec.moderation || DEFAULT_MODERATION;
  }

  function setSize(selectId, customId, value) {
    if (!value) return;
    const select = $(selectId);
    const matched = Array.from(select.options).some((option) => option.value === value);
    if (matched) {
      select.value = value;
      $(customId).style.display = 'none';
      $(customId).value = '';
    } else {
      select.value = '__custom__';
      $(customId).value = value;
      $(customId).style.display = 'block';
    }
  }

  async function renderHistory() {
    await refreshFeaturedJob();
  }

  function renderRefThumbs() {
    const wrap = $('refThumbs');
    wrap.innerHTML = '';
    refImages.forEach((file, i) => {
      const div = document.createElement('div');
      div.className = 'ref-thumb';
      div.innerHTML = `
        <img src="${URL.createObjectURL(file)}" alt="">
        <div class="ref-thumb-idx">${i + 1}</div>
        <button type="button" class="ref-thumb-remove" title="删除">×</button>
        <div class="ref-thumb-name">${file.name} (${(file.size / 1024).toFixed(0)} KB)</div>
      `;
      div.querySelector('.ref-thumb-remove').onclick = (e) => {
        e.stopPropagation();
        refImages.splice(i, 1);
        renderRefThumbs();
      };
      wrap.appendChild(div);
    });
    updateRefLabel();
  }

  function addRefImages(files) {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      if (refImages.length >= MAX_REF_IMAGES) {
        alert(`最多 ${MAX_REF_IMAGES} 张参考图`);
        break;
      }
      refImages.push(file);
    }
    renderRefThumbs();
  }

  function resetUploadBox(inputId, boxId, labelId, previewId, defaultLabel, metaId) {
    $(inputId).value = '';
    $(previewId).style.display = 'none';
    $(previewId).src = '';
    $(boxId).classList.remove('has-file');
    $(labelId).textContent = defaultLabel;
    if (metaId && $(metaId)) {
      $(metaId).textContent = '';
      $(metaId).classList.remove('active');
    }
  }

  const savedTheme = localStorage.getItem(LS_THEME) || 'auto';
  applyTheme(savedTheme);

  document.querySelectorAll('#themeToggle button').forEach((button) => {
    button.addEventListener('click', () => {
      const theme = button.dataset.themeVal;
      localStorage.setItem(LS_THEME, theme);
      applyTheme(theme);
    });
  });

  $('baseUrl').value = DEFAULT_BASE_URL;
  $('model').value = DEFAULT_MODEL;
  $('quality').value = DEFAULT_QUALITY;
  $('moderation').value = DEFAULT_MODERATION;
  setBatchMode(DEFAULT_BATCH_MODE);
  setTaskCount('genCount', DEFAULT_IMAGE_COUNT);
  setTaskCount('editCount', DEFAULT_IMAGE_COUNT);
  setTaskCount('refCount', DEFAULT_IMAGE_COUNT);
  setSettingsStatus('正在加载数据库 profile…');
  settingsReady = initSettingsProfiles().catch((e) => {
    setSettingsStatus(`加载失败: ${e.message}`, 'error');
    throw e;
  });

  $('toggleKey').addEventListener('click', () => {
    const nextType = $('apiKey').type === 'password' ? 'text' : 'password';
    $('apiKey').type = nextType;
    $('toggleKey').textContent = nextType === 'password' ? '显示' : '隐藏';
  });

  ['profileName', 'apiKey', 'baseUrl', 'model'].forEach((id) => {
    $(id).addEventListener('input', markSettingsDirty);
  });
  ['quality', 'moderation', 'batchMode'].forEach((id) => {
    $(id).addEventListener('change', markSettingsDirty);
  });

  $('settingsProfileSelect').addEventListener('change', async (e) => {
    const nextId = e.target.value;
    if (!nextId || nextId === activeProfileId) return;
    if (settingsDirty && !confirm('当前 profile 有未保存修改，切换后会丢失这些修改。继续吗？')) {
      e.target.value = activeProfileId;
      return;
    }
    try {
      await activateProfile(nextId);
    } catch (err) {
      e.target.value = activeProfileId;
      setSettingsStatus(`切换失败: ${err.message}`, 'error');
    }
  });

  $('newProfileBtn').addEventListener('click', async () => {
    try {
      await createProfile();
    } catch (e) {
      setSettingsStatus(`新建失败: ${e.message}`, 'error');
    }
  });

  $('deleteProfileBtn').addEventListener('click', async () => {
    try {
      await deleteCurrentProfile();
    } catch (e) {
      setSettingsStatus(`删除失败: ${e.message}`, 'error');
    }
  });

  $('saveKey').addEventListener('click', async () => {
    try {
      await saveCurrentProfile({ message: '✓ 已保存到数据库' });
    } catch (e) {
      setSettingsStatus(`保存失败: ${e.message}`, 'error');
    }
  });
  $('openSettingsBtn').addEventListener('click', () => {
    refreshSettingsStatus();
    $('settingsOverlay').classList.add('active');
  });
  $('closeSettingsBtn').addEventListener('click', () => {
    $('settingsOverlay').classList.remove('active');
  });
  $('settingsOverlay').addEventListener('click', (e) => {
    if (e.target === $('settingsOverlay')) $('settingsOverlay').classList.remove('active');
  });

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((item) => item.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((panel) => panel.classList.remove('active'));
      tab.classList.add('active');
      $(`panel-${tab.dataset.tab}`).classList.add('active');
    });
  });

  bindUpload('editImage', 'editImageBox', 'editImageLabel', 'editImagePreview', 'editImageMeta');
  bindUpload('editMask', 'editMaskBox', 'editMaskLabel', 'editMaskPreview', 'editMaskMeta');
  bindSizeSelect('genSize', 'genSizeCustom');
  bindSizeSelect('editSize', 'editSizeCustom');
  bindSizeSelect('refSize', 'refSizeCustom');
  updateMaskSourceHint();
  updateRefLabel();
  setTimeout(() => initFavorites().catch(() => {}), 80);
  updateHistoryBtnCount(false);
  setTimeout(() => refreshFeaturedJob(), 120);
  setTimeout(() => resumeTrackedJobs(), 150);
  setTimeout(() => syncTaskCancelButtons(), 155);
  setTimeout(() => renderGlobalDebugLog(), 160);
  setTimeout(() => maybeApplyReuseSnapshot(), 200);
  setTimeout(() => maybeOpenDeepLinkedJob(), 220);

  $('toggleDebugBtn').addEventListener('click', () => {
    writeDebugHidden(!readDebugHidden());
    renderGlobalDebugLog();
  });
  $('clearDebugBtn').addEventListener('click', () => {
    writeDebugClearTs(Date.now());
    renderGlobalDebugLog();
  });

  $('editImage').addEventListener('change', updateMaskSourceHint);
  $('editMask').addEventListener('change', updateMaskSourceHint);
  $('clearMask').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    maskFileFromEditor = null;
    $('editMask').value = '';
    $('editMaskPreview').style.display = 'none';
    $('editMaskBox').classList.remove('has-file');
    $('editMaskLabel').textContent = '点击 / 拖拽上传蒙版';
    $('editMaskMeta').textContent = '';
    $('editMaskMeta').classList.remove('active');
    updateMaskSourceHint();
  });

  $('openMaskEditor').addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const imgFile = $('editImage').files[0];
    if (!imgFile) {
      alert('请先上传原图再打开编辑器');
      return;
    }
    const result = await openMaskEditor(imgFile);
    if (!result) return;
    maskFileFromEditor = result;
    $('editMask').value = '';
    $('editMaskPreview').src = URL.createObjectURL(result);
    $('editMaskPreview').style.display = 'block';
    $('editMaskBox').classList.add('has-file');
    $('editMaskMeta').textContent = `mask.png (${(result.size / 1024).toFixed(0)} KB, 来自在线涂抹编辑)`;
    $('editMaskMeta').classList.add('active');
    updateMaskSourceHint();
  });

  $('refImageInput').addEventListener('change', (e) => {
    addRefImages(e.target.files);
    e.target.value = '';
  });

  $('refUploadBox').addEventListener('dragover', (e) => {
    e.preventDefault();
    $('refUploadBox').style.borderColor = 'var(--accent)';
  });
  $('refUploadBox').addEventListener('dragleave', () => {
    $('refUploadBox').style.borderColor = '';
  });
  $('refUploadBox').addEventListener('drop', (e) => {
    e.preventDefault();
    $('refUploadBox').style.borderColor = '';
    addRefImages(e.dataTransfer.files);
  });

  $('genBtn').addEventListener('click', async () => {
    const status = $('genStatus');
    const result = $('genResult');
    try {
      await ensureSettingsSaved();
      const { key, base, model, quality, moderation, batchMode } = getCreds();
      const count = getTaskCount('genCount');
      const prompt = $('genPrompt').value.trim();
      const sizeResult = resolveSize('genSize', 'genSizeCustom');

      if (!key) return setStatus(status, '请先填写并保存 API Key', 'error');
      if (!prompt) return setStatus(status, '请填写 prompt', 'error');
      if (sizeResult.error) return setStatus(status, sizeResult.error, 'error');

      result.dataset.submitted = '0';
      setStatus(status, '正在提交任务到服务端…', 'loading');
      result.innerHTML = '<div class="placeholder">提交任务中…</div>';
      const job = await api('/api/jobs/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: key,
          prompt,
          size: sizeResult.size,
          n: count,
          base_url: base,
          model,
          quality,
          moderation,
          batch_mode: batchMode,
        }),
      });
      rememberActiveJob('generate', job.id);
      primeNewFeaturedJob(job);
      openRecentDetail(job);
      await startWatchingJob('generate', job.id, status, result, '生成失败');
    } catch (e) {
      setStatus(status, `失败: ${e.message}`, 'error');
      result.innerHTML = '<div class="placeholder">生成失败</div>';
    } finally {
    }
  });
  $('genStopBtn').addEventListener('click', () => {
    cancelTrackedTask('generate');
  });

  $('editBtn').addEventListener('click', async () => {
    const status = $('editStatus');
    const result = $('editResult');
    try {
      await ensureSettingsSaved();
      const { key, base, model, quality, moderation, batchMode } = getCreds();
      const count = getTaskCount('editCount');
      const imageFile = $('editImage').files[0];
      const maskFile = maskFileFromEditor || $('editMask').files[0];
      const prompt = $('editPrompt').value.trim();
      const sizeResult = resolveSize('editSize', 'editSizeCustom');

      if (!key) return setStatus(status, '请先填写并保存 API Key', 'error');
      if (!imageFile) return setStatus(status, '请上传原图', 'error');
      if (!prompt) return setStatus(status, '请填写修改描述', 'error');
      if (sizeResult.error) return setStatus(status, sizeResult.error, 'error');

      result.dataset.submitted = '0';
      setStatus(status, '正在提交任务到服务端…', 'loading');
      result.innerHTML = '<div class="placeholder">提交任务中…</div>';
      let uploadImage = imageFile;
      let uploadMask = maskFile;
      if ($('editShrinkUploads').checked) {
        setStatus(status, '正在缩小上传图片并提交…', 'loading');
        const prepared = await prepareEditUploadFiles(imageFile, maskFile);
        uploadImage = prepared.image;
        uploadMask = prepared.mask;
      }

      const fd = new FormData();
      fd.append('api_key', key);
      fd.append('base_url', base);
      fd.append('model', model);
      fd.append('prompt', prompt);
      fd.append('size', sizeResult.size);
      fd.append('n', String(count));
      fd.append('quality', quality);
      fd.append('moderation', moderation);
      fd.append('batch_mode', batchMode);
      fd.append('image', uploadImage);
      if (uploadMask) fd.append('mask', uploadMask);

      const job = await api('/api/jobs/edit', { method: 'POST', body: fd });
      rememberActiveJob('edit', job.id);
      primeNewFeaturedJob(job);
      openRecentDetail(job);
      await startWatchingJob('edit', job.id, status, result, '编辑失败');
    } catch (e) {
      setStatus(status, `失败: ${e.message}`, 'error');
      result.innerHTML = '<div class="placeholder">编辑失败</div>';
    } finally {
    }
  });
  $('editStopBtn').addEventListener('click', () => {
    cancelTrackedTask('edit');
  });

  $('refBtn').addEventListener('click', async () => {
    const status = $('refStatus');
    const result = $('refResult');
    try {
      await ensureSettingsSaved();
      const { key, base, model, quality, moderation, batchMode } = getCreds();
      const count = getTaskCount('refCount');
      const prompt = $('refPrompt').value.trim();
      const sizeResult = resolveSize('refSize', 'refSizeCustom');

      if (!key) return setStatus(status, '请先填写并保存 API Key', 'error');
      if (refImages.length === 0) return setStatus(status, '请至少上传一张参考图', 'error');
      if (!prompt) return setStatus(status, '请填写 prompt', 'error');
      if (sizeResult.error) return setStatus(status, sizeResult.error, 'error');

      result.dataset.submitted = '0';
      setStatus(status, `正在提交任务到服务端… 使用 ${refImages.length} 张参考图`, 'loading');
      result.innerHTML = '<div class="placeholder">提交任务中…</div>';
      let uploadImages = refImages.slice();
      if ($('refShrinkUploads').checked) {
        setStatus(status, `正在缩小 ${refImages.length} 张参考图并提交…`, 'loading');
        uploadImages = (await Promise.all(refImages.map((file) => resizeImageFileToMax(file)))).map((item) => item.file);
      }

      const fd = new FormData();
      fd.append('api_key', key);
      fd.append('base_url', base);
      fd.append('model', model);
      fd.append('prompt', prompt);
      fd.append('size', sizeResult.size);
      fd.append('n', String(count));
      fd.append('quality', quality);
      fd.append('moderation', moderation);
      fd.append('batch_mode', batchMode);
      uploadImages.forEach((file) => fd.append('image', file));

      const job = await api('/api/jobs/reference', { method: 'POST', body: fd });
      rememberActiveJob('reference', job.id);
      primeNewFeaturedJob(job);
      openRecentDetail(job);
      await startWatchingJob('reference', job.id, status, result, '生成失败');
    } catch (e) {
      setStatus(status, `失败: ${e.message}`, 'error');
      result.innerHTML = '<div class="placeholder">生成失败</div>';
    } finally {
    }
  });
  $('refStopBtn').addEventListener('click', () => {
    cancelTrackedTask('reference');
  });

  $('lightbox').addEventListener('click', () => {
    closeLightbox();
  });
  $('lightboxFavBtn').addEventListener('click', async (e) => {
    e.stopPropagation();
    const item = lightboxState.items[lightboxState.index];
    if (!item?.canFavorite || !item?.jobId || item.slotIndex < 0) return;
    const button = $('lightboxFavBtn');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const active = await toggleFavoriteItem({
        jobId: item.jobId,
        slotIndex: item.slotIndex,
      });
      button.classList.toggle('active', active);
      button.title = active ? '取消收藏' : '收藏';
    } finally {
      button.disabled = false;
      updateLightboxFavoriteButton();
    }
  });
  $('closeTextDialogBtn').addEventListener('click', closeTextDialog);

  function selectNodeText(node) {
    if (!node) return false;
    const selection = window.getSelection?.();
    if (!selection) return false;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  async function copyTextToClipboard(text, sourceNode) {
    if (!text) return 'copied';
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return 'copied';
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '16px';
    textarea.style.top = '16px';
    textarea.style.width = '1px';
    textarea.style.height = '1px';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } finally {
      textarea.remove();
    }
    if (copied) return 'copied';
    if (selectNodeText(sourceNode)) {
      try {
        copied = document.execCommand('copy');
      } catch (e) {
        copied = false;
      }
      if (copied) return 'copied';
      return 'selected';
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return 'copied';
    }
    return 'selected';
  }

  $('copyTextDialogBtn').addEventListener('click', async () => {
    const sourceNode = $('textDialogContent');
    const text = sourceNode.textContent || '';
    if (!text) return;
    try {
      const status = await copyTextToClipboard(text, sourceNode);
      if (status === 'selected') {
        alert('浏览器限制了自动复制，文本已选中，请按 Ctrl+C');
        return;
      }
      if (status !== 'copied') throw new Error('copy failed');
    } catch (e) {
      alert('复制失败，请手动复制');
    }
  });
  $('textDialogOverlay').addEventListener('click', (e) => {
    if (e.target === $('textDialogOverlay')) closeTextDialog();
  });
  $('lightboxPrev').addEventListener('click', (e) => {
    e.stopPropagation();
    moveLightbox(-1);
  });
  $('lightboxNext').addEventListener('click', (e) => {
    e.stopPropagation();
    moveLightbox(1);
  });
  $('lightbox').addEventListener('wheel', (e) => {
    if (!$('lightbox').classList.contains('active') || lightboxState.items.length <= 1) return;
    e.preventDefault();
    const now = Date.now();
    if (now - lastLightboxWheelTs < 140) return;
    lastLightboxWheelTs = now;
    moveLightbox(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });
  document.addEventListener('keydown', (e) => {
    if ($('textDialogOverlay').classList.contains('active') && e.key === 'Escape') {
      e.preventDefault();
      closeTextDialog();
      return;
    }
    if ($('appendChoiceOverlay').classList.contains('active') && e.key === 'Escape') {
      e.preventDefault();
      closeAppendChoice(null);
      return;
    }
    if (!$('lightbox').classList.contains('active')) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      moveLightbox(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      moveLightbox(-1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeLightbox();
    }
  });
  $('closeRecentDetailBtn').addEventListener('click', closeRecentDetail);
  $('recentDetailOverlay').addEventListener('click', (e) => {
    if (e.target === $('recentDetailOverlay')) closeRecentDetail();
  });
  $('closeAppendChoiceBtn').addEventListener('click', () => closeAppendChoice(null));
  $('appendChoiceEditBtn').addEventListener('click', () => closeAppendChoice('edit'));
  $('appendChoiceReferenceBtn').addEventListener('click', () => closeAppendChoice('reference'));
  $('appendChoiceOverlay').addEventListener('click', (e) => {
    if (e.target === $('appendChoiceOverlay')) closeAppendChoice(null);
  });
  $('recentDetailReuseBtn').addEventListener('click', async () => {
    if (!featuredJob) return;
    closeRecentDetail();
    await reuseRecord(featuredJob);
  });
  $('recentDetailDownloadBtn').addEventListener('click', () => {
    if (featuredJob && getJobResultUrls(featuredJob).length) downloadJobResults(featuredJob);
  });
  $('recentDetailDeleteBtn').addEventListener('click', async () => {
    if (!featuredJob) return;
    if (isRunningStatus(featuredJob.status)) {
      const cancelled = await cancelJobRequest(featuredJob.id);
      featuredJob = cancelled;
      forgetActiveJobById(cancelled.id);
      syncFeaturedJob(cancelled);
      ingestDebugJob(cancelled);
      renderGlobalDebugLog();
      openRecentDetail(cancelled);
      await refreshFeaturedJob();
      await updateHistoryBtnCount(false);
      return;
    }
    if (featuredJob.trashed) {
      await restoreJobFromTrash(featuredJob.id);
    } else {
      await moveJobToTrash(featuredJob.id);
    }
    closeRecentDetail();
    await renderHistory().catch(() => {});
    await updateHistoryBtnCount(false);
    await refreshFeaturedJob();
  });
  $('featuredPrevBtn').addEventListener('click', () => {
    featuredGridPage = Math.max(0, featuredGridPage - 1);
    renderHistory().catch(() => {});
  });
  $('featuredNextBtn').addEventListener('click', () => {
    featuredGridPage += 1;
    renderHistory().catch(() => {});
  });
  $('featuredCollapseBtn').addEventListener('click', () => {
    mobileFeaturedExpanded = false;
    renderMergedFeaturedJobs();
  });
  $('historySearch').addEventListener('input', () => {
    clearTimeout(searchT);
    searchT = setTimeout(() => {
      featuredGridPage = 0;
      renderHistory().catch(() => {});
    }, 150);
  });
  $('historyFilter').addEventListener('change', () => {
    featuredGridPage = 0;
    renderHistory().catch(() => {});
  });
  $('historyViewActiveBtn').addEventListener('click', () => {
    setHistoryView('active');
    featuredGridPage = 0;
    renderHistory().catch(() => {});
  });
  $('historyViewTrashBtn').addEventListener('click', () => {
    setHistoryView('trash');
    featuredGridPage = 0;
    renderHistory().catch(() => {});
  });
  let featuredResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(featuredResizeTimer);
    featuredResizeTimer = setTimeout(() => {
      if (window.innerWidth > 760) mobileFeaturedExpanded = false;
      renderMergedFeaturedJobs();
    }, 80);
  });
  $('clearFailedHistoryBtn').addEventListener('click', async () => {
    if (!confirm('确定删除所有失败记录吗？')) return;
    await api('/api/jobs?status=failed', { method: 'DELETE' });
    featuredServerJobs = featuredServerJobs.filter((job) => job.status !== 'failed');
    Array.from(liveFeaturedJobs.keys()).forEach((jobId) => {
      const job = liveFeaturedJobs.get(jobId);
      if (job?.status === 'failed') liveFeaturedJobs.delete(jobId);
    });
    Array.from(debugJobs.keys()).forEach((jobId) => {
      const job = debugJobs.get(jobId);
      if (job?.status === 'failed') debugJobs.delete(jobId);
    });
    renderGlobalDebugLog();
    renderMergedFeaturedJobs();
    await renderHistory();
    await updateHistoryBtnCount(false);
    await refreshFeaturedJob();
  });
  $('featuredSelectionBtn').addEventListener('click', () => {
    setFeaturedSelectionMode(!featuredSelectionMode);
  });
  $('featuredBulkActionBtn').addEventListener('click', async () => {
    const selectedIds = Array.from(featuredSelectedIds);
    if (!selectedIds.length) return;
    const allJobs = getMergedFeaturedJobs();
    const selectedJobs = selectedIds
      .map((jobId) => allJobs.find((job) => job.id === jobId))
      .filter(Boolean);
    const trashView = currentHistoryView === 'trash';
    if (!trashView) {
      const runningJobs = selectedJobs.filter((job) => isRunningStatus(job.status));
      if (runningJobs.length) {
        alert('多选回收暂不处理运行中的任务，请先结束这些任务。');
        return;
      }
      if (!confirm(`确定将选中的 ${selectedJobs.length} 条记录移入回收站吗？`)) return;
      await Promise.all(selectedJobs.map((job) => moveJobToTrash(job.id)));
    } else {
      if (!confirm(`确定恢复选中的 ${selectedJobs.length} 条记录吗？`)) return;
      await Promise.all(selectedJobs.map((job) => restoreJobFromTrash(job.id)));
    }
    if (featuredJob && featuredSelectedIds.has(featuredJob.id)) {
      closeRecentDetail();
    }
    featuredSelectedIds.clear();
    featuredSelectionAnchorId = '';
    await renderHistory().catch(() => {});
    await updateHistoryBtnCount(false);
    await refreshFeaturedJob();
  });
  $('clearTrashBtn').addEventListener('click', async () => {
    if (!confirm('确定清空回收站吗？此操作会永久删除其中的任务和文件。')) return;
    await api('/api/jobs?trashed=1', { method: 'DELETE' });
    await renderHistory();
    await updateHistoryBtnCount(false);
    await refreshFeaturedJob();
  });

  $('genResetBtn').addEventListener('click', () => {
    $('genPrompt').value = '';
    $('genSize').value = '1024x1024';
    setTaskCount('genCount', DEFAULT_IMAGE_COUNT);
    $('genSizeCustom').value = '';
    $('genSizeCustom').style.display = 'none';
    $('genStatus').textContent = '';
    $('genStatus').className = 'status';
    $('genResult').dataset.submitted = '0';
    $('genResult').innerHTML = '<div class="placeholder">生成的图片会显示在这里</div>';
  });

  $('refResetBtn').addEventListener('click', () => {
    refImages = [];
    renderRefThumbs();
    $('refShrinkUploads').checked = true;
    $('refPrompt').value = '';
    $('refSize').value = '1024x1024';
    setTaskCount('refCount', DEFAULT_IMAGE_COUNT);
    $('refSizeCustom').value = '';
    $('refSizeCustom').style.display = 'none';
    $('refStatus').textContent = '';
    $('refStatus').className = 'status';
    $('refResult').dataset.submitted = '0';
    $('refResult').innerHTML = '<div class="placeholder">生成的图片会显示在这里</div>';
  });

  $('editResetBtn').addEventListener('click', () => {
    $('editPrompt').value = '';
    $('editShrinkUploads').checked = true;
    $('editSize').value = '1024x1024';
    setTaskCount('editCount', DEFAULT_IMAGE_COUNT);
    $('editSizeCustom').value = '';
    $('editSizeCustom').style.display = 'none';
    resetUploadBox('editImage', 'editImageBox', 'editImageLabel', 'editImagePreview', '点击 / 拖拽 / Ctrl+V 粘贴原图', 'editImageMeta');
    resetUploadBox('editMask', 'editMaskBox', 'editMaskLabel', 'editMaskPreview', '点击 / 拖拽上传蒙版', 'editMaskMeta');
    maskFileFromEditor = null;
    updateMaskSourceHint();
    $('editStatus').textContent = '';
    $('editStatus').className = 'status';
    $('editResult').dataset.submitted = '0';
    $('editResult').innerHTML = '<div class="placeholder">编辑后的图片会显示在这里</div>';
  });
})();
