const { app, BrowserWindow, ipcMain, shell, Tray, Menu, Notification, nativeImage } = require("electron");
const { autoUpdater } = require("electron-updater");
const fs = require("fs/promises");
const fssync = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const https = require("https");
const http = require("http");

const UPDATE_BASE_URL = "https://gestionale.mediaprint.it/ElectronAppUpdate";
const UPDATE_API_URL = `${UPDATE_BASE_URL}/index.php`;
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const START_HIDDEN = process.argv.includes("--hidden");

let mainWindow = null;
let tray = null;
let isQuitting = false;
let updateTimer = null;
let lastNotifiedFingerprint = null;
let lastRemoteState = null;
let selfUpdaterFeedUrl = null;
let selfUpdaterEventsBound = false;
let selfUpdaterCheckPromise = null;
let selfUpdaterPendingInstall = false;
let selfUpdaterLastNotifiedVersion = null;

// Riduce il rumore dei log Chromium/DevTools in console.
app.commandLine.appendSwitch("log-level", "3");
app.commandLine.appendSwitch(
  "disable-features",
  "AutofillServerCommunication,AutofillEnableAccountWalletStorage"
);

function createWindow() {
  if (mainWindow) return mainWindow;

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    show: !START_HIDDEN,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  return mainWindow;
}

function showMainWindow() {
  const win = createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function resolveTrayIcon() {
  const candidates = [
    path.join(process.resourcesPath || "", "icon.ico"),
    path.join(__dirname, "build", "icon.ico"),
    path.join(__dirname, "renderer", "icon.ico"),
    path.join(__dirname, "renderer", "icon.png"),
    process.execPath
  ];

  for (const filePath of candidates) {
    if (!filePath) continue;
    try {
      if (!fssync.existsSync(filePath)) continue;
      const icon = nativeImage.createFromPath(filePath);
      if (!icon.isEmpty()) return icon;
    } catch {
      // Continue with the next candidate.
    }
  }

  return nativeImage.createEmpty();
}

function createTray() {
  if (tray) return;

  tray = new Tray(resolveTrayIcon());
  tray.setToolTip("Mediaprint Console Updater");
  tray.on("click", showMainWindow);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Apri", click: showMainWindow },
      {
        label: "Esci",
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );
}

function notifyDesktop(title, body) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body });
  notification.on("click", showMainWindow);
  notification.show();
}

function compareVersions(a, b) {
  const sanitize = (v) =>
    String(v || "")
      .replace(/^[^\d]*/, "")
      .split("-")[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);

  const va = sanitize(a);
  const vb = sanitize(b);
  const max = Math.max(va.length, vb.length);
  for (let i = 0; i < max; i++) {
    const na = va[i] || 0;
    const nb = vb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function runPowerShell(command) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      { windowsHide: true, maxBuffer: 1024 * 1024 * 4 },
      (error, stdout, stderr) => {
        if (error) {
          return reject(new Error(stderr || error.message));
        }
        resolve(stdout.trim());
      }
    );
  });
}

function requestText(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https://") ? https : http;
    lib
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirected = new URL(res.headers.location, url).toString();
          res.resume();
          requestText(redirected).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} su ${url}`));
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      })
      .on("error", reject);
  });
}

async function requestJson(url) {
  const body = await requestText(url);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Risposta API non valida: ${url}`);
  }
}

function fileNameFromUrl(url) {
  const pathname = new URL(url).pathname;
  const base = path.basename(pathname);
  return base || "installer.exe";
}

function sanitizeHttpUrl(inputUrl) {
  const u = new URL(inputUrl);
  const safePath = u.pathname
    .split("/")
    .map((segment) => {
      if (!segment) return "";
      try {
        return encodeURIComponent(decodeURIComponent(segment));
      } catch {
        return encodeURIComponent(segment);
      }
    })
    .join("/");
  u.pathname = safePath;
  return u.toString();
}

