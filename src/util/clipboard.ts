import { IS_TELEGRAM_APP } from '../config';
import { vibrate } from './haptics';
import { logDebugError } from './logs';
import { getTelegramApp } from './telegram';
import { getIsTelegramClipboardReadTextSupported } from './windowEnvironment';

const textCopyEl = document.createElement('textarea');
textCopyEl.setAttribute('readonly', '');
textCopyEl.tabIndex = -1;
textCopyEl.className = 'visually-hidden';

export const copyTextToClipboard = async (str: string): Promise<void> => {
  vibrate();

  try {
    if (!navigator.clipboard?.writeText) throw new Error('Browser Clipboard API is unavailable');
    await navigator.clipboard.writeText(str);
    return;
  } catch (error) {
    logDebugError('[clipboard] browser write failed; using legacy fallback', error);
  }

  textCopyEl.value = str;
  document.body.appendChild(textCopyEl);
  textCopyEl.select();
  textCopyEl.setSelectionRange(0, str.length);
  const didCopy = document.execCommand('copy');
  textCopyEl.remove();

  if (!didCopy) throw new Error('Clipboard write failed');
};

export async function readClipboardContent() {
  if (IS_TELEGRAM_APP && getIsTelegramClipboardReadTextSupported()) {
    const telegramApp = getTelegramApp();
    if (telegramApp) {
      try {
        const text = await readTelegramClipboard(telegramApp);
        if (text !== undefined) {
          vibrate();
          return { text, type: 'text/plain' };
        }

        logDebugError('[clipboard] Telegram read returned no text; using browser fallback', {
          platform: telegramApp.platform,
          version: telegramApp.version,
        });
      } catch (error) {
        logDebugError('[clipboard] Telegram read failed; using browser fallback', {
          error,
          platform: telegramApp.platform,
          version: telegramApp.version,
        });
        // The browser Clipboard API below is the fallback when the native request fails or times out.
      }
    }
  }

  try {
    if (!navigator.clipboard?.readText) throw new Error('Browser Clipboard API is unavailable');
    const text = await navigator.clipboard.readText();
    vibrate();
    return { text, type: 'text/plain' };
  } catch (error) {
    logDebugError('[clipboard] browser read failed', error);
    throw error;
  }
}

function readTelegramClipboard(telegramApp: ReturnType<typeof getTelegramApp>) {
  return new Promise<string | undefined>((resolve, reject) => {
    if (!telegramApp) {
      resolve(undefined);
      return;
    }

    const timeout = window.setTimeout(() => resolve(undefined), 1_500);
    try {
      telegramApp.readTextFromClipboard((text) => {
        window.clearTimeout(timeout);
        resolve(text ?? undefined);
      });
    } catch (error) {
      window.clearTimeout(timeout);
      reject(error);
    }
  });
}
