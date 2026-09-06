import type { ApiCheckTransactionDraftOptions, ApiCheckTransactionDraftResult } from '../types';
import { ApiTransactionDraftError } from '../types';

import chains from '../chains';
import { clearWalletPrepaidAccessSession, getWalletPrepaidAccessToken } from './prepaid';
import { checkTransactionDraft, resetDraftCacheForTests } from './transfer';

jest.mock('../chains', () => ({
  __esModule: true,
  default: {
    ton: {
      checkTransactionDraft: jest.fn(),
    },
    tron: {
      checkTransactionDraft: jest.fn(),
    },
  },
}));
jest.mock('./prepaid', () => ({
  clearWalletPrepaidAccessSession: jest.fn(),
  getWalletPrepaidAccessToken: jest.fn(),
}));

const mockedCheckTransactionDraft = jest.mocked(chains.ton.checkTransactionDraft);
const mockedCheckTronTransactionDraft = jest.mocked(chains.tron.checkTransactionDraft);
const mockedClearWalletPrepaidAccessSession = jest.mocked(clearWalletPrepaidAccessSession);
const mockedGetWalletPrepaidAccessToken = jest.mocked(getWalletPrepaidAccessToken);

const options: ApiCheckTransactionDraftOptions = {
  accountId: '0-mainnet',
  toAddress: 'EQ-test',
  amount: 1n,
};

describe('checkTransactionDraft cache', () => {
  beforeEach(() => {
    resetDraftCacheForTests();
    jest.clearAllMocks();
    mockedCheckTransactionDraft.mockResolvedValue({});
    mockedCheckTronTransactionDraft.mockResolvedValue({});
    mockedGetWalletPrepaidAccessToken.mockResolvedValue(undefined);
  });

  it('bounds the cache and evicts the least recently used entry', async () => {
    for (let i = 0; i < 65; i++) {
      await checkTransactionDraft('ton', { ...options, toAddress: `EQ-test-${i}` });
    }

    await checkTransactionDraft('ton', { ...options, toAddress: 'EQ-test-0' });

    expect(mockedCheckTransactionDraft).toHaveBeenCalledTimes(66);
  });

  it('keeps an evicted late completion from overwriting a replacement request', async () => {
    const stale = createDeferred<ApiCheckTransactionDraftResult>();
    const current = createDeferred<ApiCheckTransactionDraftResult>();
    let targetRequestCount = 0;
    mockedCheckTransactionDraft.mockImplementation(({ toAddress }) => {
      if (toAddress !== 'EQ-late-key') return Promise.resolve({});
      targetRequestCount += 1;
      return targetRequestCount === 1 ? stale.promise : current.promise;
    });

    const staleRequest = checkTransactionDraft('ton', { ...options, toAddress: 'EQ-late-key' });
    for (let i = 0; i < 64; i++) {
      await checkTransactionDraft('ton', { ...options, toAddress: `EQ-eviction-${i}` });
    }
    const currentRequest = checkTransactionDraft('ton', { ...options, toAddress: 'EQ-late-key' });
    stale.resolve({ resolvedAddress: 'EQ-stale' });
    await staleRequest;
    const coalescedRequest = checkTransactionDraft('ton', { ...options, toAddress: 'EQ-late-key' });
    current.resolve({ resolvedAddress: 'EQ-current' });

    await expect(currentRequest).resolves.toMatchObject({ resolvedAddress: 'EQ-current' });
    await expect(coalescedRequest).resolves.toMatchObject({ resolvedAddress: 'EQ-current' });
    expect(targetRequestCount).toBe(2);
  });

  it('keeps an evicted late rejection from deleting a replacement request', async () => {
    const stale = createDeferred<ApiCheckTransactionDraftResult>();
    const current = createDeferred<ApiCheckTransactionDraftResult>();
    let targetRequestCount = 0;
    mockedCheckTransactionDraft.mockImplementation(({ toAddress }) => {
      if (toAddress !== 'EQ-late-rejection') return Promise.resolve({});
      targetRequestCount += 1;
      return targetRequestCount === 1 ? stale.promise : current.promise;
    });

    const staleRequest = checkTransactionDraft('ton', { ...options, toAddress: 'EQ-late-rejection' });
    const staleExpectation = expect(staleRequest).rejects.toThrow('Stale failure');
    for (let i = 0; i < 64; i++) {
      await checkTransactionDraft('ton', { ...options, toAddress: `EQ-rejection-eviction-${i}` });
    }
    const currentRequest = checkTransactionDraft('ton', { ...options, toAddress: 'EQ-late-rejection' });
    stale.reject(new Error('Stale failure'));
    await staleExpectation;
    const coalescedRequest = checkTransactionDraft('ton', { ...options, toAddress: 'EQ-late-rejection' });
    current.resolve({ resolvedAddress: 'EQ-current' });

    await expect(currentRequest).resolves.toMatchObject({ resolvedAddress: 'EQ-current' });
    await expect(coalescedRequest).resolves.toMatchObject({ resolvedAddress: 'EQ-current' });
    expect(targetRequestCount).toBe(2);
  });

  it('only clears the prepaid access token used by a stale Tron draft', async () => {
    const stale = createDeferred<ApiCheckTransactionDraftResult>();
    const current = createDeferred<ApiCheckTransactionDraftResult>();
    let targetRequestCount = 0;
    mockedGetWalletPrepaidAccessToken
      .mockResolvedValueOnce('stale-token')
      .mockResolvedValueOnce('fresh-token');
    mockedCheckTronTransactionDraft.mockImplementation(({ toAddress }) => {
      if (toAddress !== 'T-late-key') return Promise.resolve({});
      targetRequestCount += 1;
      return targetRequestCount === 1 ? stale.promise : current.promise;
    });

    const staleRequest = checkTransactionDraft('tron', { ...options, toAddress: 'T-late-key' });
    for (let i = 0; i < 65; i++) {
      await checkTransactionDraft('ton', { ...options, toAddress: `EQ-token-eviction-${i}` });
    }
    const currentRequest = checkTransactionDraft('tron', { ...options, toAddress: 'T-late-key' });
    stale.resolve({ error: ApiTransactionDraftError.WalletPrepaidAuthorizationRequired });
    await staleRequest;

    expect(mockedClearWalletPrepaidAccessSession).toHaveBeenCalledWith(options.accountId, 'stale-token');
    current.resolve({ resolvedAddress: 'T-current' });
    await expect(currentRequest).resolves.toMatchObject({ resolvedAddress: 'T-current' });
    expect(targetRequestCount).toBe(2);
  });
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
