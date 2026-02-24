const statusTextEl = document.getElementById("statusText");
const appsListEl = document.getElementById("appsList");
const refreshBtn = document.getElementById("refreshBtn");

function setStatus(message, isError = false) {
  statusTextEl.textContent = message;
  statusTextEl.classList.toggle("error", isError);
}

function comparisonLabel(value) {
  if (value === null || value === undefined) return "Non confrontabile";
  if (value === 0) return "Allineata";
  if (value < 0) return "Aggiornamento disponibile";
  return "Locale piu recente";
}

async function runInstall(channel, buttonEl) {
  const installerPath = channel?.latest?.installerPath;
  if (!installerPath) return;
  const previous = buttonEl.textContent;
  buttonEl.disabled = true;
  buttonEl.textContent = "Avvio...";
  setStatus("Download installer in corso...");
  try {
    const result = await window.updaterApi.runInstaller(installerPath, { selfUpdate: Boolean(channel?.selfUpdate) });
    if (channel?.selfUpdate) {
      setStatus(result?.message || "Aggiornamento Console avviato. L'app verra chiusa automaticamente.");
    } else {
      setStatus("Installer avviato. Segui la procedura sul sistema.");
    }
  } catch (error) {
    setStatus(`Impossibile avviare installer: ${error.message}`, true);
  } finally {
    buttonEl.disabled = false;
    buttonEl.textContent = previous;
  }
}

function buildAppRow(channel) {
  const latest = channel.latest || {};
  const installed = channel.installed || null;
  const appName = latest.appName || installed?.displayName || channel.folderName || "App";
  const availableVersion = latest.version || "-";
  const installedVersion = installed?.version || "Non installata";
  const isAligned = channel.comparison === 0;
  const canRun = Boolean(latest.installerPath && latest.installerExists && !channel.error && !isAligned);

  const row = document.createElement("div");
  row.className = "app-row";

  const info = document.createElement("div");
  info.className = "app-info";
  info.innerHTML = `
    <div class="app-title">${appName}</div>
    <div class="app-meta">Canale: ${channel.folderName || "-"}</div>
    <div class="app-meta">Versione disponibile: <strong>${availableVersion}</strong></div>
    <div class="app-meta">Versione installata: <strong>${installedVersion}</strong></div>
    <div class="app-meta">Stato: <strong>${comparisonLabel(channel.comparison)}</strong></div>
  `;

  const actions = document.createElement("div");
  actions.className = "app-actions";

  const installBtn = document.createElement("button");
  installBtn.className = "install-btn";
  installBtn.textContent = "Installa / Aggiorna";
  installBtn.disabled = !canRun;
  installBtn.addEventListener("click", () => runInstall(channel, installBtn));

  if (channel.error) {
    const err = document.createElement("div");
    err.className = "app-error";
    err.textContent = channel.error;
    actions.appendChild(err);
  }

  actions.appendChild(installBtn);
  row.appendChild(info);
  row.appendChild(actions);
  return row;
}

async function loadData() {
  setStatus("Lettura API aggiornamenti...");
  appsListEl.innerHTML = "";

  try {
    const data = await window.updaterApi.readRemote();
    const channels = Array.isArray(data.channels) ? data.channels : [];
    if (!channels.length) {
      setStatus("Nessuna app disponibile.", true);
      return;
    }

    channels
      .sort((a, b) => String(a.folderName || "").localeCompare(String(b.folderName || "")))
      .forEach((channel) => {
        appsListEl.appendChild(buildAppRow(channel));
      });

    setStatus(`Trovate ${channels.length} app disponibili.`);
  } catch (error) {
    setStatus(`Errore: ${error.message}`, true);
  }
}

refreshBtn.addEventListener("click", loadData);
loadData();
