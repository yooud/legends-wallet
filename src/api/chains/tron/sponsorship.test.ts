import type { TronWeb, Types } from 'tronweb';

import { BRILLIANT_API_BASE_URL } from '../../../config';
import { fetchJson } from '../../../util/fetch';
import { ApiServerError } from '../../errors';
import {
  getWalletSponsorshipDisplayError,
  loadWalletSponsorshipActivityLinks,
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
      payment_mode: 'none',
      quote_id: 'quote-mismatch',
      expires_at: '2099-01-01T00:00:00Z',
      treasury_address: 'TTreasury',
      charge_sun: 3_000_000,
      onchain_fee_sun: 10_000_000,
      payment_network_fee_sun: 100_000,
      transaction,
    });

    const sponsorship = await requestWalletSponsorshipQuote(tronWeb, intent, transaction, 'access-token');
    expect(sponsorship).toEqual({
      id: 'quote-mismatch',
      expiresAt: '2099-01-01T00:00:00Z',
      serviceFee: 3_100_000n,
      onchainFee: 10_000_000n,
      paymentMode: 'none',
      isPrepaidInsufficient: false,
      prepaidAvailable: undefined,
      prepaidBalance: undefined,
    });
    expect(fetchJsonMock).toHaveBeenCalledWith(
      `${BRILLIANT_API_BASE_URL}/wallet-sponsorship/quote`,
      undefined,
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer access-token',
        },
        body: JSON.stringify({ address: intent.ownerAddress, transaction }),
      }),
    );

    await expect(submitWalletSponsoredTransfer(tronWeb, 'private-key', sponsorship.id, {
      ...intent,
      toAddress: 'TOtherRecipient',
    })).resolves.toEqual({ error: '$wallet_sponsorship_quote_changed' });
    expect(tronWeb.trx.sign).not.toHaveBeenCalled();
  });

  it('loads commission metadata separately for exact TronGrid transaction ids', async () => {
    const txId = 'a'.repeat(64);
    fetchJsonMock.mockResolvedValueOnce({
      ok: true,
      checked_txids: [txId],
      links: [{
        quote_id: 'quote-exact',
        main_txid: txId,
        charge_sun: 200_000,
        onchain_fee_sun: 1_000_000,
      }],
    });

    const links = await loadWalletSponsorshipActivityLinks('mainnet', 'TOwner-exact', [txId]);
    const cachedLinks = await loadWalletSponsorshipActivityLinks('mainnet', 'TOwner-exact', [txId]);

    expect(fetchJsonMock).toHaveBeenCalledWith(
      `${BRILLIANT_API_BASE_URL}/wallet-sponsorship/activity-links`,
      { address: 'TOwner-exact', txids: txId },
      undefined,
      { retries: 1, timeouts: 3_000 },
    );
    expect(links).toEqual([expect.objectContaining({ quote_id: 'quote-exact', main_txid: txId })]);
    expect(cachedLinks).toEqual(links);
    expect(fetchJsonMock).toHaveBeenCalledTimes(1);
  });

  it('keeps prepaid sponsorship metadata on the main activity without a payment transfer', async () => {
    fetchJsonMock
      .mockResolvedValueOnce({
        ok: true,
        sponsored: true,
        payment_required: false,
        payment_mode: 'prepaid',
        quote_id: 'quote-prepaid',
        expires_at: '2099-01-01T00:00:00Z',
        treasury_address: 'TTreasury',
        charge_sun: 3_000_000,
        activation_charge_sun: 1_100_000,
        onchain_fee_sun: 10_000_000,
        payment_network_fee_sun: 0,
        prepaid_balance_sun: 8_000_000,
        prepaid_available_sun: 8_000_000,
        transaction,
      })
      .mockResolvedValueOnce({
        ok: true,
        result: true,
        txid: 'main-tx',
        quote_id: 'quote-prepaid',
      });
    jest.mocked(tronWeb.trx.sign).mockResolvedValueOnce(transaction as never);

    const sponsorship = await requestWalletSponsorshipQuote(tronWeb, intent, transaction, 'access-token');
    const result = await submitWalletSponsoredTransfer(tronWeb, 'private-key', sponsorship.id, intent);

    expect(result).toMatchObject({
      txId: 'main-tx',
      localActivityParams: {
        extra: {
          reconciliation: undefined,
          walletSponsorship: {
            serviceFee: 4_100_000n,
            onchainFee: 10_000_000n,
          },
        },
      },
    });
    expect(tronWeb.transactionBuilder.sendTrx).not.toHaveBeenCalled();
  });

  it('pays activation and resources with one direct TRX transaction', async () => {
    const payment = {
      txID: 'payment-tx',
      raw_data_hex: 'cafe',
      raw_data: { timestamp: 1_000, expiration: 601_000 },
    } as unknown as Types.Transaction;
    fetchJsonMock
      .mockResolvedValueOnce({
        ok: true,
        sponsored: true,
        payment_required: true,
        payment_mode: 'direct',
        quote_id: 'quote-direct-activation',
        expires_at: '2099-01-01T00:00:00Z',
        treasury_address: 'TTreasury',
        charge_sun: 200_000,
        payment_charge_sun: 1_500_000,
        activation_charge_sun: 1_300_000,
        onchain_fee_sun: 0,
        payment_network_fee_sun: 0,
        transaction,
      })
      .mockResolvedValueOnce({
        ok: true,
        result: true,
        txid: 'main-tx',
        quote_id: 'quote-direct-activation',
        payment_txid: 'payment-tx',
      });
    jest.mocked(tronWeb.transactionBuilder.sendTrx).mockResolvedValueOnce(payment as never);
    jest.mocked(tronWeb.trx.sign)
      .mockResolvedValueOnce(transaction as never)
      .mockResolvedValueOnce(payment as never);

    const sponsorship = await requestWalletSponsorshipQuote(tronWeb, intent, transaction, 'access-token');
    const result = await submitWalletSponsoredTransfer(tronWeb, 'private-key', sponsorship.id, intent);

    expect(sponsorship.serviceFee).toBe(1_500_000n);
    expect(tronWeb.transactionBuilder.sendTrx).toHaveBeenCalledTimes(1);
    expect(tronWeb.transactionBuilder.sendTrx).toHaveBeenCalledWith('TTreasury', 1_500_000, 'TOwner');
    expect(result).toMatchObject({ txId: 'main-tx' });
  });

  it('does not sign when an authorized quote reports insufficient prepaid funds', async () => {
    fetchJsonMock.mockResolvedValueOnce({
      ok: true,
      sponsored: true,
      payment_required: false,
      payment_mode: 'prepaid',
      prepaid_insufficient: true,
      quote_id: 'quote-empty',
      expires_at: '2099-01-01T00:00:00Z',
      treasury_address: 'TTreasury',
      charge_sun: 3_000_000,
      onchain_fee_sun: 10_000_000,
      payment_network_fee_sun: 0,
      transaction,
    });

    const sponsorship = await requestWalletSponsorshipQuote(tronWeb, intent, transaction, 'access-token');
    expect(sponsorship.isPrepaidInsufficient).toBe(true);

    await expect(submitWalletSponsoredTransfer(
      tronWeb, 'private-key', sponsorship.id, intent,
    )).resolves.toEqual({ error: 'WalletPrepaidInsufficient' });
    expect(tronWeb.trx.sign).not.toHaveBeenCalled();
  });

  it('maps structured backend errors to stable display errors', () => {
    expect(getWalletSponsorshipDisplayError(
      new ApiServerError('disabled', 503, 'wallet_sponsorship_disabled'),
    )).toBe('$wallet_sponsorship_unavailable');
    expect(getWalletSponsorshipDisplayError(
      new ApiServerError('changed', 409, 'resource_conditions_changed'),
    )).toBe('$wallet_sponsorship_quote_changed');
    expect(getWalletSponsorshipDisplayError(
      new ApiServerError('authorization required', 401, 'wallet_access_required'),
    )).toBe('$wallet_prepaid_authorization_required');
  });
});
