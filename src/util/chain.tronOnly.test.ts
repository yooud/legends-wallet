import {
  TRC20_BTT_TESTNET, TRC20_USDT_MAINNET, TRC20_USDT_TESTNET, TRX,
} from '../config';
import { isWalletSponsoredToken } from '../api/chains/tron/constants';
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
    expect([...getDefaultEnabledSlugs('testnet')]).toEqual([
      TRX.slug,
      TRC20_USDT_TESTNET.slug,
      TRC20_BTT_TESTNET.slug,
    ]);
  });

  it('does not seed tokens from disabled chains', () => {
    expect(new Set(Object.values(getTokenInfo()).map(({ chain }) => chain))).toEqual(new Set(['tron']));
  });

  it('sponsors BTT on testnet only', () => {
    expect(isWalletSponsoredToken('testnet', TRC20_BTT_TESTNET.tokenAddress)).toBe(true);
    expect(isWalletSponsoredToken('mainnet', TRC20_BTT_TESTNET.tokenAddress)).toBe(false);
  });
});