function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    const safeUrl = sanitizeHttpUrl(url);
    const lib = safeUrl.startsWith("https://") ? https : http;
    lib
      .get(safeUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirected = new URL(res.headers.location, safeUrl).toString();
          res.resume();
          downloadFile(redirected, outputPath).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Download fallito: HTTP ${res.statusCode}`));
          return;
        }
        const fileStream = fssync.createWriteStream(outputPath);
        res.pipe(fileStream);
        fileStream.on("finish", () => {
          fileStream.close(() => resolve(outputPath));
        });
        fileStream.on("error", (err) => reject(err));
      })
      .on("error", reject);
  });
}

function buildAbsoluteUrl(relativeOrAbsolute, baseUrl = UPDATE_BASE_URL) {
  if (!relativeOrAbsolute) return null;
  if (/^https?:\/\//i.test(relativeOrAbsolute)) return relativeOrAbsolute;
  return new URL(relativeOrAbsolute.replace(/^\/+/, ""), `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenizeMeaningful(value) {
  const stop = new Set([
    "setup",
    "installer",
    "install",
    "update",
    "updater",
    "x64",
    "x86",
    "exe"
  ]);

  return normalizeText(value)
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !stop.has(t));
}

function buildNameCandidates(folderName, latest, installerUrl) {
  const candidates = [];
  const add = (value) => {
    const v = String(value || "").trim();
    if (!v) return;

    candidates.push(v);

    const noExt = v.replace(/\.exe$/i, "").trim();
    if (noExt && noExt !== v) candidates.push(noExt);

    const noVersionTail = noExt
      .replace(/\s+v?\d+(?:[._-]\d+){1,4}\s*$/i, "")
      .replace(/\s+\d{1,4}\s*$/i, "")
      .trim();
    if (noVersionTail && noVersionTail !== noExt) candidates.push(noVersionTail);

    const alphaOnly = noVersionTail.replace(/\s*\d+(?:[._-]\d+)*\s*/g, " ").replace(/\s+/g, " ").trim();
    if (alphaOnly && alphaOnly !== noVersionTail) candidates.push(alphaOnly);
  };

  add(latest?.appName);
  add(latest?.productName);
  add(latest?.name);
  add(folderName);
  add(latest?.path);
  add(latest?.url);
  add(installerUrl ? fileNameFromUrl(installerUrl) : null);

  const uniq = new Map();
  for (const raw of candidates) {
    const noExt = raw.replace(/\.exe$/i, "").trim();
    const norm = normalizeText(noExt);
    if (!norm || norm.length < 3) continue;
    if (!uniq.has(norm)) uniq.set(norm, noExt);
  }
  return Array.from(uniq.values());
}

function isSelfUpdateChannel(folderName, latest = {}) {
  const haystack = normalizeText(
    [folderName, latest.appName, latest.productName, latest.name, latest.path, latest.url].filter(Boolean).join(" ")
  );
  if (!haystack) return false;

  return (
    haystack.includes("console") ||
    haystack.includes("updater") ||
    haystack.includes("consolemp") ||
    haystack.includes("mediaprint electron updater")
  );
}

function resolveSelfChannel(remoteState) {
  const channels = remoteState?.channels;
  if (!Array.isArray(channels)) return null;
  return channels.find((c) => c?.selfUpdate) || null;
}

function bindSelfUpdaterEvents() {
  if (selfUpdaterEventsBound) return;
  selfUpdaterEventsBound = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => {
    const nextVersion = info?.version || null;
    if (nextVersion && nextVersion !== selfUpdaterLastNotifiedVersion) {
      selfUpdaterLastNotifiedVersion = nextVersion;
      notifyDesktop("Aggiornamento Console disponibile", `Versione ${nextVersion} pronta al download.`);
    }
  });

  autoUpdater.on("update-downloaded", (info) => {
    const nextVersion = info?.version || "nuova versione";
    if (selfUpdaterPendingInstall) {
      isQuitting = true;
      setTimeout(() => autoUpdater.quitAndInstall(false, true), 300);
      return;
    }
    notifyDesktop("Aggiornamento Console scaricato", `${nextVersion} pronta per l'installazione.`);
  });

  autoUpdater.on("error", (error) => {
    const message = String(error?.message || "").trim();
    if (!message) return;
    notifyDesktop("Errore aggiornamento Console", message.slice(0, 220));
  });
}

