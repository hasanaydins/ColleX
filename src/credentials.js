const fs = require("fs");
const path = require("path");

const FILENAME = "credentials.json";

function credentialsPath(dataDir) {
  return path.join(dataDir, FILENAME);
}

function loadCredentials(dataDir) {
  try {
    const raw = fs.readFileSync(credentialsPath(dataDir), "utf8");
    const creds = JSON.parse(raw);
    if (creds.bearerToken && creds.ct0 && creds.authToken && creds.queryId) {
      return creds;
    }
    return null;
  } catch {
    return null;
  }
}

function saveCredentials(dataDir, creds) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(credentialsPath(dataDir), JSON.stringify(creds, null, 2), "utf8");
}

function clearCredentials(dataDir) {
  try { fs.unlinkSync(credentialsPath(dataDir)); } catch {}
}

module.exports = { loadCredentials, saveCredentials, clearCredentials };
