# Changelog

All notable changes to Kyrios Chronos.

## 1.0.9 - 2026-10-02

### Added

- feat(build): halve the app.asar by dropping what the runtime never loads (`464f10c`) — l1nds0n

**Changes since v1.0.8**

## 1.0.8 - 2026-10-02

### Fixed

- fix(build): the toolchain cache was being shipped inside the installer (`c817f32`) — l1nds0n

**Changes since v1.0.7**

## 1.0.7 - 2026-10-02

### Fixed

- fix(release): the portable was a version behind and the find missed it (`55bda5c`) — l1nds0n

**Changes since v1.0.6**

## 1.0.6 - 2026-10-02

### Added

- feat(release): publish the portable too, and let only the deploy move the version (`815f139`) — l1nds0n

### Fixed

- fix(release): strip the tag prefix, and pin the retention test to an instant (`a7237bb`) — l1nds0n

**Changes since v1.0.5**

## 1.0.5 - 2026-10-02

### Fixed

- fix(release): read the artifacts from where the download actually put them (`016580e`) — l1nds0n

**Changes since v1.0.4**

## 1.0.4 - 2026-10-02

### Added

- feat(release): run the tests beside the build and gate the release on both (`a1e75a1`) — l1nds0n

**Changes since v1.0.3**

## 1.0.3 - 2026-10-01

### Fixed

- fix(release): the published release was going out without an update manifest (`b9355ed`) — l1nds0n

**Changes since v1.0.2**

## 1.0.2 - 2026-10-01

### Fixed

- fix(release): the publish step read a variable the runner already owns (`d939876`) — l1nds0n

**Changes since v1.0.1**

## 1.0.1 - 2026-10-01

### Added

- feat(release): publish on every merge, and the updater that consumes it (`433efa1`) — l1nds0n
- feat: complete guided histories and web panel parity (`b5d889a`) — l1nds0n
- feat: add file tree view to retention preview (`d51059a`) — l1nds0n
- feat: expand retention scheduling and previews (`b87e801`) — l1nds0n
- feat: sync source watcher, cron as secondary trigger and retention simulator modal (`d8083bc`) — l1nds0n
- feat: standalone Retention screen with metadata-based dating and monthly rule (`05810b3`) — l1nds0n
- feat: whole-sync simulator in the sync wizard with step tooltips and task dropdown (`9c91a9c`) — l1nds0n

### Fixed

- fix(release): the tag step read a variable it never received (`933db01`) — l1nds0n
- fix(release): a clean line for the next version, and stop the suite rewriting the changelog (`1fc86af`) — l1nds0n
- fix(retention): date snapshots on one calendar, not two (`09e493e`) — l1nds0n
- fix(ci): stop the release test from failing on a clean Windows runner (`ae88cf8`) — l1nds0n
- fix: keep retention focus and modernize its defaults (`c8c0a83`) — l1nds0n
- fix: make sync profile editing reliable (`4c1ebb9`) — l1nds0n
- fix: retention keep rules protect copies instead of competing with delete rules (`a876062`) — l1nds0n

### Changed

- ci: build from the repository root and cache the toolchain (`bf1be7f`) — l1nds0n
- ci: publish tagged Windows releases with artifacts (`895a630`) — l1nds0n
- style: standardize responsive layouts and buttons (`3f86d7f`) — l1nds0n

### Documentation

- docs: add automated visual tour to README (`f3cbc15`) — l1nds0n

### Tests

- test: make cookie tampering assertion deterministic (`8d4e13d`) — l1nds0n

### Other

- Rede de sincronismo entre maquinas, com autorizacao por GitHub (#2) (`a9cc219`) — Lindson França

**Changes since v0.0.3**

## 1.0.0 - 2026-10-01

### Added

- feat: complete guided histories and web panel parity (`b5d889a`) — l1nds0n
- feat: add file tree view to retention preview (`d51059a`) — l1nds0n
- feat: expand retention scheduling and previews (`b87e801`) — l1nds0n
- feat: sync source watcher, cron as secondary trigger and retention simulator modal (`d8083bc`) — l1nds0n
- feat: standalone Retention screen with metadata-based dating and monthly rule (`05810b3`) — l1nds0n
- feat: whole-sync simulator in the sync wizard with step tooltips and task dropdown (`9c91a9c`) — l1nds0n

### Fixed

- fix: keep retention focus and modernize its defaults (`c8c0a83`) — l1nds0n
- fix: make sync profile editing reliable (`4c1ebb9`) — l1nds0n
- fix: retention keep rules protect copies instead of competing with delete rules (`a876062`) — l1nds0n

### Changed

- ci: build from the repository root and cache the toolchain (`bf1be7f`) — l1nds0n
- ci: publish tagged Windows releases with artifacts (`895a630`) — l1nds0n
- style: standardize responsive layouts and buttons (`3f86d7f`) — l1nds0n

### Documentation

- docs: add automated visual tour to README (`f3cbc15`) — l1nds0n

### Tests

- test: make cookie tampering assertion deterministic (`8d4e13d`) — l1nds0n

### Other

- Rede de sincronismo entre maquinas, com autorizacao por GitHub (#2) (`a9cc219`) — Lindson França

**Changes since v0.0.3**
