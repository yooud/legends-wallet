import {
  authorizeWalletPrepaid,
  connectWalletBotBalance,
  disconnectWalletBotBalance,
  fetchWalletBotBalanceProjects,
  fetchWalletPrepaidOverview,
  linkWalletPrepaidAccounts,
  setWalletPrepaidCoverageMode,
} from './prepaid';

const PRIMARY_ACCOUNT_ID = '0-testnet';
const CANDIDATE_ACCOUNT_ID = '1-testnet';
const REFRESH_ACCOUNT_ID = '2-testnet';
const PRIMARY_ADDRESS = 'TH8s8UjojVBtrT3jVwqYJox19sAWQkFTah';
const CANDIDATE_ADDRESS = 'TMpwh5GWdwFFYuZ9bQADFHavYRqgpYSSz1';
const PROOF_ADDRESS = 'TXRrMctE8A2bHegZGwV6fSbwF7DPLN6HCE';

jest.mock('../common/accounts', () => ({
  fetchStoredChainAccount: jest.fn((accountId: string) => Promise.resolve({
    type: 'bip39',
    byChain: {
      tron: {
        address: accountId === PRIMARY_ACCOUNT_ID ? PRIMARY_ADDRESS : CANDIDATE_ADDRESS,
      },
    },
  })),
}));

jest.mock('../chains/tron/auth', () => ({
  fetchPrivateKeyString: jest.fn(() => Promise.resolve('private-key')),
}));

jest.mock('../chains/tron/sponsorship', () => ({
  ensureSponsoredTransactionTtl: jest.fn((_tronWeb: unknown, transaction: unknown) => Promise.resolve(transaction)),
}));

jest.mock('../chains/tron/util/tronweb', () => ({
  getTronClient: jest.fn(),
}));

