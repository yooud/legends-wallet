import {
  IS_LEGENDS_WALLET,
  TRC20_BTT_TESTNET,
  TRC20_USDT_MAINNET,
  TRC20_USDT_TESTNET,
  TRON_MAINNET_API_URL,
  TRON_MAINNET_HISTORY_API_KEY,
  TRON_MAINNET_HISTORY_API_URL,
  TRON_TESTNET_API_URL,
  TRON_TESTNET_HISTORY_API_KEY,
  TRON_TESTNET_HISTORY_API_URL,
} from '../../../config';

export const TRON_BIP39_PATH = `m/44'/195'/0'/0/{index}`;

export const TRON_GAS = {
  transferTrc20Estimated: 28_214_970n,
};

export const ONE_TRX = 1_000_000n;

export const NETWORK_CONFIG = {
  mainnet: {
    apiUrl: TRON_MAINNET_API_URL,
    historyApiUrl: TRON_MAINNET_HISTORY_API_URL,
    historyApiKey: TRON_MAINNET_HISTORY_API_KEY,
    usdtAddress: TRC20_USDT_MAINNET.tokenAddress,
    tokenAddresses: [TRC20_USDT_MAINNET.tokenAddress],
    sponsoredTokenAddresses: IS_LEGENDS_WALLET ? [TRC20_USDT_MAINNET.tokenAddress] : [],
  },
  testnet: {
    apiUrl: TRON_TESTNET_API_URL,
    historyApiUrl: TRON_TESTNET_HISTORY_API_URL,
    historyApiKey: TRON_TESTNET_HISTORY_API_KEY,
    usdtAddress: TRC20_USDT_TESTNET.tokenAddress,
    tokenAddresses: [
      TRC20_USDT_TESTNET.tokenAddress,
      ...(IS_LEGENDS_WALLET ? [TRC20_BTT_TESTNET.tokenAddress] : []),
    ],
    sponsoredTokenAddresses: IS_LEGENDS_WALLET
      ? [TRC20_USDT_TESTNET.tokenAddress, TRC20_BTT_TESTNET.tokenAddress]
      : [],
  },
};

export function isWalletSponsoredToken(network: keyof typeof NETWORK_CONFIG, tokenAddress: string) {
  return NETWORK_CONFIG[network].sponsoredTokenAddresses.some((address) => address === tokenAddress);
}
