import type { ApiTokenWithPrice } from '../../api/types';
import type { GlobalState } from '../types';

import { TRX } from '../../config';
import { updateTokens } from './misc';

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
