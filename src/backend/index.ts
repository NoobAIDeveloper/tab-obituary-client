/**
 * Public surface of the backend client. UI code should import from here
 * rather than reaching into `./client.js` or `./token-store.js` directly,
 * so internal refactors stay internal.
 *
 * Notably we do NOT re-export `./config.js` — the base URL is a build-time
 * concern, not a consumer concern. Tests that need to override it import
 * `./config.js` directly.
 */

export {
  type ApiError,
  type ApiErrorCode,
  type ApiOk,
  type ApiResult,
  type CallOptions,
  type DeleteAccountResult,
  type ExportResult,
  type GenerateReportOptions,
  type SettingsPatch,
  type SettingsResult,
  type SubscribeResult,
  type UnsubscribeResult,
  deleteAccount,
  exportAccount,
  generateReport,
  subscribe,
  unsubscribe,
  updateSettings,
} from './client.js';

export {
  CLIENT_TOKEN_CRYPTO_KEY_STORAGE_KEY,
  CLIENT_TOKEN_STORAGE_KEY,
  clearClientToken,
  getClientToken,
  setClientToken,
} from './token-store.js';

export {
  type EmailConfirmationResult,
  type EmailConfirmationStatus,
  fetchEmailConfirmationStatus,
} from './status.js';
