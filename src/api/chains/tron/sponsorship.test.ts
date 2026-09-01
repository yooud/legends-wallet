import type { TronWeb, Types } from 'tronweb';

import { BRILLIANT_API_BASE_URL } from '../../../config';
import { fetchJson } from '../../../util/fetch';
import { ApiServerError } from '../../errors';
import {
  getCachedWalletSponsorshipActivityLinks,
  getWalletSponsorshipDisplayError,
  refreshWalletSponsorshipActivityLinks,
  requestWalletSponsorshipQuote,
  submitWalletSponsoredTransfer,
} from './sponsorship';

jest.mock('../../../util/fetch', () => ({
  fetchJson: jest.fn(),
}));

const fetchJsonMock = jest.mocked(fetchJson);
const transaction = {
  txID: 'main-tx',
  raw_data_hex: 'abcd',
  raw_data: { timestamp: 1_000, expiration: 601_000 },
} as unknown as Types.Transaction;
const intent = {
  network: 'mainnet' as const,
  ownerAddress: 'TOwner',
  toAddress: 'TRecipient',
  tokenAddress: 'TToken',
  amount: 1_000_000n,
};

const tronWeb = {
  transactionBuilder: {
    extendExpiration: jest.fn(),
    sendTrx: jest.fn(),
  },
  trx: {
    sign: jest.fn(),
  },
} as unknown as TronWeb;

describe('TRON wallet sponsorship', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps the signing transaction private and rejects a mismatched transfer intent', async () => {
    fetchJsonMock.mockResolvedValueOnce({
      ok: true,
      sponsored: true,
      payment_required: false,
      quote_id: 'quote-mismatch',
      expires_at: '2099-01-01T00:00:00Z',
      treasury_address: 'TTreasury',
      charge_sun: 3_000_000,
      onchain_fee_sun: 10_000_000,
      payment_network_fee_sun: 100_000,
      transaction,
    });

    const sponsorship = await requestWalletSponsorshipQuote(tronWeb, intent, transaction);
    expect(sponsorship).toEqual({
      id: 'quote-mismatch',
      expiresAt: '2099-01-01T00:00:00Z',
      serviceFee: 3_100_000n,
      onchainFee: 10_000_000n,
    });

    await expect(submitWalletSponsoredTransfer(tronWeb, 'private-key', sponsorship.id, {
      ...intent,
      toAddress: 'TOtherRecipient',
    })).resolves.toEqual({ error: '$wallet_sponsorship_quote_changed' });
    expect(tronWeb.trx.sign).not.toHaveBeenCalled();
  });

  it('uses wallet-api rather than the TRON RPC for activity links without awaiting the request', async () => {
    let resolveRequest!: (value: AnyLiteral) => void;
    fetchJsonMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveRequest = resolve;
    }));

    refreshWalletSponsorshipActivityLinks('mainnet', 'TOwner-links');

    expect(fetchJsonMock).toHaveBeenCalledWith(
      `${BRILLIANT_API_BASE_URL}/wallet-sponsorship/activity-links`,
      { address: 'TOwner-links' },
      undefined,
      { retries: 1, timeouts: 3_000 },
    );
    expect(getCachedWalletSponsorshipActivityLinks('mainnet', 'TOwner-links')).toEqual([]);

    resolveRequest({ ok: true, links: [{
      quote_id: 'quote-link',
      main_txid: 'main-tx',
      payment_txid: 'payment-tx',
      charge_sun: 1,
      service_fee_sun: 2,
      onchain_fee_sun: 5,
    }] });
    await Promise.resolve();
    await Promise.resolve();

    expect(getCachedWalletSponsorshipActivityLinks('mainnet', 'TOwner-links')).toHaveLength(1);
  });

  it('maps structured backend errors to stable display errors', () => {
    expect(getWalletSponsorshipDisplayError(
      new ApiServerError('disabled', 503, 'wallet_sponsorship_disabled'),
    )).toBe('$wallet_sponsorship_unavailable');
    expect(getWalletSponsorshipDisplayError(
      new ApiServerError('changed', 409, 'resource_conditions_changed'),
    )).toBe('$wallet_sponsorship_quote_changed');
  });
});