async function ensureSelfUpdaterConfigured(remoteState = null) {
  if (!app.isPackaged) return null;

  bindSelfUpdaterEvents();
  const source = remoteState || lastRemoteState || (await fetchRemoteState());
  const selfChannel = resolveSelfChannel(source);
  const feedUrl = String(selfChannel?.folderUrl || "").replace(/\/+$/, "");
  if (!feedUrl) {
    throw new Error("Canale aggiornamento Console non trovato.");
  }

  if (feedUrl !== selfUpdaterFeedUrl) {
    autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
    selfUpdaterFeedUrl = feedUrl;
  }

  return feedUrl;
}

async function checkSelfAppUpdateWithElectronUpdater(options = {}) {
  const { download = false, install = false, remoteState = null } = options;

  if (!app.isPackaged) {
    return { ok: false, skipped: true, reason: "dev-mode" };
  }

  await ensureSelfUpdaterConfigured(remoteState);
  if (selfUpdaterCheckPromise) return selfUpdaterCheckPromise;

  selfUpdaterCheckPromise = (async () => {
    try {
      selfUpdaterPendingInstall = Boolean(install);
      const result = await autoUpdater.checkForUpdates();
      if (!result) {
        selfUpdaterPendingInstall = false;
        return { ok: true, updateAvailable: false };
      }

      if (!download) {
        selfUpdaterPendingInstall = false;
        return {
          ok: true,
          updateAvailable: true,
          downloaded: false,
          version: result.updateInfo?.version || null
        };
      }

      await autoUpdater.downloadUpdate();
      return {
        ok: true,
        updateAvailable: true,
        downloaded: true,
        installing: Boolean(install),
        version: result.updateInfo?.version || null
      };
    } finally {
      if (!install) selfUpdaterPendingInstall = false;
      selfUpdaterCheckPromise = null;
    }
  })();

  return selfUpdaterCheckPromise;
}

let installedAppsCachePromise = null;

async function getInstalledApps() {
  if (installedAppsCachePromise) return installedAppsCachePromise;
  installedAppsCachePromise = (async () => {
    const ps = `
$paths = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$items = Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName } |
  Select-Object DisplayName, DisplayVersion, Publisher, InstallLocation, UninstallString, DisplayIcon
if ($items) { $items | ConvertTo-Json -Compress } else { '[]' }
`;
    const raw = await runPowerShell(ps);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  })();

  try {
    return await installedAppsCachePromise;
  } catch (error) {
    installedAppsCachePromise = null;
    throw error;
  }
}

function scoreInstalledMatch(item, candidates) {
  const displayNameNorm = normalizeText(item?.DisplayName);
  if (!displayNameNorm) return { score: 0, matchedBy: null };
  const displayTokens = tokenizeMeaningful(item?.DisplayName);

  const uninstallNorm = normalizeText(item?.UninstallString);
  const iconNorm = normalizeText(item?.DisplayIcon);
  const extendedHaystack = `${displayNameNorm} ${uninstallNorm} ${iconNorm}`;

  let bestScore = 0;
  let matchedBy = null;

  for (const candidate of candidates) {
    const candNorm = normalizeText(candidate);
    if (!candNorm || candNorm.length < 3) continue;
    const candTokens = tokenizeMeaningful(candidate);

    let score = 0;
    if (displayNameNorm === candNorm) score = 220;
    else if (displayNameNorm.startsWith(candNorm) && candNorm.length >= 6) score = 170;
    else if (displayNameNorm.includes(candNorm) && candNorm.length >= 6) score = 135;
    else if (candNorm.includes(displayNameNorm) && displayNameNorm.length >= 6) score = 110;
    else {
      const matchedTokens = candTokens.filter((t) => displayNameNorm.includes(t));
      if (candTokens.length && matchedTokens.length) {
        score = Math.floor((matchedTokens.length / candTokens.length) * 90);
      }
    }

    if (candTokens.length && displayTokens.length) {
      const matched = candTokens.filter((t) => displayTokens.includes(t));
      if (matched.length === candTokens.length && candTokens.length >= 2) {
        score = Math.max(score, 175);
      } else if (matched.length >= 2) {
        score = Math.max(score, 120);
      }
    }

    if (score < 100 && extendedHaystack.includes(candNorm) && candNorm.length >= 6) {
      score = Math.max(score, 100);
    }

    if (score > bestScore) {
      bestScore = score;
      matchedBy = candidate;
    }
  }

  return { score: bestScore, matchedBy };
}

