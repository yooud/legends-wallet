import { IS_TELEGRAM_APP } from '../config';
import { vibrate } from './haptics';
import { getTelegramApp } from './telegram';
import { getIsTelegramClipboardReadTextSupported } from './windowEnvironment';

const textCopyEl = document.createElement('textarea');
textCopyEl.setAttribute('readonly', '');
textCopyEl.tabIndex = -1;
textCopyEl.className = 'visually-hidden';

export const copyTextToClipboard = (str: string): Promise<void> => {
  vibrate();

  return navigator.clipboard.writeText(str);
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
      } catch {
        // The browser Clipboard API below is the fallback when the native request fails or times out.
      }
    }
  }

  const text = await navigator.clipboard.readText();
  vibrate();
  return { text, type: 'text/plain' };
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
