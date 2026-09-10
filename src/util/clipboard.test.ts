import { readClipboardContent } from './clipboard';
import { vibrate } from './haptics';
import { getTelegramApp } from './telegram';
import { getIsTelegramClipboardReadTextSupported } from './windowEnvironment';

jest.mock('../config', () => ({
  ...jest.requireActual('../config'),
  IS_TELEGRAM_APP: true,
}));
jest.mock('./haptics', () => ({ vibrate: jest.fn() }));
jest.mock('./telegram', () => ({ getTelegramApp: jest.fn() }));
jest.mock('./windowEnvironment', () => ({ getIsTelegramClipboardReadTextSupported: jest.fn() }));

const initialClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function setClipboardReadText(readText: () => Promise<string>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { readText },
  });
}

describe('readClipboardContent', () => {
  beforeEach(() => {
    jest.mocked(vibrate).mockClear();
    jest.mocked(getTelegramApp).mockReset();
    jest.mocked(getIsTelegramClipboardReadTextSupported).mockReset();
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
});
