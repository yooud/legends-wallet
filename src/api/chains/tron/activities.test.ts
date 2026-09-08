import type { ApiTransactionActivity } from '../../types';

import { TRX } from '../../../config';
import { shouldShowTransactionAddress } from '../../../util/activities';
import { fetchJson } from '../../../util/fetch';
import { makeMockSwapActivity, makeMockTransactionActivity } from '../../../../tests/mocks';
import { ApiServerError } from '../../errors';
import {
  getTrc20Transactions,
  mergeActivities,
  parseRawTrc20ContractTransaction,
  parseRawTrxTransaction,
} from './activities';
import { NETWORK_CONFIG } from './constants';
import { reconcileWalletSponsorshipActivities } from './sponsorship';
import { getTransactionStatus } from './transactionInfo';

jest.mock('../../../util/fetch', () => ({
  fetchJson: jest.fn(),
}));

const fetchJsonMock = jest.mocked(fetchJson);

describe('TRON history requests', () => {
  const originalHistoryApiKey = NETWORK_CONFIG.mainnet.historyApiKey;
  let historyApiKeyIndex = 0;

  beforeEach(() => {
    fetchJsonMock.mockReset();
    NETWORK_CONFIG.mainnet.historyApiKey = `test-api-key-${historyApiKeyIndex++}`;
  });

  afterAll(() => {
    NETWORK_CONFIG.mainnet.historyApiKey = originalHistoryApiKey;
  });

  it('retries public history without the API key when TronGrid rejects its settings', async () => {
    const transactions = [{ transaction_id: 'tx-1' }];
    fetchJsonMock
      .mockRejectedValueOnce(new ApiServerError('invalid request due to settings', 401))
      .mockResolvedValueOnce({ data: transactions });

    await expect(getTrc20Transactions('mainnet', 'TAddress', { limit: 50 }))
      .resolves.toEqual(transactions);
    expect(fetchJsonMock).toHaveBeenCalledTimes(2);
    expect(fetchJsonMock.mock.calls[0][2]).toEqual({
      headers: { 'TRON-PRO-API-KEY': NETWORK_CONFIG.mainnet.historyApiKey },
    });
    expect(fetchJsonMock.mock.calls[1][2]).toBeUndefined();

    fetchJsonMock.mockResolvedValueOnce({ data: transactions });
    await expect(getTrc20Transactions('mainnet', 'AnotherAddress', { limit: 50 }))
      .resolves.toEqual(transactions);
    expect(fetchJsonMock).toHaveBeenCalledTimes(3);
    expect(fetchJsonMock.mock.calls[2][2]).toBeUndefined();
  });

  it('retries without the API key when TronGrid reports rejected settings in a successful response', async () => {
    const transactions = [{ transaction_id: 'tx-1' }];
    fetchJsonMock
      .mockResolvedValueOnce({ Error: 'invalid request due to settings' })
      .mockResolvedValueOnce({ data: transactions });

    await expect(getTrc20Transactions('mainnet', 'TAddress', { limit: 50 }))
      .resolves.toEqual(transactions);
    expect(fetchJsonMock).toHaveBeenCalledTimes(2);
    expect(fetchJsonMock.mock.calls[0][2]).toEqual({
      headers: { 'TRON-PRO-API-KEY': NETWORK_CONFIG.mainnet.historyApiKey },
    });
    expect(fetchJsonMock.mock.calls[1][2]).toBeUndefined();
  });

  it('does not bypass provider rate limits with an anonymous request', async () => {
    const error = new ApiServerError('rate limit exceeded', 429);
    fetchJsonMock.mockRejectedValueOnce(error);

    await expect(getTrc20Transactions('mainnet', 'TAddress')).rejects.toBe(error);
    expect(fetchJsonMock).toHaveBeenCalledTimes(1);
  });
});

