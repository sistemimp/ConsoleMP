# Mediaprint Electron Updater

App Electron per:

- leggere l'API `https://gestionale.mediaprint.it/ElectronAppUpdate/index.php`
- ottenere dall'API l'elenco sottocartelle (es. `RiBA`, `OPS`, `BackupSync`, ...)
- ottenere dall'API i dati estratti da `latest.yml` di ogni sottocartella
- rilevare la versione installata sul PC (registro uninstall di Windows)
- confrontare versione installata vs ultima disponibile per la sottocartella selezionata
- scaricare e avviare installer remoto per installazione/aggiornamento

## Avvio

```powershell
npm install
npm start
```

## Distribuzione

Comandi disponibili:

```powershell
npm run dist
```

Genera installer Windows NSIS in `dist/`.

```powershell
npm run dist:portable
```

Genera eseguibile portable in `dist/`.

```powershell
npm run dist:dir
```

Genera cartella unpacked (senza installer) in `dist/win-unpacked/`.

## Note

- Il file `index.php` incluso in questo progetto e da pubblicare nella root `ElectronAppUpdate`.
- L'app usa `latest.appName` (derivato da `productName` di `latest.yml`) per cercare l'app installata nel registro.
- L'installer usa `installerUrl` fornito dall'API; fallback su `latest.path` o `latest.url`.
- Al click su installa/aggiorna, l'installer viene scaricato in `%TEMP%\\mediaprint-updater` e avviato.
- Per l'aggiornamento della Console tramite `electron-updater`, il canale Console deve esporre nella sua cartella il file `latest.yml` e gli artefatti generati da `electron-builder`.

## Formato API (JSON)

```json
{
  "ok": true,
  "generatedAt": "2026-02-23T10:00:00Z",
  "baseUrl": "https://gestionale.mediaprint.it/ElectronAppUpdate",
  "folders": [
    {
      "name": "RiBA",
      "folderUrl": "https://gestionale.mediaprint.it/ElectronAppUpdate/RiBA",
      "indexUrl": "https://gestionale.mediaprint.it/ElectronAppUpdate/RiBA/index.html",
      "installerUrl": "https://gestionale.mediaprint.it/ElectronAppUpdate/RiBA/Setup.exe",
      "latest": {
        "version": "2026.2.20.0",
        "releaseDate": "2026-02-20T10:00:00.000Z",
        "appName": "Generatore Ri.Ba. CBI Setup",
        "path": "Generatore Ri.Ba. CBI Setup 2026.2.20.0.exe",
        "url": null
      }
    }
  ]
}
```
