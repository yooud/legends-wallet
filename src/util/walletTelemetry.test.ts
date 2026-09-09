import { getTranslation } from './langProvider';
import {
  getTelemetryElementDetails,
  isWalletReplayBlockedScreen,
  maskWalletReplayText,
  sanitizeWalletReplayEvent,
  selectTelemetryWalletAddresses,
  shouldRecordWalletReplay,
} from './walletTelemetry';

describe('walletTelemetry', () => {
  it('describes an interaction without recording visible text or input values', () => {
    const button = document.createElement('button');
    button.className = 'Button_button icon-wrapper';
    button.textContent = 'Send 100 USDT to TVpWp3GMyNY8Zemo3JHogbWq4o4eDLa5r8';
    const input = document.createElement('input');
    input.type = 'password';
    input.value = '1234';
    button.append(input);

    const details = getTelemetryElementDetails(input);
    expect(details).toEqual({
      element: 'input',
      input_type: 'password',
      control_type: 'password',
    });
    expect(JSON.stringify(details)).not.toContain('1234');
    expect(JSON.stringify(details)).not.toContain('TVpWp3GMyNY8Zemo3JHogbWq4o4eDLa5r8');
  });

  it('uses explicit stable ids and icon names when present', () => {
    const button = document.createElement('button');
    button.dataset.telemetryId = 'transfer-submit';
    button.innerHTML = '<i class="icon-send"></i>';

    expect(getTelemetryElementDetails(button)).toEqual({
      element: 'transfer-submit',
      icon: 'icon-send',
      control_type: 'submit',
    });
  });

  it('does not describe interactions inside replay-blocked controls', () => {
    const pinPad = document.createElement('div');
    pinPad.className = 'rr-block';
    const button = document.createElement('button');
    pinPad.append(button);

    expect(getTelemetryElementDetails(button)).toBeUndefined();
  });

  it('records only bounded target geometry for an interaction', () => {
    const button = document.createElement('button');
    jest.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      x: 19,
      y: 42,
      width: 101,
      height: 47,
    } as DOMRect);

    expect(getTelemetryElementDetails(button)).toEqual({
      element: 'button',
      control_type: 'submit',
      target_box: [20, 44, 100, 48],
    });
  });

  it('keeps known UI translations and masks arbitrary wallet data', () => {
    getTranslation('Create New Wallet');

    expect(maskWalletReplayText('Create New Wallet')).toBe('Create New Wallet');
    expect(maskWalletReplayText('Private Savings Wallet')).toBe('******* ******* ******');
    expect(maskWalletReplayText('TVpWp3GMyNY8Zemo3JHogbWq4o4eDLa5r8')).not.toContain('TVpWp3G');
    expect(maskWalletReplayText('  ')).toBe('  ');
  });

  it('blocks all screens that can expose wallet credentials', () => {
    expect(isWalletReplayBlockedScreen('Auth.mnemonicPage')).toBe(true);
    expect(isWalletReplayBlockedScreen('Auth.createPin')).toBe(true);
    expect(isWalletReplayBlockedScreen('AppLock')).toBe(true);
    expect(isWalletReplayBlockedScreen('Settings.BackupWallet')).toBe(true);
    expect(isWalletReplayBlockedScreen('Main.Assets')).toBe(false);
    expect(shouldRecordWalletReplay('')).toBe(false);
    expect(shouldRecordWalletReplay('Auth.createPin')).toBe(false);
    expect(shouldRecordWalletReplay('Main.Assets')).toBe(true);
  });

  it('attributes telemetry only to signable, persisted wallets', () => {
    const address = 'TVpWp3GMyNY8Zemo3JHogbWq4o4eDLa5r8';
    expect(selectTelemetryWalletAddresses({
      mnemonic: { type: 'mnemonic', byChain: { tron: { address } } },
      duplicate: { type: 'hardware', byChain: { tron: { address } } },
      watchOnly: {
        type: 'view',
        byChain: { tron: { address: 'TWwrLJGNsETRXUpbv68351Rtpm6GzVHwRo' } },
      },
      temporary: {
        type: 'mnemonic',
        isTemporary: true,
        byChain: { tron: { address: 'TUtShPoyywj3ehMmnZDV87sQcFx1S6xfsF' } },
      },
      recoveryRequired: {
        type: 'mnemonic',
        isRecoveryRequired: true,
        byChain: { tron: { address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' } },
      },
    })).toEqual([address]);
  });

  it('removes auth URLs and private attributes before packing replay events', () => {
    const event = sanitizeWalletReplayEvent({
      type: 4,
      timestamp: 1,
      data: {
        href: `${window.location.origin}/telegram/?token=secret#tgWebAppData=secret`,
        node: {
          attributes: {
            class: 'WalletPanel',
            value: '1234',
            'aria-label': 'Private Savings Wallet',
            href: 'https://example.com/private',
            style: 'color:red;background-image:url(https://example.com/private.png)',
          },
        },
      },
    } as any) as any;

    expect(event.data.href).toBe(`${window.location.origin}/telegram/`);
    expect(event.data.node.attributes).toEqual({
      class: 'WalletPanel',
      style: 'color:red;background-image:none',
    });
    expect(JSON.stringify(event)).not.toContain('secret');
    expect(JSON.stringify(event)).not.toContain('Private Savings Wallet');
  });
});
