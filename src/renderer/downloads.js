import { escapeHtml } from './helpers.js';
import { fetchBlobWithProgress, triggerAnchorDownload } from './media.js';

const dlManager = {
  items: new Map(),
  _nextId: 0,
  _barEl: null,
};

export const startDownload = (url, filename, { authorHandle, onProgress, onComplete, onError } = {}) => {
  const id = ++dlManager._nextId;
  const controller = new AbortController();

  const item = {
    id,
    url,
    filename,
    authorHandle: authorHandle || '',
    pct: 0,
    status: 'downloading',
    controller,
  };
  dlManager.items.set(id, item);
  renderBar();

  fetchBlobWithProgress(url, (pct) => {
    item.pct = pct;
    renderBar();
    if (onProgress) onProgress(pct);
  }, { signal: controller.signal })
    .then((blob) => {
      item.status = 'complete';
      item.pct = 100;
      renderBar();

      const blobUrl = URL.createObjectURL(blob);
      triggerAnchorDownload(blobUrl, filename);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

      if (onComplete) onComplete();

      setTimeout(() => {
        dlManager.items.delete(id);
        renderBar();
      }, 4000);
    })
    .catch((err) => {
      if (err.name === 'AbortError' && item.controller.signal.aborted) {
        item.status = 'cancelled';
      } else {
        item.status = 'error';
        console.error('Download failed:', err);
      }
      item.pct = 0;
      renderBar();
      if (onError) onError(err);

      setTimeout(() => {
        dlManager.items.delete(id);
        renderBar();
      }, 2500);
    });

  return id;
};

export const cancelDownload = (id) => {
  const item = dlManager.items.get(id);
  if (item && item.status === 'downloading') {
    item.controller.abort();
  }
};

const renderBar = () => {
  const items = [...dlManager.items.values()];

  if (items.length === 0) {
    if (dlManager._barEl) dlManager._barEl.classList.remove('visible');
    return;
  }

  ensureBar();

  const activeCount = items.filter(i => i.status === 'downloading').length;

  dlManager._barEl.innerHTML = `
    <div class="dl-bar-header">
      <span class="dl-bar-title">Downloads</span>
      ${activeCount > 0 ? `<span class="dl-bar-count">${activeCount}</span>` : ''}
    </div>
    <div class="dl-bar-list">
      ${items.map(item => {
        const downloading = item.status === 'downloading';
        const complete = item.status === 'complete';
        const error = item.status === 'error';
        const cancelled = item.status === 'cancelled';

        let pctDisplay = '';
        let statusClass = '';
        if (complete) { pctDisplay = '✓'; statusClass = 'dl-bar-item--complete'; }
        else if (error) { pctDisplay = '✗'; statusClass = 'dl-bar-item--error'; }
        else if (cancelled) { pctDisplay = '⊘'; statusClass = 'dl-bar-item--cancelled'; }
        else if (item.pct < 0) { pctDisplay = '…'; }
        else { pctDisplay = `${item.pct}%`; }

        return `
          <div class="dl-bar-item ${statusClass}">
            <div class="dl-bar-item-info">
              <span class="dl-bar-item-name">${escapeHtml(item.filename)}</span>
              ${item.authorHandle ? `<span class="dl-bar-item-handle">@${escapeHtml(item.authorHandle)}</span>` : ''}
            </div>
            <div class="dl-bar-item-progress-wrap">
              <div class="dl-bar-item-track">
                <div class="dl-bar-item-fill" style="width:${complete ? 100 : Math.max(0, item.pct)}%"></div>
              </div>
              <span class="dl-bar-item-pct">${pctDisplay}</span>
            </div>
            ${downloading ? `<button class="dl-bar-item-cancel" data-dl-id="${item.id}" title="Cancel">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>` : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;

  dlManager._barEl.classList.add('visible');

  dlManager._barEl.querySelectorAll('.dl-bar-item-cancel').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      cancelDownload(Number(btn.dataset.dlId));
    };
  });
};

const ensureBar = () => {
  if (dlManager._barEl) return;
  dlManager._barEl = document.createElement('div');
  dlManager._barEl.className = 'dl-bar';
  document.body.appendChild(dlManager._barEl);
};
