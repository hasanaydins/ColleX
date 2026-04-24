let _gridEl = null;

export const setGridEl = (el) => { _gridEl = el; };

let _loadingCount = 0;
const MAX_CONCURRENT_VIDEO_LOADS = 3;
const _videoLoadQueue = [];

export const processVideoQueue = () => {
  while (_videoLoadQueue.length > 0 && _loadingCount < MAX_CONCURRENT_VIDEO_LOADS) {
    const v = _videoLoadQueue.shift();
    if (!v.isConnected) continue;
    _loadingCount++;
    v.src = v.dataset.src;
    const onLoad = () => { _loadingCount--; processVideoQueue(); };
    v.addEventListener("playing", onLoad, { once: true });
    v.addEventListener("error", onLoad, { once: true });
    v.addEventListener("suspend", onLoad, { once: true });
    v.play().catch(() => {});
  }
};

export const enqueueVideo = (v) => {
  _videoLoadQueue.push(v);
  processVideoQueue();
};

export const incrementLoadingCount = () => { _loadingCount++; };
export const decrementLoadingCount = () => { _loadingCount--; processVideoQueue(); };

export const pauseAllGridVideos = () => {
  const videos = _gridEl?.querySelectorAll("video.card-video") || [];
  for (const v of videos) {
    try { v.pause(); } catch {}
  }
};

export const resumeVisibleGridVideos = () => {
  const videos = _gridEl?.querySelectorAll("video.card-video") || [];
  for (const v of videos) {
    if (!v.src && v.dataset.src) {
      const rect = v.getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < window.innerHeight) {
        _videoLoadQueue.push(v);
      }
    } else if (v.src) {
      const rect = v.getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < window.innerHeight) {
        v.play().catch(() => {});
      }
    }
  }
  processVideoQueue();
};
