import { ApiServerError } from '../errors';
import {
  importMnemonic,
  removeAccount,
  removeNetworkAccounts,
  resetAccounts,
  validateMnemonic,
} from './auth';

jest.mock('../chains', () => ({
  __esModule: true,
  default: {
    tron: {
      getDefaultDerivation: jest.fn().mockReturnValue({ path: 'm/44\'/195\'/0\'/0/0', index: 0 }),
      getWalletFromBip39Mnemonic: jest.fn(),
    },
  },
}));

jest.mock('../chains/ton', () => ({
  __esModule: true,
  getKeyPairFromStoredMnemonic: jest.fn(),
  buildBackendAuthToken: jest.fn(),
  getOtherVersionWallet: jest.fn(),
}));

jest.mock('../common/mnemonic', () => ({
  validateBip39Mnemonic: jest.fn(),
  generateBip39Mnemonic: jest.fn(),
  getMnemonic: jest.fn(),
}));

jest.mock('../common/accounts', () => ({
  getNewAccountId: jest.fn(),
  setAccountValue: jest.fn(),
  getAccountChains: jest.fn((account) => account.byChain),
  fetchStoredAccount: jest.fn(),
  fetchStoredAccounts: jest.fn(),
  fetchStoredChainAccount: jest.fn(),
  removeAccountValue: jest.fn(),
  removeNetworkAccountsValue: jest.fn(),
  updateStoredAccount: jest.fn(),
  updateStoredWallet: jest.fn(),
}));

jest.mock('./accounts', () => ({
  activateAccount: jest.fn(),
  deactivateAllAccounts: jest.fn(),
}));

jest.mock('./polling', () => ({
  addPollingAccount: jest.fn(),
  removeAllPollingAccounts: jest.fn(),
  removeNetworkPollingAccounts: jest.fn(),
  removePollingAccount: jest.fn(),
}));

jest.mock('../common/tokens', () => ({ sendUpdateTokens: jest.fn() }));
jest.mock('../db', () => ({ tokenRepository: { clear: jest.fn() } }));
jest.mock('../environment', () => ({ getEnvironment: jest.fn().mockReturnValue({}) }));
jest.mock('../storages', () => ({
  storage: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn(), mutateItem: jest.fn() },
}));
jest.mock('./prepaid', () => ({
  clearAllWalletPrepaidAccessSessions: jest.fn(),
  clearWalletPrepaidAccessSessionsForNetwork: jest.fn(),
  revokeWalletPrepaidAccessSession: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const chains = require('../chains').default as { tron: { getWalletFromBip39Mnemonic: jest.Mock } };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { validateBip39Mnemonic } = require('../common/mnemonic') as { validateBip39Mnemonic: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setAccountValue, getNewAccountId } = require('../common/accounts') as {
  setAccountValue: jest.Mock;
  getNewAccountId: jest.Mock;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { fetchStoredAccounts } = require('../common/accounts') as { fetchStoredAccounts: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const prepaidMocks = require('./prepaid') as {
  clearAllWalletPrepaidAccessSessions: jest.Mock;
  clearWalletPrepaidAccessSessionsForNetwork: jest.Mock;
  revokeWalletPrepaidAccessSession: jest.Mock;
};
const {
  clearAllWalletPrepaidAccessSessions,
  clearWalletPrepaidAccessSessionsForNetwork,
  revokeWalletPrepaidAccessSession,
} = prepaidMocks;

const MNEMONIC = ['valid', 'bip39', 'phrase'];

describe('TRON-only mnemonic import', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    validateBip39Mnemonic.mockReturnValue(true);
    chains.tron.getWalletFromBip39Mnemonic.mockResolvedValue([{
      address: 'TVpWp3GMyNY8Zemo3JHogbWq4o4eDLa5r8',
      derivation: { path: 'm/44\'/195\'/0\'/0/0', index: 0 },
    }]);
    getNewAccountId.mockImplementation((network: string) => Promise.resolve(`0-${network}`));
    setAccountValue.mockResolvedValue(undefined);
  });

  it('accepts only BIP39 mnemonics', async () => {
    await expect(validateMnemonic(MNEMONIC)).resolves.toBe(true);

    validateBip39Mnemonic.mockReturnValue(false);
    await expect(validateMnemonic(MNEMONIC)).resolves.toBe(false);
    await expect(importMnemonic(['mainnet'], MNEMONIC)).rejects.toThrow('Invalid mnemonic');
  });

  it('persists a TRON-only BIP39 account', async () => {
    const result = await importMnemonic(['mainnet'], MNEMONIC, true);

    expect(result).toEqual([{
      accountId: '0-mainnet',
      byChain: expect.objectContaining({
        tron: expect.objectContaining({ address: 'TVpWp3GMyNY8Zemo3JHogbWq4o4eDLa5r8' }),
      }),
    }]);
    expect(setAccountValue).toHaveBeenCalledWith(
      '0-mainnet',
      'accounts',
      expect.objectContaining({
        type: 'bip39',
        byChain: expect.objectContaining({ tron: expect.any(Object) }),
      }),
    );
  });

  it('persists nothing when derivation fails on one network', async () => {
    chains.tron.getWalletFromBip39Mnemonic.mockImplementation((network: string) => (
      network === 'testnet' ? Promise.reject(new ApiServerError('node unavailable')) : Promise.resolve([{
        address: 'TVpWp3GMyNY8Zemo3JHogbWq4o4eDLa5r8',
        derivation: { path: 'm/44\'/195\'/0\'/0/0', index: 0 },
      }])
    ));

    const result = await importMnemonic(['mainnet', 'testnet'], MNEMONIC, true);

    expect(result).toEqual({ error: expect.any(String) });
    expect(setAccountValue).not.toHaveBeenCalled();
  });
});

describe('prepaid access cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fetchStoredAccounts.mockResolvedValue({
      '0-mainnet': { type: 'bip39' },
      '1-testnet': { type: 'bip39' },
    });
    revokeWalletPrepaidAccessSession.mockResolvedValue(undefined);
    clearWalletPrepaidAccessSessionsForNetwork.mockResolvedValue(undefined);
    clearAllWalletPrepaidAccessSessions.mockResolvedValue(undefined);
  });

  it('revokes the removed account session', async () => {
    await removeAccount('0-mainnet', undefined);

    expect(revokeWalletPrepaidAccessSession).toHaveBeenCalledWith('0-mainnet');
  });

  it('revokes network sessions and clears stale network entries', async () => {
    await removeNetworkAccounts('testnet');

    expect(revokeWalletPrepaidAccessSession).toHaveBeenCalledTimes(1);
    expect(revokeWalletPrepaidAccessSession).toHaveBeenCalledWith('1-testnet');
    expect(clearWalletPrepaidAccessSessionsForNetwork).toHaveBeenCalledWith('testnet');
  });

  it('revokes all sessions and clears stale entries on reset', async () => {
    await resetAccounts();

    expect(revokeWalletPrepaidAccessSession).toHaveBeenCalledTimes(2);
    expect(clearAllWalletPrepaidAccessSessions).toHaveBeenCalledTimes(1);
  });
});
