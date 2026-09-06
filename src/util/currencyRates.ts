import type { ApiBaseCurrency, ApiCurrencyRates } from '../api/types';

import { CURRENCIES } from '../config';
import { Big } from '../lib/big.js';

/** Ensures every cached currency rate is a positive string accepted by the app's decimal parser. */
export function sanitizeCurrencyRates(rates: Partial<ApiCurrencyRates> | undefined): ApiCurrencyRates {
  const entries = Object.entries(CURRENCIES).map(([currency, { fallbackRate }]) => {
    const rate = rates?.[currency as ApiBaseCurrency];

    return [currency, isUsableRate(rate) ? rate : fallbackRate];
  });

  return Object.fromEntries(entries) as ApiCurrencyRates;
}

function isUsableRate(rate: unknown): rate is string {
  if (typeof rate !== 'string') {
    return false;
  }

  try {
    return new Big(rate).gt(0);
  } catch {
    return false;
  }
}
