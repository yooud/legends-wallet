import {
  authorizeWalletPrepaid,
  clearWalletPrepaidAccessSession,
  connectWalletBotBalance,
  disconnectWalletBotBalance,
  ensureWalletPrepaidAccess,
  fetchWalletBotBalanceProjects,
  fetchWalletPrepaidOverview,
  getWalletPrepaidAccessToken,
  linkWalletPrepaidAccounts,
  resetPrepaidAccessCacheForTests,
  revokeWalletPrepaidAccessSession,
  setWalletPrepaidCoverageMode,
} from './prepaid';

const PRIMARY_ACCOUNT_ID = '0-testnet';
const CANDIDATE_ACCOUNT_ID = '1-testnet';
const REFRESH_ACCOUNT_ID = '2-testnet';
const SILENT_ACCESS_ACCOUNT_ID = '3-testnet';
const PERSISTED_ACCESS_ACCOUNT_ID = '4-testnet';
const RESTORED_ACCESS_ACCOUNT_ID = '5-testnet';
const VIEW_ACCOUNT_ID = '6-testnet';
const PRIMARY_ADDRESS = 'TH8s8UjojVBtrT3jVwqYJox19sAWQkFTah';
const CANDIDATE_ADDRESS = 'TMpwh5GWdwFFYuZ9bQADFHavYRqgpYSSz1';
const PROOF_ADDRESS = 'TXRrMctE8A2bHegZGwV6fSbwF7DPLN6HCE';
const mockStoredValues: Record<string, unknown> = {};

