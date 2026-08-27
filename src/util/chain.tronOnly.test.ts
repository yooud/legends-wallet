import { TRC20_USDT_MAINNET, TRC20_USDT_TESTNET, TRX } from '../config';
import {
  CHAIN_DISPLAY_ORDER,
  CHAIN_ORDER,
  getDefaultEnabledSlugs,
  getIsSupportedChain,
  getSupportedChains,
  getTokenInfo,
} from './chain';

describe('Legends Wallet TRON-only configuration', () => {
  it('exposes only TRON as a supported chain', () => {
    expect(CHAIN_ORDER).toEqual(['tron']);
    expect(CHAIN_DISPLAY_ORDER).toEqual(['tron']);
    expect(getSupportedChains()).toEqual(['tron']);
    expect(getIsSupportedChain('tron')).toBe(true);
    expect(getIsSupportedChain('ton')).toBe(false);
    expect(getIsSupportedChain('solana')).toBe(false);
    expect(getIsSupportedChain('ethereum')).toBe(false);
  });

  it('enables TRX and the matching USDT TRC-20 token by default', () => {
    expect([...getDefaultEnabledSlugs('mainnet')]).toEqual([TRX.slug, TRC20_USDT_MAINNET.slug]);
    expect([...getDefaultEnabledSlugs('testnet')]).toEqual([TRX.slug, TRC20_USDT_TESTNET.slug]);
  });

  it('does not seed tokens from disabled chains', () => {
    expect(new Set(Object.values(getTokenInfo()).map(({ chain }) => chain))).toEqual(new Set(['tron']));
  });
});
