import { INPUT_TICK_THROTTLE_MS } from '@tabob/shared';
import { makeThrottle } from './throttle.js';

const INPUT_EVENTS = ['mousemove', 'keydown', 'scroll', 'click', 'wheel', 'touchstart'] as const;

function sendTick(): void {
  try {
    // Content script is intentionally passive: no DOM reads, no page content.
    chrome.runtime.sendMessage({ type: 'input_tick', ts: Date.now() }, () => {
      // Access lastError to silence "Unchecked runtime.lastError" when the SW
      // is asleep or the extension context is invalidated.
      void chrome.runtime.lastError;
    });
  } catch {
    // Extension context invalidated mid-page-lifetime (e.g., on update). Ignore.
  }
}

const maybeTick = makeThrottle(INPUT_TICK_THROTTLE_MS);
const onInput = (): void => maybeTick(sendTick);

for (const name of INPUT_EVENTS) {
  window.addEventListener(name, onInput, { passive: true, capture: true });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // Fire immediately on re-focus so the SW sees the first moment of renewed
    // attention without waiting out the throttle window.
    sendTick();
  }
});

console.debug('[tab-obituary] input beacon active');