jest.mock('../common/accounts', () => ({
  fetchStoredChainAccount: jest.fn((accountId: string) => Promise.resolve({
    type: accountId === VIEW_ACCOUNT_ID ? 'view' : 'bip39',
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
  rememberWalletSponsorshipActivityLink: jest.fn(),
}));

jest.mock('../chains/tron/util/tronweb', () => ({
  getTronClient: jest.fn(),
}));

jest.mock('../../util/fetch', () => ({ fetchJson: jest.fn() }));
jest.mock('../storages', () => ({
  storage: {
    getItem: jest.fn(() => Promise.resolve(undefined)),
    setItem: jest.fn(() => Promise.resolve()),
    removeItem: jest.fn(() => Promise.resolve()),
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
  storage: { getItem: jest.Mock; setItem: jest.Mock; removeItem: jest.Mock; mutateItem: jest.Mock };
};

const mockSendTrx = jest.fn((recipient: string, amount: number, owner: string) => Promise.resolve({
  raw_data: { recipient, amount, owner },
}));
const mockAddUpdateData = jest.fn((transaction: unknown) => Promise.resolve(transaction));
const mockSign = jest.fn((transaction: unknown) => Promise.resolve(transaction));
const mockSignMessageV2 = jest.fn(() => 'message-signature');

describe('wallet prepaid proof transactions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetPrepaidAccessCacheForTests();
    Object.keys(mockStoredValues).forEach((key) => delete mockStoredValues[key]);
    mockStorage.getItem.mockImplementation((key: string) => Promise.resolve(mockStoredValues[key]));
    mockStorage.setItem.mockImplementation((key: string, value: unknown) => {
      mockStoredValues[key] = value;
      return Promise.resolve();
    });
    mockStorage.mutateItem.mockImplementation((key: string, mutate: (value: unknown) => unknown) => {
      mockStoredValues[key] = mutate(mockStoredValues[key]);
      return Promise.resolve(mockStoredValues[key]);
    });
    mockGetTronClient.mockReturnValue({
      transactionBuilder: { sendTrx: mockSendTrx, addUpdateData: mockAddUpdateData },
      trx: { sign: mockSign, signMessageV2: mockSignMessageV2 },
    });
  });

  it('treats a missing access session as an authorization state', async () => {
    await expect(fetchWalletPrepaidOverview(PRIMARY_ACCOUNT_ID)).resolves.toBeUndefined();

    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it('does not expose or request fee-balance access for a watch-only account', async () => {
    await expect(fetchWalletPrepaidOverview(VIEW_ACCOUNT_ID)).resolves.toBeUndefined();
    await expect(getWalletPrepaidAccessToken(VIEW_ACCOUNT_ID)).resolves.toBeUndefined();
    await expect(ensureWalletPrepaidAccess(VIEW_ACCOUNT_ID, 'token')).resolves.toBeUndefined();

    expect(mockFetchJson).not.toHaveBeenCalled();
    expect(mockSignMessageV2).not.toHaveBeenCalled();
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
    const bucketKeys = mockFetchJson.mock.calls.map((call) => call[3]?.bucketKey);
    expect(bucketKeys).toEqual([
      expect.stringContaining('/access/challenge'),
      expect.stringContaining('/access/complete'),
      expect.stringContaining('/overview'),
    ]);
    expect(new Set(bucketKeys).size).toBe(3);
    expect(mockStorage.mutateItem).toHaveBeenCalledWith('walletPrepaidAccessSessions', expect.any(Function));
  });

  it('creates access for a new inactive subwallet without building a transaction', async () => {
    mockFetchJson
      .mockResolvedValueOnce({
        challenge: 'offline-challenge',
        memo: 'offline access memo',
        proof_address: PROOF_ADDRESS,
        proof_type: 'message_v2',
      })
      .mockResolvedValueOnce({
        access_token: 'offline-access-token',
        expires_at: Math.floor(Date.now() / 1000) + 30 * 86_400,
        refresh_token: 'offline-refresh-token',
        refresh_expires_at: Math.floor(Date.now() / 1000) + 365 * 86_400,
      });

    await ensureWalletPrepaidAccess(SILENT_ACCESS_ACCOUNT_ID, 'token');

    expect(mockSignMessageV2).toHaveBeenCalledWith('offline access memo', 'private-key');
    expect(mockSendTrx).not.toHaveBeenCalled();
    expect(JSON.parse(mockFetchJson.mock.calls[1][2].body)).toMatchObject({
      proof: { type: 'message_v2', signature: 'message-signature' },
    });
    expect(mockFetchJson.mock.calls[0][3]).toMatchObject({ retries: 3, timeouts: [3_000, 5_000, 7_000] });
    expect(mockFetchJson.mock.calls[1][3]).toMatchObject({ retries: 3, timeouts: [3_000, 5_000, 7_000] });
  });

  it('revokes and clears a persisted session when an account is removed', async () => {
    mockFetchJson
      .mockResolvedValueOnce({
        challenge: 'offline-challenge',
        memo: 'offline access memo',
        proof_address: PROOF_ADDRESS,
        proof_type: 'message_v2',
      })
      .mockResolvedValueOnce({
        access_token: 'access-token',
        expires_at: Math.floor(Date.now() / 1000) + 30 * 86_400,
        refresh_token: 'refresh-token',
        refresh_expires_at: Math.floor(Date.now() / 1000) + 365 * 86_400,
      })
      .mockResolvedValueOnce({ revoked: true });

    await ensureWalletPrepaidAccess(SILENT_ACCESS_ACCOUNT_ID, 'token');
    await revokeWalletPrepaidAccessSession(SILENT_ACCESS_ACCOUNT_ID);

    expect(mockFetchJson.mock.calls[2][0]).toContain('/access/revoke');
    expect(mockFetchJson.mock.calls[2][2]).toMatchObject({
      headers: { Authorization: 'Bearer refresh-token' },
      keepalive: true,
    });
    await expect(getWalletPrepaidAccessToken(SILENT_ACCESS_ACCOUNT_ID)).resolves.toBeUndefined();
    expect(mockStoredValues.walletPrepaidAccessSessions).toEqual({});
  });

  it('revokes a session that arrives after account removal started', async () => {
    let completeAccess!: (session: AnyLiteral) => void;
    let markCompleteStarted!: () => void;
    const completeStarted = new Promise<void>((resolve) => {
      markCompleteStarted = resolve;
    });
    mockFetchJson
      .mockResolvedValueOnce({
        challenge: 'late-challenge',
        memo: 'late access memo',
        proof_address: PROOF_ADDRESS,
        proof_type: 'message_v2',
      })
      .mockImplementationOnce(() => {
        markCompleteStarted();
        return new Promise((resolve) => {
          completeAccess = resolve;
        });
      })
      .mockResolvedValueOnce({ revoked: true });

    const pendingAccess = ensureWalletPrepaidAccess(SILENT_ACCESS_ACCOUNT_ID, 'token');
    await completeStarted;
    await revokeWalletPrepaidAccessSession(SILENT_ACCESS_ACCOUNT_ID);
    completeAccess({
      access_token: 'late-access-token',
      expires_at: Math.floor(Date.now() / 1000) + 30 * 86_400,
      refresh_token: 'late-refresh-token',
      refresh_expires_at: Math.floor(Date.now() / 1000) + 365 * 86_400,
    });
    await pendingAccess;

    expect(mockFetchJson.mock.calls[2][0]).toContain('/access/revoke');
    expect(mockFetchJson.mock.calls[2][2].headers.Authorization).toBe('Bearer late-refresh-token');
    await expect(getWalletPrepaidAccessToken(SILENT_ACCESS_ACCOUNT_ID)).resolves.toBeUndefined();
  });

  it('serializes concurrent refreshes for the same wallet', async () => {
    let completeRefresh!: (session: AnyLiteral) => void;
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    mockFetchJson
      .mockResolvedValueOnce({
        challenge: 'refresh-challenge',
        memo: 'refresh access memo',
        proof_address: PROOF_ADDRESS,
        proof_type: 'message_v2',
      })
      .mockResolvedValueOnce({
        access_token: 'expiring-access-token',
        expires_at: Math.floor(Date.now() / 1000) + 60,
        refresh_token: 'single-use-refresh-token',
        refresh_expires_at: Math.floor(Date.now() / 1000) + 365 * 86_400,
      })
      .mockImplementationOnce(() => {
        markRefreshStarted();
        return new Promise((resolve) => {
          completeRefresh = resolve;
        });
      });

    await ensureWalletPrepaidAccess(SILENT_ACCESS_ACCOUNT_ID, 'token');
    const first = getWalletPrepaidAccessToken(SILENT_ACCESS_ACCOUNT_ID);
    const second = getWalletPrepaidAccessToken(SILENT_ACCESS_ACCOUNT_ID);
    await refreshStarted;
    completeRefresh({
      access_token: 'rotated-access-token',
      expires_at: Math.floor(Date.now() / 1000) + 30 * 86_400,
      refresh_token: 'rotated-refresh-token',
      refresh_expires_at: Math.floor(Date.now() / 1000) + 365 * 86_400,
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      'rotated-access-token',
      'rotated-access-token',
    ]);
    expect(mockFetchJson).toHaveBeenCalledTimes(3);
    expect(mockFetchJson.mock.calls[2][3]).toMatchObject({ retries: 1, timeouts: 3_000 });
  });

  it('waits for background subwallet access before reporting that authorization is missing', async () => {
    let completeAccess!: (session: AnyLiteral) => void;
    let markCompleteStarted!: () => void;
    const completeStarted = new Promise<void>((resolve) => {
      markCompleteStarted = resolve;
    });
    mockFetchJson
      .mockResolvedValueOnce({
        challenge: 'background-challenge',
        memo: 'background access memo',
        proof_address: PROOF_ADDRESS,
        proof_type: 'message_v2',
      })
      .mockImplementationOnce(() => {
        markCompleteStarted();
        return new Promise((resolve) => {
          completeAccess = resolve;
        });
      })
      .mockResolvedValueOnce({ enabled: true, balance_trx: '5' });

    const backgroundAccess = ensureWalletPrepaidAccess(SILENT_ACCESS_ACCOUNT_ID, 'token');
    await completeStarted;
    const overview = fetchWalletPrepaidOverview(SILENT_ACCESS_ACCOUNT_ID);
    completeAccess({
      access_token: 'background-access-token',
      expires_at: Math.floor(Date.now() / 1000) + 30 * 86_400,
      refresh_token: 'background-refresh-token',
      refresh_expires_at: Math.floor(Date.now() / 1000) + 365 * 86_400,
    });

    await expect(overview).resolves.toMatchObject({ enabled: true, balance_trx: '5' });
    await backgroundAccess;
    expect(mockFetchJson).toHaveBeenCalledTimes(3);
    expect(mockSendTrx).not.toHaveBeenCalled();
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

  it('creates and reuses an access session during an existing wallet unlock', async () => {
    mockFetchJson
      .mockResolvedValueOnce({
        challenge: 'background-challenge',
        memo: 'background access memo',
        proof_address: PROOF_ADDRESS,
      })
      .mockResolvedValueOnce({
        access_token: 'background-access-token',
        expires_at: Math.floor(Date.now() / 1000) + 30 * 86_400,
        refresh_token: 'background-refresh-token',
        refresh_expires_at: Math.floor(Date.now() / 1000) + 365 * 86_400,
      });

    await Promise.all([
      ensureWalletPrepaidAccess(SILENT_ACCESS_ACCOUNT_ID, 'token'),
      ensureWalletPrepaidAccess(SILENT_ACCESS_ACCOUNT_ID, 'token'),
    ]);
    await ensureWalletPrepaidAccess(SILENT_ACCESS_ACCOUNT_ID, 'token');

    expect(mockFetchJson).toHaveBeenCalledTimes(2);
    await expect(getWalletPrepaidAccessToken(SILENT_ACCESS_ACCOUNT_ID)).resolves.toBe('background-access-token');
    await clearWalletPrepaidAccessSession(SILENT_ACCESS_ACCOUNT_ID, 'stale-access-token');
    await expect(getWalletPrepaidAccessToken(SILENT_ACCESS_ACCOUNT_ID)).resolves.toBe('background-access-token');
    await clearWalletPrepaidAccessSession(SILENT_ACCESS_ACCOUNT_ID, 'background-access-token');
    await expect(getWalletPrepaidAccessToken(SILENT_ACCESS_ACCOUNT_ID)).resolves.toBeUndefined();
    expect(mockSendTrx).toHaveBeenCalledWith(PROOF_ADDRESS, 1, CANDIDATE_ADDRESS);
    expect(mockSign).toHaveBeenCalledTimes(1);
  });

  it('restores a persisted access session by wallet address after an API reload', async () => {
    mockFetchJson
      .mockResolvedValueOnce({
        challenge: 'persistent-challenge',
        memo: 'persistent access memo',
        proof_address: PROOF_ADDRESS,
      })
      .mockResolvedValueOnce({
        access_token: 'persistent-access-token',
        expires_at: Math.floor(Date.now() / 1000) + 30 * 86_400,
        refresh_token: 'persistent-refresh-token',
        refresh_expires_at: Math.floor(Date.now() / 1000) + 365 * 86_400,
      });

    await ensureWalletPrepaidAccess(SILENT_ACCESS_ACCOUNT_ID, 'token');
    resetPrepaidAccessCacheForTests();

    await expect(getWalletPrepaidAccessToken(RESTORED_ACCESS_ACCOUNT_ID))
      .resolves.toBe('persistent-access-token');
    expect(mockFetchJson).toHaveBeenCalledTimes(2);
    expect(mockStoredValues.walletPrepaidAccessSessions).toMatchObject({
      [`testnet:${CANDIDATE_ADDRESS}`]: { access_token: 'persistent-access-token' },
    });
  });

  it('keeps a newer persisted session when a stale request tries to clear it', async () => {
    await clearWalletPrepaidAccessSession(PERSISTED_ACCESS_ACCOUNT_ID, 'stale-access-token');

    const mutate = mockStorage.mutateItem.mock.calls[0][1] as (
      stored: Record<string, { access_token: string }>
    ) => Record<string, { access_token: string }>;
    const stored = { [PERSISTED_ACCESS_ACCOUNT_ID]: { access_token: 'fresh-access-token' } };
    expect(mutate(stored)).toBe(stored);
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
    expect(mockFetchJson.mock.calls[1][3]).toEqual({
      retries: 1,
      bucketKey: expect.stringContaining('/integration/complete'),
    });
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