async function readChannelFromApiFolder(folder) {
  const folderName = folder.name || folder.folderName || "SenzaNome";
  const folderUrl = folder.folderUrl || buildAbsoluteUrl(folderName, UPDATE_BASE_URL);
  const indexUrl = folder.indexUrl || `${folderUrl}/index.html`;
  const latest = folder.latest || {};
  const appName = latest.appName || latest.productName || null;
  const version = latest.version || null;
  const releaseDate = latest.releaseDate || null;
  const installerUrl =
    buildAbsoluteUrl(folder.installerUrl, folderUrl) ||
    buildAbsoluteUrl(latest.path || latest.url || null, folderUrl);
  const installerExists = Boolean(installerUrl);
  const selfUpdate = isSelfUpdateChannel(folderName, latest);

  const nameCandidates = buildNameCandidates(folderName, latest, installerUrl);
  if (appName && !nameCandidates.includes(appName)) {
    nameCandidates.unshift(appName);
  }

  const installed = await detectInstalledVersion(nameCandidates);
  const installedVersion = installed?.DisplayVersion || (selfUpdate ? app.getVersion() : null);
  const comparison = installedVersion && version ? compareVersions(installedVersion, version) : null;

  return {
    folderName,
    folderUrl,
    indexUrl,
    latest: {
      version,
      releaseDate,
      appName,
      installerPath: installerUrl,
      installerExists
    },
    installed: installed
      ? {
          displayName: installed.DisplayName || null,
          version: installed.DisplayVersion || null,
          publisher: installed.Publisher || null,
          installLocation: installed.InstallLocation || null
        }
      : selfUpdate
      ? {
          displayName: app.getName() || "Console",
          version: app.getVersion() || null,
          publisher: null,
          installLocation: null
        }
      : null,
    selfUpdate,
    comparison
  };
}

async function detectInstalledVersion(appName) {
  const candidates = Array.isArray(appName) ? appName : [appName];
  const filtered = candidates.filter((c) => String(c || "").trim().length > 0);
  if (!filtered.length) return null;

  try {
    const installedApps = await getInstalledApps();
    let best = null;
    let bestScore = 0;
    let bestMatchedBy = null;

    for (const item of installedApps) {
      const { score, matchedBy } = scoreInstalledMatch(item, filtered);
      if (score > bestScore) {
        best = item;
        bestScore = score;
        bestMatchedBy = matchedBy;
      }
    }

    if (!best || bestScore < 100) return null;
    return { ...best, _matchedBy: bestMatchedBy, _matchScore: bestScore };
  } catch {
    return null;
  }
}

async function fetchRemoteState() {
  installedAppsCachePromise = null;
  const apiPayload = await requestJson(UPDATE_API_URL);
  const apiFolders = Array.isArray(apiPayload?.folders) ? apiPayload.folders : [];
  const channels = await Promise.all(apiFolders.map((folder) => readChannelFromApiFolder(folder)));

  const selected =
    channels.find((c) => typeof c.comparison === "number" && c.comparison < 0 && !c.error) ||
    channels.find((c) => c.installed?.version && !c.error) ||
    channels.find((c) => !c.error) ||
    channels[0] ||
    null;

  const state = {
    updateBaseUrl: UPDATE_BASE_URL,
    updateApiUrl: UPDATE_API_URL,
    channels,
    selectedFolder: selected?.folderName || null
  };
  lastRemoteState = state;
  return state;
}

