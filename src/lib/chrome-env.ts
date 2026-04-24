/**
 * Chrome environment detection for modules that may run outside the extension
 * (tests, preview pages, TypeScript type-check in Node).
 *
 * Returns true only when `chrome`, `chrome.storage`, and `chrome.storage.local`
 * are all defined. Callers guard IO on the result so the same module is usable
 * in unit tests without a chrome shim.
 */
export function hasChromeStorage(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    chrome.storage !== undefined &&
    chrome.storage.local !== undefined
  );
}