jest.mock('../../util/fetch', () => ({ fetchJson: jest.fn() }));
jest.mock('../storages', () => ({
  storage: {
    getItem: jest.fn(() => Promise.resolve(undefined)),
    setItem: jest.fn(() => Promise.resolve()),
    mutateItem: jest.fn(() => Promise.resolve()),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { fetchJson: mockFetchJson } = require('../../util/fetch') as { fetchJson: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getTronClient: mockGetTronClient } = require('../chains/tron/util/tronweb') as {
  getTronClient: jest.Mock;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { storage: mockStorage } = require('../storages') as {
  storage: { mutateItem: jest.Mock };
};

const mockSendTrx = jest.fn((recipient: string, amount: number, owner: string) => Promise.resolve({
  raw_data: { recipient, amount, owner },
}));
const mockAddUpdateData = jest.fn((transaction: unknown) => Promise.resolve(transaction));
const mockSign = jest.fn((transaction: unknown) => Promise.resolve(transaction));

describe('wallet prepaid proof transactions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTronClient.mockReturnValue({
      transactionBuilder: { sendTrx: mockSendTrx, addUpdateData: mockAddUpdateData },
      trx: { sign: mockSign },
    });
  });

  it('treats a missing access session as an authorization state', async () => {
    await expect(fetchWalletPrepaidOverview(PRIMARY_ACCOUNT_ID)).resolves.toBeUndefined();

    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it('builds link proofs as opposite-direction transfers', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ challenge_id: 'challenge', memo: 'memo' })
      .mockResolvedValueOnce({ coverage_mode: 'auto' });

    await linkWalletPrepaidAccounts(PRIMARY_ACCOUNT_ID, CANDIDATE_ACCOUNT_ID, 'token');

    expect(mockSendTrx).toHaveBeenNthCalledWith(1, CANDIDATE_ADDRESS, 1, PRIMARY_ADDRESS);
    expect(mockSendTrx).toHaveBeenNthCalledWith(2, PRIMARY_ADDRESS, 1, CANDIDATE_ADDRESS);
  });

  it('signs an access challenge and uses its bearer token for the overview', async () => {
    mockFetchJson
      .mockResolvedValueOnce({
        challenge: 'signed-challenge',
        memo: 'access memo',
        proof_address: CANDIDATE_ADDRESS,
      })
      .mockResolvedValueOnce({ access_token: 'access-token', expires_at: Math.floor(Date.now() / 1000) + 60 })
      .mockResolvedValueOnce({ enabled: true, balance_trx: '5' });

    await authorizeWalletPrepaid(CANDIDATE_ACCOUNT_ID, 'token');

    expect(mockSendTrx).toHaveBeenCalledWith(CANDIDATE_ADDRESS, 1, CANDIDATE_ADDRESS);
    expect(mockFetchJson.mock.calls[2][2].headers).toEqual({ Authorization: 'Bearer access-token' });
    expect(mockStorage.mutateItem).toHaveBeenCalledWith('walletPrepaidAccessSessions', expect.any(Function));
  });

  it('refreshes an expiring access session without another wallet proof', async () => {
    mockFetchJson
      .mockResolvedValueOnce({
        challenge: 'signed-challenge',
        memo: 'access memo',
        proof_address: CANDIDATE_ADDRESS,
      })
      .mockResolvedValueOnce({
        access_token: 'expiring-token',
        expires_at: Math.floor(Date.now() / 1000) + 60,
        refresh_token: 'refresh-token',
        refresh_expires_at: Math.floor(Date.now() / 1000) + 86_400,
      })
      .mockResolvedValueOnce({
        access_token: 'refreshed-token',
        expires_at: Math.floor(Date.now() / 1000) + 30 * 86_400,
        refresh_token: 'rotated-refresh-token',
        refresh_expires_at: Math.floor(Date.now() / 1000) + 365 * 86_400,
      })
      .mockResolvedValueOnce({ enabled: true, balance_trx: '5' });

    await authorizeWalletPrepaid(REFRESH_ACCOUNT_ID, 'token');

    expect(mockFetchJson.mock.calls[2][0]).toContain('/access/refresh');
    expect(mockFetchJson.mock.calls[2][2].headers.Authorization).toBe('Bearer refresh-token');
    expect(mockFetchJson.mock.calls[3][2].headers.Authorization).toBe('Bearer refreshed-token');
    expect(mockSign).toHaveBeenCalledTimes(1);
  });

  it('uses the server-provided recipient for a preference proof', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ challenge_id: 'challenge', memo: 'memo', proof_address: PROOF_ADDRESS })
      .mockResolvedValueOnce({ coverage_mode: 'prepaid' });

    await setWalletPrepaidCoverageMode(PRIMARY_ACCOUNT_ID, 'token', 'prepaid');

    expect(mockSendTrx).toHaveBeenCalledWith(PROOF_ADDRESS, 1, PRIMARY_ADDRESS);
  });

  it('sends an API key only in the integration challenge header and signs a local proof', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ challenge_id: 'challenge', memo: 'memo', proof_address: PROOF_ADDRESS })
      .mockResolvedValueOnce({ coverage_mode: 'auto' });

    await connectWalletBotBalance(PRIMARY_ACCOUNT_ID, 'token', { type: 'api_key', apiKey: 'secret' });

    expect(mockFetchJson.mock.calls[0][2].headers).toEqual({
      'Content-Type': 'application/json',
      'X-API-Key': 'secret',
    });
    expect(mockFetchJson.mock.calls[0][2].body).toBe(JSON.stringify({ address: PRIMARY_ADDRESS }));
    expect(mockFetchJson.mock.calls[1][2].body).not.toContain('secret');
    expect(mockSendTrx).toHaveBeenCalledWith(PROOF_ADDRESS, 1, PRIMARY_ADDRESS);
  });

  it('uses Telegram Mini App init data without an API key header', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ challenge_id: 'challenge', memo: 'memo', proof_address: PROOF_ADDRESS })
      .mockResolvedValueOnce({ coverage_mode: 'auto' });

    await connectWalletBotBalance(PRIMARY_ACCOUNT_ID, 'token', {
      type: 'telegram_mini_app',
      initData: 'signed-init-data',
      projectId: 42,
    });

    expect(mockFetchJson.mock.calls[0][2].headers).toEqual({ 'Content-Type': 'application/json' });
    expect(mockFetchJson.mock.calls[0][2].body).toContain('signed-init-data');
    expect(mockFetchJson.mock.calls[0][2].body).toContain('"project_id":42');
    expect(mockFetchJson.mock.calls[1][3]).toEqual({ retries: 1 });
  });

  it('loads Telegram projects before requesting a wallet proof', async () => {
    mockFetchJson.mockResolvedValueOnce({
      auth_method: 'telegram_mini_app',
      projects: [{ id: 42, name: 'Personal', available_trx: '5' }],
    });

    await fetchWalletBotBalanceProjects(PRIMARY_ACCOUNT_ID, {
      type: 'telegram_mini_app',
      initData: 'signed-init-data',
    });

    expect(mockFetchJson.mock.calls[0][0]).toContain('/integration/projects');
    expect(mockFetchJson.mock.calls[0][2].body).toContain('signed-init-data');
    expect(mockSendTrx).not.toHaveBeenCalled();
  });

  it('signs a wallet proof before disconnecting the shared balance', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ challenge_id: 'challenge', memo: 'memo', proof_address: PROOF_ADDRESS })
      .mockResolvedValueOnce({ coverage_mode: 'auto' });

    await disconnectWalletBotBalance(PRIMARY_ACCOUNT_ID, 'token');

    expect(mockSendTrx).toHaveBeenCalledWith(PROOF_ADDRESS, 1, PRIMARY_ADDRESS);
    expect(mockFetchJson.mock.calls[1][0]).toContain('/integration/disconnect');
  });
});
