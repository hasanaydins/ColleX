// Reads X/Twitter auth cookies from the user's local Chrome profile so we can
// skip the in-app login window when they're already logged in.
//
// macOS-only for now. Linux/Windows use different secret stores (DBus Secret
// Service / DPAPI) — we'll add those later if there's demand.
//
// Returns null on any failure: Chrome not installed, not logged in, keychain
// access denied, or unexpected DB shape. Callers fall back to the manual
// login window in all failure cases.

const { execFileSync } = require("child_process");
const { copyFileSync, unlinkSync } = require("fs");
const { join } = require("path");
const { tmpdir, homedir } = require("os");
const { pbkdf2Sync, createDecipheriv, randomUUID } = require("crypto");

function getChromeKey() {
  // Chrome's Safe Storage keychain entry name differs across installs / locales.
  const candidates = [
    ["Chrome Safe Storage", "Chrome"],
    ["Chrome Safe Storage", "Google Chrome"],
    ["Google Chrome Safe Storage", "Chrome"],
    ["Google Chrome Safe Storage", "Google Chrome"],
  ];
  for (const [service, account] of candidates) {
    try {
      const pw = execFileSync(
        "security",
        ["find-generic-password", "-w", "-s", service, "-a", account],
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
      if (pw) return pbkdf2Sync(pw, "saltysalt", 1003, 16, "sha1");
    } catch {}
  }
  return null;
}

function tryExtractChromeCookies() {
  if (process.platform !== "darwin") return null;

  const key = getChromeKey();
  if (!key) return null;

  const dbPath = join(homedir(), "Library/Application Support/Google/Chrome/Default/Cookies");
  const tmp = join(tmpdir(), `collex-cookies-${randomUUID()}.db`);

  try {
    copyFileSync(dbPath, tmp);

    let dbVersion = 0;
    try {
      dbVersion = parseInt(
        execFileSync("sqlite3", [tmp, "SELECT value FROM meta WHERE key='version';"], {
          encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        }).trim()
      ) || 0;
    } catch {}

    const sql = `SELECT name, hex(encrypted_value) as h, value FROM cookies WHERE host_key LIKE '%.x.com' AND name IN ('ct0','auth_token');`;
    const raw = JSON.parse(
      execFileSync("sqlite3", ["-json", tmp, sql], { encoding: "utf8" }).trim() || "[]"
    );

    const dec = new Map();
    for (const r of raw) {
      if (r.h && r.h.length > 0) {
        const buf = Buffer.from(r.h, "hex");
        // v10 prefix = AES-128-CBC with static IV
        if (buf[0] === 0x76 && buf[1] === 0x31 && buf[2] === 0x30) {
          const iv = Buffer.alloc(16, 0x20);
          const decipher = createDecipheriv("aes-128-cbc", key, iv);
          let p = decipher.update(buf.subarray(3));
          p = Buffer.concat([p, decipher.final()]);
          // Chrome v24+ prepends a 32-byte SHA256 of host_key
          if (dbVersion >= 24 && p.length > 32) p = p.subarray(32);
          dec.set(r.name, p.toString("utf8").replace(/\0+$/g, "").trim());
        }
      } else if (r.value) {
        dec.set(r.name, r.value);
      }
    }

    const ct0 = dec.get("ct0");
    const authToken = dec.get("auth_token");
    if (!ct0 || !authToken) return null;

    return { ct0, authToken };
  } catch {
    return null;
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

module.exports = { tryExtractChromeCookies };
