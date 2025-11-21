# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2025-11-21

### Security
- **XSS Prevention**: Implemented `helper/security.js` with `safeHTML` (using DOMPurify) and `setInnerHTML`.
- **Refactoring**: Replaced unsafe `innerHTML` assignments across multiple files (`main.js`, `richmenu.js`, `tag.js`, etc.) with `setInnerHTML`.

### Added
- **Configuration**: Created `env/config.js` to centralize environment variables (`liffId`, `apiBase`, `testUserId`).
- **State Management**: Created `helper/state.js` to manage global state (`userId`, `currentProject`) and avoid global variable pollution.
- **Backend**: Recovered original Cloudflare Worker source code (`pinti-line`) from Cloudflare Dashboard and restored it to `src/`.
- **Documentation**: Added `api_specification.md` describing backend endpoints.
- **Backup**: Created local ZIP backup and initialized Git repository with `.gitignore`.

### Changed
- **Frontend Logic**: Refactored `richmenu.js`, `tag.js`, `member_builder.js`, `flex_builder.js`, etc., to use centralized state and configuration.
- **Backend Configuration**: Updated `wrangler.jsonc` and `package.json` to match the recovered backend structure.
- **API Calls**: Updated frontend to use dynamic `apiBase` instead of hardcoded URLs.

### Fixed
- **Bug**: Fixed `ReferenceError: userId is not defined` in `richmenu.js` and `tag.js` by correctly importing `getUserId` from `helper/state.js`.
- **Deployment**: Fixed `wrangler.jsonc` routes configuration to successfully deploy the `pinti-line` worker.

### Removed
- **Dead Code**: Removed unused `js/init.js` and commented-out legacy code blocks in various files.