function buildUpdatesFingerprint(channels) {
  return channels
    .filter((c) => typeof c.comparison === "number" && c.comparison < 0 && !c.error)
    .map((c) => `${c.folderName || ""}:${c.latest?.version || ""}`)
    .sort()
    .join("|");
}

function notifyAvailableUpdates(channels) {
  const updates = channels.filter((c) => typeof c.comparison === "number" && c.comparison < 0 && !c.error);
  if (!updates.length) return;

  const bodyLines = updates.slice(0, 4).map((c) => `${c.folderName}: ${c.latest?.version || "-"}`);
  if (updates.length > 4) {
    bodyLines.push(`+${updates.length - 4} altri canali`);
  }

  notifyDesktop(`Aggiornamenti disponibili (${updates.length})`, bodyLines.join("\n"));
}

async function checkForUpdatesAndNotify() {
  try {
    const remote = await fetchRemoteState();
    const fingerprint = buildUpdatesFingerprint(remote.channels || []);
    if (!fingerprint) {
      lastNotifiedFingerprint = null;
    } else if (fingerprint !== lastNotifiedFingerprint) {
      lastNotifiedFingerprint = fingerprint;
      notifyAvailableUpdates(remote.channels || []);
    }

    // Check self-update availability with electron-updater every interval.
    await checkSelfAppUpdateWithElectronUpdater({ download: false, install: false, remoteState: remote });
  } catch {
    // Silent: periodic checks must not interrupt app usage.
  }
}

function startPeriodicUpdateChecks() {
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = setInterval(checkForUpdatesAndNotify, UPDATE_CHECK_INTERVAL_MS);
}

ipcMain.handle("updater:read-remote", async () => {
  return fetchRemoteState();
});

ipcMain.handle("updater:run-installer", async (_event, installerPath, options = {}) => {
  if (options?.selfUpdate) {
    const viaUpdater = await checkSelfAppUpdateWithElectronUpdater({ download: true, install: true });
    if (viaUpdater?.ok) {
      return {
        ok: true,
        selfUpdatedWithElectronUpdater: true,
        message: viaUpdater.updateAvailable
          ? "Aggiornamento Console in installazione."
          : "Console gia aggiornata."
      };
    }
  }

  if (!installerPath) {
    throw new Error("Installer non specificato.");
  }

  const installerUrl = buildAbsoluteUrl(installerPath);
  if (!installerUrl) throw new Error("URL installer non valido.");

  const tempDir = path.join(app.getPath("temp"), "mediaprint-updater");
  await fs.mkdir(tempDir, { recursive: true });
  const localInstallerPath = path.join(tempDir, fileNameFromUrl(installerUrl));
  await downloadFile(installerUrl, localInstallerPath);

  const child = spawn(localInstallerPath, [], {
    detached: true,
    stdio: "ignore",
    shell: true
  });
  child.unref();

  if (options?.selfUpdate) {
    setTimeout(() => app.quit(), 800);
  }

  return { ok: true, downloadedTo: localInstallerPath };
});

ipcMain.handle("updater:open-network-folder", async (_event, targetUrl) => {
  await shell.openExternal(targetUrl || UPDATE_BASE_URL);
  return { ok: true };
});

app.whenReady().then(() => {
  app.setAppUserModelId("it.mediaprint.console");
  createWindow();
  createTray();
  startPeriodicUpdateChecks();
  setTimeout(checkForUpdatesAndNotify, 15000);

  app.on("activate", () => {
    showMainWindow();
  });
});

app.on("window-all-closed", () => {
  // Keep app alive in tray on Windows/macOS after closing windows.
});

app.on("before-quit", () => {
  isQuitting = true;
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
});
