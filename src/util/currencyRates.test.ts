import type { ApiCurrencyRates } from '../api/types';

import { CURRENCIES } from '../config';
import { Big } from '../lib/big.js';
import { sanitizeCurrencyRates } from './currencyRates';

const GOOD_RATES: ApiCurrencyRates = {
  USD: '1',
  EUR: '0.85999000',
  RUB: '86.63811900',
  CNY: '6.71915000',
  BTC: '0.000012594155896938',
  TON: '0.734524104',
};

const UNUSABLE_RATES = [
  'Infinity', '-Infinity', 'NaN', '', '   ', '0', '0.0', '-1', '0x10', ' 1 ', 'abc', undefined,
];

describe('sanitizeCurrencyRates', () => {
  it('passes usable rates through untouched', () => {
    expect(sanitizeCurrencyRates(GOOD_RATES)).toEqual(GOOD_RATES);
  });

  it.each(UNUSABLE_RATES)('replaces %p with the fallback rate', (rate) => {
    const rates = { ...GOOD_RATES, TON: rate } as ApiCurrencyRates;

    expect(sanitizeCurrencyRates(rates).TON).toBe(CURRENCIES.TON.fallbackRate);
  });

  it('fills in missing currencies', () => {
    const { BTC, ...withoutBtc } = GOOD_RATES;

    expect(sanitizeCurrencyRates(withoutBtc).BTC).toBe(CURRENCIES.BTC.fallbackRate);
  });

  it('returns parser-safe rates when handed nothing', () => {
    const rates = sanitizeCurrencyRates(undefined);

    expect(Object.keys(rates)).toEqual(Object.keys(CURRENCIES));
    Object.values(rates).forEach((rate) => expect(() => new Big(rate)).not.toThrow());
  });
});
