// --- Sync (Electron only) ---

export const startSync = (btn) => {
  btn.disabled = true;
  btn.querySelector("span").textContent = "Syncing…";

  const es = new EventSource("/sync");

  es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.type === "limit") {
      btn.querySelector("span").textContent = `Next sync in ${d.hoursLeft}h`;
      btn.disabled = true;
      btn.title = `Daily limit reached. Try again in ${d.hoursLeft} hour(s).`;
      es.close();
    } else if (d.type === "progress") {
      btn.querySelector("span").textContent = `${d.count} fetched…`;
    } else if (d.type === "done") {
      btn.querySelector("span").textContent = `✓ ${d.total} bookmarks`;
      es.close();
      setTimeout(() => location.reload(), 1200);
    } else if (d.type === "error") {
      btn.querySelector("span").textContent = "Sync failed";
      btn.title = d.message;
      btn.disabled = false;
      es.close();
      if (d.message.includes("re-login") || d.message.includes("Authentication")) {
        window.electronAPI?.reLogin();
      }
    }
  };

  es.onerror = () => {
    btn.querySelector("span").textContent = "Sync error";
    btn.disabled = false;
    es.close();
  };
};
