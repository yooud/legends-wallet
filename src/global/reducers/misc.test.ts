import type { ApiTokenWithPrice } from '../../api/types';
import type { GlobalState } from '../types';

import { TRX } from '../../config';
import { LEGENDS_CARD_BACKGROUND_IDS } from '../../util/legendsCardBackground';
import { createAccount, updateTokens } from './misc';

describe('createAccount', () => {
  it('uses a neutral title for the first Legends wallet', () => {
    const global = {
      accounts: { byId: {} },
      settings: { byAccountId: {} },
    } as unknown as GlobalState;

    const updated = createAccount({
      global,
      accountId: 'mainnet-first-wallet',
      type: 'mnemonic',
      byChain: {},
      network: 'mainnet',
    });

    expect(updated.accounts?.byId['mainnet-first-wallet'].title).toBe('Wallet');
  });

  it('assigns and persists a random Legends card background for a new account', () => {
    const random = jest.spyOn(Math, 'random').mockReturnValue(0.75);
    const global = {
      accounts: { byId: {} },
      settings: { byAccountId: {} },
    } as unknown as GlobalState;

    const updated = createAccount({
      global,
      accountId: 'mainnet-new-wallet',
      type: 'mnemonic',
      byChain: {},
      partial: { title: 'New Wallet' },
    });

    expect(updated.settings.byAccountId['mainnet-new-wallet'].cardBackgroundId)
      .toBe(LEGENDS_CARD_BACKGROUND_IDS[6]);
    expect(global.settings.byAccountId['mainnet-new-wallet']).toBeUndefined();

    random.mockRestore();
  });

  it('preserves existing appearance settings when creating an account', () => {
    const global = {
      accounts: { byId: {} },
      settings: {
        byAccountId: {
          'mainnet-new-wallet': { cardBackgroundId: 'logo-black' },
        },
      },
    } as unknown as GlobalState;

    const updated = createAccount({
      global,
      accountId: 'mainnet-new-wallet',
      type: 'view',
      byChain: {},
      partial: { title: 'New Wallet' },
    });

    expect(updated.settings.byAccountId['mainnet-new-wallet'].cardBackgroundId).toBe('logo-black');
  });
});

describe('updateTokens', () => {
  const createTrx = (priceUsd: number): ApiTokenWithPrice => ({
    ...TRX,
    priceUsd,
    percentChange24h: 0,
  });

  it('accepts priced tokens when the backend intentionally omits TON', () => {
    const global = {
      tokenInfo: {
        bySlug: {
          [TRX.slug]: createTrx(0.1),
        },
      },
    } as unknown as GlobalState;

    const updated = updateTokens(global, {
      [TRX.slug]: createTrx(0.35),
    });

    expect(updated.tokenInfo?.bySlug[TRX.slug].priceUsd).toBe(0.35);
  });

  it('keeps the previous price when an update has no valid prices', () => {
    const global = {
      tokenInfo: {
        bySlug: {
          [TRX.slug]: createTrx(0.1),
        },
      },
    } as unknown as GlobalState;

    const updated = updateTokens(global, {
      [TRX.slug]: createTrx(0),
    });

    expect(updated.tokenInfo?.bySlug[TRX.slug].priceUsd).toBe(0.1);
  });
});