describe('mergeActivities', () => {
  it('merges and sorts activities', () => {
    const txsBySlug = {
      [TRX.slug]: [
        makeMockTransactionActivity({ id: 'a', timestamp: 2 }),
        makeMockTransactionActivity({ id: 'b', timestamp: 1 }),
      ],
      'mock-token': [
        makeMockTransactionActivity({ id: 'c', timestamp: 3 }),
      ],
    };
    const result = mergeActivities(txsBySlug);
    expect(result.map((a) => a.id)).toEqual(['c', 'a', 'b']);
  });

  it('takes token transaction fee from corresponding TRX transaction', () => {
    const txsBySlug = {
      [TRX.slug]: [makeMockTransactionActivity({ id: 'a', timestamp: 1, fee: 123n })],
      'mock-token': [makeMockTransactionActivity({ id: 'a', timestamp: 1, fee: 0n })],
    };
    const result = mergeActivities(txsBySlug);
    // tokenTx should have fee from trxTx
    const resultTokenTx = result.find((a) => a.id === 'a') as ApiTransactionActivity;
    expect(resultTokenTx.fee).toBe(123n);
  });

  it('preserves the prepaid top-up marker in the ordinary activity history', () => {
    const txsBySlug = {
      [TRX.slug]: [makeMockTransactionActivity({ id: 'topup', timestamp: 1, fee: 200_000n })],
      'mock-token': [makeMockTransactionActivity({
        id: 'topup',
        timestamp: 1,
        extra: { walletPrepaidTopup: true },
      })],
    };

    const [activity] = mergeActivities(txsBySlug);

    expect(activity).toMatchObject({
      id: 'topup',
      fee: 200_000n,
      extra: { walletPrepaidTopup: true },
    });
  });

  it('does not duplicate swap activities shared between TRX and token', () => {
    const swap = makeMockSwapActivity({ id: 'swap1', timestamp: 1 });
    const txsBySlug = {
      [TRX.slug]: [swap],
      'mock-token': [swap],
    };
    const result = mergeActivities(txsBySlug);
    // Only one swap activity should be present
    expect(result.filter((a) => a.id === 'swap1').length).toBe(1);
  });

  it('filters out TRX transactions with shouldHide flag', () => {
    const txsBySlug = {
      [TRX.slug]: [
        makeMockTransactionActivity({ id: 'a', timestamp: 2, shouldHide: false }),
        makeMockTransactionActivity({ id: 'b', timestamp: 1, shouldHide: true }),
      ],
      'mock-token': [
        makeMockTransactionActivity({ id: 'c', timestamp: 3 }),
      ],
    };
    const result = mergeActivities(txsBySlug);
    expect(result.map((a) => a.id)).toEqual(['c', 'a']);
  });

  it('filters out token transfer TRX transaction but keeps token transaction', () => {
    const txsBySlug = {
      [TRX.slug]: [
        makeMockTransactionActivity({ id: 'token-tx', timestamp: 1, fee: 100n, shouldHide: true }),
      ],
      'tron:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t': [
        makeMockTransactionActivity({ id: 'token-tx', timestamp: 1, fee: 0n }),
      ],
    };
    const result = mergeActivities(txsBySlug);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('token-tx');
    const resultTx = result[0];
    if (resultTx.kind !== 'transaction') {
      throw new Error('Expected transaction activity');
    }
    expect(resultTx.fee).toBe(100n);
  });
});

describe('parseRawTrxTransaction', () => {
  const testAddress = 'TBgmsoKF7ZV12dkfHqvpjdui3VxxAoN4q4';

  it('marks token transfer transaction (a9059cbb) as shouldHide', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const testTx = require('./testData/tokenTransferTrxTransaction.json');
    const result = parseRawTrxTransaction(testAddress, testTx);
    expect(result.shouldHide).toBe(true);
  });

  it('marks token transferFrom transaction (23b872dd) as shouldHide', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const testTx = require('./testData/tokenTransferFromTrxTransaction.json');
    const result = parseRawTrxTransaction(testAddress, testTx);
    expect(result.shouldHide).toBe(true);
  });

  it('does not mark regular TransferContract as shouldHide (except TransferAssetContract)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const testTx = require('./testData/regularTrxTransfer.json');
    const result = parseRawTrxTransaction(testAddress, testTx);
    expect(result.shouldHide).toBe(false);
  });

  it('marks TransferAssetContract as shouldHide', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const testTx = require('./testData/assetTransfer.json');
    const result = parseRawTrxTransaction(testAddress, testTx);
    expect(result.shouldHide).toBe(true);
  });

  it('does not mark non-token TriggerSmartContract as shouldHide', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const testTx = require('./testData/smartContractCall.json');
    const result = parseRawTrxTransaction(testAddress, testTx);
    expect(result.shouldHide).toBe(false);
  });

  it('preserves a failed on-chain execution status', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const testTx = require('./testData/regularTrxTransfer.json');
    const result = parseRawTrxTransaction(testAddress, {
      ...testTx,
      ret: [{ contractRet: 'REVERT' }],
    });

    expect(result.status).toBe('failed');
  });
});

