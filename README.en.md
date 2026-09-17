# Kyrios Chronos — Κύριος Χρόνος

![Platform](https://img.shields.io/badge/platform-Windows-blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Electron](https://img.shields.io/badge/Electron-28-47848F) ![Node](https://img.shields.io/badge/node-%E2%89%A516-brightgreen)

[🇧🇷 Português](README.md) | **English**

> A modern task scheduler with cron support, a Windows service manager, and database backups.

**Kyrios Chronos** is a Windows desktop app (Electron) that brings three operational needs together in a single interface:

1. **Scheduled tasks** (PowerShell scripts, executables, batch files) via cron expressions;
2. **Windows service management** via [NSSM](https://nssm.cc/) — install, start, stop, edit parameters, and rename services;
3. **Scheduled database backups** (MySQL/MariaDB and SQL Server) with compression and upload to FTP, SFTP, or SMB shares.

## ✨ Features

### 🗓️ Scheduled tasks
- Cron expressions with validation, human-friendly descriptions, and next-run calculation;
- Manual execution, run history, and export (JSON/CSV);
- **Task import/export** as JSON;
- **Schedule conflict warning**: alerts when a new task collides with already-occupied windows and suggests a free time slot;
- Unified **calendar** showing tasks, backups, and services on a single timeline, with an hourly load histogram;
- **Live run monitor**: real-time progress and output of running tasks.

### 🛠️ Windows services (NSSM)
- List of all installed services with status;
- Install/uninstall, start/stop/restart directly from the UI;
- Built-in NSSM installer (winget, chocolatey, scoop, or manual download);
- Service parameter editing (executable, directory, arguments, stdout/stderr logging, log rotation, priority);
- Service renaming preserving all parameters;
- **One-click deployment of tasks and backups as Windows services** — the app generates a PowerShell wrapper, registers the service via NSSM, and configures automatic restart on failure.

### 💾 Database backups
- Backup profiles with connection details, database selection, and cron scheduling;
- **MySQL/MariaDB** (via `mysqldump`, with auto-detection in PATH, XAMPP, WampServer, Laragon, and MariaDB, or download of the official tools) and **SQL Server** (native `.bak` or portable `.bacpac`);
- Naming patterns, compression (zip/7z), local retention by days;
- Automatic upload to **FTP, SFTP, or SMB**, with connection testing;
- History and success/failure statistics per profile;
- Profile import/export as JSON.

### 🖥️ Desktop experience
- Dark UI with [Lucide](https://lucide.dev/) icons, frameless native window;
- **System tray** with quick actions (run due tasks, refresh dashboard);
- Start with Windows, start minimized, close to tray;
- Push notifications for task, backup, and service operation success/failure;
- **Bilingual**: English and Brazilian Portuguese (pt-BR).

### 📜 Audit and logs
- Application log, error log, and **audit log** (who created/changed/executed what, and when);
- Logs are read straight from disk — including what the service ran in another session;
- Log export as TXT, CSV, or JSON.

## 🏗️ Architecture

Kyrios Chronos can run in two modes — or both at once:

| Mode | Description |
|------|-------------|
| **GUI** | The Electron app with window, tray, and notifications |
| **Service** | The headless scheduler (`KyriosChronos`) running in session 0 via `ELECTRON_RUN_AS_NODE`, independent of any logged-in user |

To prevent a task from running **twice** while the window is open and the service is running, both processes arbitrate execution through a **heartbeat file** (`scheduler-owner.json`):

- The owner rewrites the file on every tick (15 s);
- A claimant may take over when the file is missing, stale, or its PID is dead;
- The service **always outranks the GUI**: once installed, the GUI goes passive (view-only) and never takes execution back while the service is alive.

### Shared data

Everything lives in `%ProgramData%\KyriosChronos` (configurable via `KYRION_DATA_DIR`) — not `%APPDATA%` — because the GUI runs as the logged-in user while the service runs as `LocalSystem`: two accounts with different `%APPDATA%` folders, but `%ProgramData%` is shared by both.

```
%ProgramData%\KyriosChronos\
├── config\            # tasks.json, backup-profiles.json, history, scheduler owner
└── logs\              # app.log, errors, audit
```

### Web interface + REST API

The process that owns execution also serves a **web interface** (Express, default port `7600`) to administer the system from a browser, featuring:

- **GitHub sign-in** (OAuth device flow — no secret is embedded in the app);
- **Deny-by-default allowlist**: nobody gets in until an administrator adds a login in the desktop app;
- Every operation through the web is attributed to the authenticated GitHub account in the audit log;
- System metrics and real-time updates via SSE.

## 🚀 Getting started

### Prerequisites
- **Node.js ≥ 16**
- **Windows** (NSSM, services, and the scheduler are Windows-specific)
- NSSM is optional — the app can install it for you

### Development

```bash
# clone and install dependencies
git clone https://github.com/l1nds0n/kyrios-chronos.git
cd kyrios-chronos
npm install

# run the app
npm start
```

### Tests

```bash
npm test
```

The suite uses **Mocha + Chai** (`tests/*.js`, 60 s timeout) and covers the cron parser, calendar data, run registry, app icon, log screens, and more. Use `KYRION_DATA_DIR` to point the tests at a temporary data directory.

### Production build

```bash
# NSIS installer + portable (electron-builder)
npm run build

# portable only via electron-packager
npm run build:portable

# full script (requires NSIS 3.x: choco install nsis)
.\Build-Installer.ps1              # both
.\Build-Installer.ps1 -Portable    # portable only
.\Build-Installer.ps1 -Installer   # installer only
```

Artifacts are generated in `dist/`:
- `KyriosChronos Setup <version>.exe` — NSIS installer (desktop and start menu shortcuts, directory selection);
- `KyriosChronos-<version>-portable.exe` — portable version, no installation required.

## 📁 Project structure

```
kyrios-chronos/
├── src/
│   ├── main/              # Electron main process
│   │   ├── main.js        # Window, tray, IPC, notifications
│   │   ├── schedulerCore.js    # Shared scheduler engine (GUI + service)
│   │   ├── taskManager.js      # Task CRUD, execution, and history
│   │   ├── backupManager.js    # Backup profiles and execution
│   │   ├── serviceManager.js   # NSSM operations
│   │   ├── kyrionService.js    # KyriosChronos headless service
│   │   ├── apiServer.js        # Web interface + REST API
│   │   ├── webAuth.js          # GitHub sign-in (device flow) and allowlist
│   │   ├── db/                 # Backup engine registry (mysql, sqlserver)
│   │   └── ...
│   ├── renderer/          # Desktop UI (HTML/CSS/JS, i18n)
│   └── web/               # Web interface served by the API
├── tests/                 # Mocha + Chai suite
├── scripts/               # Packaging (portable)
├── installer/             # NSIS scripts
└── build-resources/       # Icons and visual assets
```

## 🔌 REST API

When enabled in the settings (disabled by default), the web interface/API exposes endpoints to manage tasks, services, backups, history, and logs at `http://localhost:7600`. Public endpoints before sign-in: `/login`, `/api/health`.

## 🔒 Security notes

- The GitHub OAuth **secret is not embedded** in the app: the *device flow* is used instead, designed for clients that cannot keep secrets (an `.asar` is just an archive, not a vault);
- Web access is **denied by default** until an administrator adds logins to the allowlist;
- Web sessions: signed `HttpOnly` cookie with a 12 h TTL;
- Database and upload credentials live in the profiles under `%ProgramData%` — protect that directory accordingly.

## 📄 License

[MIT](LICENSE) © l1nds0n
