import { copyTextToClipboard, readClipboardContent } from './clipboard';
import { vibrate } from './haptics';
import { logDebugError } from './logs';
import { getTelegramApp } from './telegram';
import { getIsTelegramClipboardReadTextSupported } from './windowEnvironment';

jest.mock('../config', () => ({
  ...jest.requireActual('../config'),
  IS_TELEGRAM_APP: true,
}));
jest.mock('./haptics', () => ({ vibrate: jest.fn() }));
jest.mock('./logs', () => ({ logDebugError: jest.fn() }));
jest.mock('./telegram', () => ({ getTelegramApp: jest.fn() }));
jest.mock('./windowEnvironment', () => ({ getIsTelegramClipboardReadTextSupported: jest.fn() }));

const initialClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function setClipboardReadText(readText: () => Promise<string>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { readText },
  });
}

function setClipboard(methods: Partial<Clipboard>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: methods,
  });
}

describe('readClipboardContent', () => {
  beforeEach(() => {
    jest.mocked(vibrate).mockClear();
    jest.mocked(getTelegramApp).mockReset();
    jest.mocked(getIsTelegramClipboardReadTextSupported).mockReset();
    jest.mocked(logDebugError).mockClear();
  });

  afterEach(() => {
    if (initialClipboard) {
      Object.defineProperty(navigator, 'clipboard', initialClipboard);
    } else {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    }
  });

  it('uses Telegram clipboard access when the client supports it', async () => {
    jest.mocked(getIsTelegramClipboardReadTextSupported).mockReturnValue(true);
    jest.mocked(getTelegramApp).mockReturnValue({
      readTextFromClipboard: (callback?: (text: string) => unknown) => callback?.('TUtShPoyywj3ehMmnZDV87sQcFx1S6xfsF'),
    } as any);

    await expect(readClipboardContent()).resolves.toEqual({
      text: 'TUtShPoyywj3ehMmnZDV87sQcFx1S6xfsF',
      type: 'text/plain',
    });
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it('falls back to the browser Clipboard API when Telegram does not support it', async () => {
    jest.mocked(getIsTelegramClipboardReadTextSupported).mockReturnValue(false);
    setClipboardReadText(jest.fn().mockResolvedValue('TUtShPoyywj3ehMmnZDV87sQcFx1S6xfsF'));

    await expect(readClipboardContent()).resolves.toEqual({
      text: 'TUtShPoyywj3ehMmnZDV87sQcFx1S6xfsF',
      type: 'text/plain',
    });
    expect(getTelegramApp).not.toHaveBeenCalled();
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it('falls back to the browser Clipboard API when Telegram rejects the request', async () => {
    jest.mocked(getIsTelegramClipboardReadTextSupported).mockReturnValue(true);
    jest.mocked(getTelegramApp).mockReturnValue({
      platform: 'android',
      version: '9.6',
      readTextFromClipboard: () => { throw new Error('WebAppMethodUnsupported'); },
    } as any);
    setClipboardReadText(jest.fn().mockResolvedValue('TUtShPoyywj3ehMmnZDV87sQcFx1S6xfsF'));

    await expect(readClipboardContent()).resolves.toEqual({
      text: 'TUtShPoyywj3ehMmnZDV87sQcFx1S6xfsF',
      type: 'text/plain',
    });
    expect(logDebugError).toHaveBeenCalledWith(
      '[clipboard] Telegram read failed; using browser fallback',
      expect.objectContaining({ platform: 'android', version: '9.6' }),
    );
  });

  it('reports an empty Telegram result before using the browser fallback', async () => {
    jest.mocked(getIsTelegramClipboardReadTextSupported).mockReturnValue(true);
    jest.mocked(getTelegramApp).mockReturnValue({
      platform: 'android',
      version: '9.6',
      readTextFromClipboard: (callback: (text?: string) => void) => callback(undefined),
    } as any);
    setClipboardReadText(jest.fn().mockResolvedValue('fallback address'));

    await expect(readClipboardContent()).resolves.toEqual({
      text: 'fallback address',
      type: 'text/plain',
    });
    expect(logDebugError).toHaveBeenCalledWith(
      '[clipboard] Telegram read returned no text; using browser fallback',
      { platform: 'android', version: '9.6' },
    );
  });
});

describe('copyTextToClipboard', () => {
  beforeEach(() => {
    jest.mocked(vibrate).mockClear();
    jest.mocked(logDebugError).mockClear();
  });

  afterEach(() => {
    if (initialClipboard) {
      Object.defineProperty(navigator, 'clipboard', initialClipboard);
    } else {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    }
    delete (document as any).execCommand;
  });

  it('uses the browser Clipboard API when available', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    await copyTextToClipboard('wallet address');

    expect(writeText).toHaveBeenCalledWith('wallet address');
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it('uses the legacy copy command when the browser Clipboard API rejects', async () => {
    setClipboard({ writeText: jest.fn().mockRejectedValue(new Error('NotAllowedError')) });
    (document as any).execCommand = jest.fn().mockReturnValue(true);

    await copyTextToClipboard('wallet address');

    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(document.body.querySelector('textarea')).toBeNull();
    expect(logDebugError).toHaveBeenCalledWith(
      '[clipboard] browser write failed; using legacy fallback',
      expect.any(Error),
    );
  });
});