describe('parseRawTrc20ContractTransaction', () => {
  it('decodes a transfer directly from the raw smart-contract call', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const testTx = require('./testData/tokenTransferTrxTransaction.json');
    const activity = parseRawTrc20ContractTransaction(
      'TBgmsoKF7ZV12dkfHqvpjdui3VxxAoN4q4',
      testTx,
      testTx.raw_data.timestamp,
    );

    expect(activity).toMatchObject({
      id: testTx.txID,
      slug: 'tron-tr7nhqjekq',
      amount: -685_000_000n,
      status: 'completed',
    });
  });

  it('uses the execution status supplied by transaction details', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const testTx = require('./testData/tokenTransferTrxTransaction.json');
    const activity = parseRawTrc20ContractTransaction(
      'TBgmsoKF7ZV12dkfHqvpjdui3VxxAoN4q4',
      testTx,
      testTx.raw_data.timestamp,
      'failed',
    );

    expect(activity?.status).toBe('failed');
  });
});

describe('getTransactionStatus', () => {
  it('distinguishes pending, completed, and failed transaction details', () => {
    expect(getTransactionStatus({ ret: [{ contractRet: 'SUCCESS' }] }, {})).toBe('pending');
    expect(getTransactionStatus({ ret: [{ contractRet: 'SUCCESS' }] }, { id: 'not-included' })).toBe('pending');
    expect(getTransactionStatus(
      { ret: [{ contractRet: 'SUCCESS' }] },
      { blockNumber: 1, receipt: { result: 'SUCCESS' } },
    )).toBe('completed');
    expect(getTransactionStatus(
      { ret: [{ contractRet: 'SUCCESS' }] },
      { blockNumber: 1, result: 'FAILED', receipt: { result: 'OUT_OF_ENERGY' } },
    )).toBe('failed');
  });
});

describe('reconcileWalletSponsorshipActivities', () => {
  const links = [{
    quote_id: 'quote-1',
    main_txid: 'main-tx',
    payment_txid: 'payment-tx',
    charge_sun: 3_200_000,
    service_fee_sun: 3_300_000,
    onchain_fee_sun: 13_300_000,
  }];

  it('hides the separate TRX service payment', () => {
    const [activity] = reconcileWalletSponsorshipActivities(
      TRX.slug,
      [makeMockTransactionActivity({ id: 'payment-tx' })],
      links,
    );
    expect(activity.shouldHide).toBe(true);
  });

  it('attaches the service payment to the original token transfer', () => {
    const [activity] = reconcileWalletSponsorshipActivities(
      'tron:token',
      [makeMockTransactionActivity({ id: 'main-tx', fee: 0n })],
      links,
    );
    expect(activity).toMatchObject({
      id: 'main-tx',
      fee: 3_300_000n,
      extra: {
        walletSponsorship: {
          serviceFee: 3_300_000n,
          onchainFee: 13_300_000n,
        },
        reconciliation: {
          operationId: 'wallet-sponsorship:quote-1',
          hiddenSourceActionIds: ['payment-tx'],
        },
      },
    });
  });

  it('attaches prepaid top-up fees to a native TRX transfer', () => {
    const [activity] = reconcileWalletSponsorshipActivities(
      TRX.slug,
      [makeMockTransactionActivity({ id: 'main-tx', fee: 268_000n })],
      [{
        quote_id: 'topup-1',
        main_txid: 'main-tx',
        charge_sun: 200_000,
        service_fee_sun: 200_000,
        onchain_fee_sun: 268_000,
        purpose: 'prepaid_topup' as const,
      }],
    );

    expect(activity).toMatchObject({
      fee: 200_000n,
      extra: {
        walletSponsorship: {
          serviceFee: 200_000n,
          onchainFee: 268_000n,
        },
        walletPrepaidTopup: true,
      },
    });
    expect(shouldShowTransactionAddress(activity as ApiTransactionActivity)).toEqual([]);
  });

  it('labels a bot top-up without replacing its on-chain fee', () => {
    const [activity] = reconcileWalletSponsorshipActivities(
      TRX.slug,
      [makeMockTransactionActivity({ id: 'bot-topup-tx', fee: 268_000n })],
      [{
        quote_id: 'bot-topup-42',
        main_txid: 'bot-topup-tx',
        purpose: 'prepaid_topup' as const,
      }],
    );

    expect(activity).toMatchObject({
      fee: 268_000n,
      extra: {
        walletPrepaidTopup: true,
      },
    });
    expect(activity.extra?.walletSponsorship).toBeUndefined();
    expect(shouldShowTransactionAddress(activity as ApiTransactionActivity)).toEqual([]);
  });
});
