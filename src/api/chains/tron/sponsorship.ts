import type { TronWeb, Types } from 'tronweb';

import type {
  ApiActivity,
  ApiNetwork,
  ApiSubmitGasfullTransferResult,
  ApiTransferSponsorship,
} from '../../types';
import { ApiTransactionDraftError } from '../../types';

import { BRILLIANT_API_BASE_URL, IS_LEGENDS_WALLET, TRX } from '../../../config';
import { fetchJson } from '../../../util/fetch';
import { ApiServerError } from '../../errors';

const SPONSORED_TRANSACTION_TTL_SECONDS = 600;
const SPONSORED_BROADCAST_TIMEOUT_MS = 275_000;
const SPONSORSHIP_LINKS_CACHE_MS = 5 * 60_000;
const SPONSORSHIP_LINKS_TIMEOUT_MS = 3_000;
const MAX_CACHED_QUOTES = 20;

type SponsorshipQuoteResponse = {
  ok: true;
  sponsored: true;
  payment_required: boolean;
  payment_mode: 'none' | 'direct' | 'prepaid';
  quote_id: string;
  expires_at: string;
  treasury_address: string;
  charge_sun: number;
  payment_charge_sun?: number;
  onchain_fee_sun: number;
  payment_network_fee_sun: number;
  activation_charge_sun?: number;
  transaction: Types.Transaction;
  prepaid_balance_sun?: number;
  prepaid_available_sun?: number;
  prepaid_insufficient?: boolean;
};

type SponsorshipBroadcastResponse = {
  ok: true;
  result: boolean;
  txid: string;
  quote_id?: string;
  payment_txid?: string;
  message?: string;
  code?: string;
};

export type WalletSponsorshipActivityLink = {
  quote_id: string;
  main_txid: string;
  payment_txid?: string;
  charge_sun?: number | string;
  service_fee_sun?: number | string;
  onchain_fee_sun?: number | string;
  purpose?: 'prepaid_topup';
};

type WalletSponsorshipActivityLinksResponse = {
  ok: true;
  links: WalletSponsorshipActivityLink[];
  checked_txids?: string[];
  purpose_checked_txids?: string[];
};

export type WalletSponsorshipIntent = {
  network: ApiNetwork;
  ownerAddress: string;
  toAddress: string;
  tokenAddress: string;
  amount: bigint;
};

type StoredSponsorshipQuote = {
  intent: WalletSponsorshipIntent;
  expiresAt: string;
  treasuryAddress: string;
  charge: bigint;
  paymentCharge: bigint;
  serviceFee: bigint;
  onchainFee: bigint;
  paymentRequired: boolean;
  isPrepaidInsufficient: boolean;
  transaction: Types.Transaction;
};

type SponsorshipLinksCacheEntry = {
  links: WalletSponsorshipActivityLink[];
  checkedTxids: Set<string>;
  prepaidTopupCheckedTxids: Set<string>;
  expiresAt: number;
};

const sponsorshipQuotes = new Map<string, StoredSponsorshipQuote>();
const sponsorshipLinksCache = new Map<string, SponsorshipLinksCacheEntry>();
const sponsorshipExactRequests = new Map<string, Promise<void>>();

function fetchWalletSponsorshipJson<T extends AnyLiteral>(
  network: ApiNetwork,
  endpoint: string,
  data?: Parameters<typeof fetchJson>[1],
  init?: RequestInit,
  options?: Parameters<typeof fetchJson>[3],
) {
  const url = getWalletSponsorshipUrl(network, endpoint);
  return fetchJson<T>(url, data, init, { ...options, bucketKey: url });
}

export async function requestWalletSponsorshipQuote(
  tronWeb: TronWeb,
  intent: WalletSponsorshipIntent,
  transaction: Types.Transaction,
  accessToken: string,
): Promise<ApiTransferSponsorship> {
  const extendedTransaction = await ensureSponsoredTransactionTtl(tronWeb, transaction);
  const result = await fetchWalletSponsorshipJson<SponsorshipQuoteResponse>(
    intent.network,
    'quote',
    undefined,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ address: intent.ownerAddress, transaction: extendedTransaction }),
    },
  );

  if (result.transaction.txID !== extendedTransaction.txID
    || result.transaction.raw_data_hex !== extendedTransaction.raw_data_hex) {
    throw new ApiServerError('Wallet sponsorship returned a different transaction', 502, 'invalid_quote');
  }

  pruneSponsorshipQuotes();
  const serviceFee = BigInt(result.charge_sun)
    + BigInt(result.payment_network_fee_sun)
    + BigInt(result.activation_charge_sun ?? 0);
  sponsorshipQuotes.set(result.quote_id, {
    intent,
    expiresAt: result.expires_at,
    treasuryAddress: result.treasury_address,
    charge: BigInt(result.charge_sun),
    paymentCharge: BigInt(result.payment_charge_sun ?? result.charge_sun),
    serviceFee,
    onchainFee: BigInt(result.onchain_fee_sun),
    paymentRequired: result.payment_required,
    isPrepaidInsufficient: Boolean(result.prepaid_insufficient),
    transaction: result.transaction,
  });

  return {
    id: result.quote_id,
    expiresAt: result.expires_at,
    serviceFee,
    onchainFee: BigInt(result.onchain_fee_sun),
    paymentMode: result.payment_mode,
    isPrepaidInsufficient: Boolean(result.prepaid_insufficient),
    prepaidBalance: result.prepaid_balance_sun !== undefined ? BigInt(result.prepaid_balance_sun) : undefined,
    prepaidAvailable: result.prepaid_available_sun !== undefined ? BigInt(result.prepaid_available_sun) : undefined,
  };
}

export async function submitWalletSponsoredTransfer(
  tronWeb: TronWeb,
  privateKey: string,
  sponsorshipId: string,
  intent: WalletSponsorshipIntent,
): Promise<ApiSubmitGasfullTransferResult | { error: string }> {
  const sponsorship = sponsorshipQuotes.get(sponsorshipId);
  if (!sponsorship || Date.parse(sponsorship.expiresAt) <= Date.now()
    || !areSponsorshipIntentsEqual(sponsorship.intent, intent)) {
    sponsorshipQuotes.delete(sponsorshipId);
    return { error: ApiTransactionDraftError.WalletSponsorshipQuoteChanged };
  }
  if (sponsorship.isPrepaidInsufficient) {
    return { error: 'WalletPrepaidInsufficient' };
  }

  const signedTransaction = await tronWeb.trx.sign(sponsorship.transaction, privateKey);
  let signedPayment: Awaited<ReturnType<typeof tronWeb.trx.sign>> | undefined;
  let paymentTxId = '';

  if (sponsorship.paymentRequired) {
    const payment = await tronWeb.transactionBuilder.sendTrx(
      sponsorship.treasuryAddress,
      Number(sponsorship.paymentCharge),
      intent.ownerAddress,
    );
    const extendedPayment = await ensureSponsoredTransactionTtl(tronWeb, payment);
    paymentTxId = extendedPayment.txID;
    signedPayment = await tronWeb.trx.sign(extendedPayment, privateKey);
  }

  rememberWalletSponsorshipActivityLink(intent.network, intent.ownerAddress, {
    quote_id: sponsorshipId,
    main_txid: signedTransaction.txID,
    payment_txid: paymentTxId,
    charge_sun: sponsorship.charge.toString(),
    service_fee_sun: sponsorship.serviceFee.toString(),
    onchain_fee_sun: sponsorship.onchainFee.toString(),
  });

  const result = await fetchWalletSponsorshipJson<SponsorshipBroadcastResponse>(
    intent.network,
    'broadcast',
    undefined,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quote_id: sponsorshipId,
        transaction: signedTransaction,
        payment_transaction: signedPayment,
      }),
    },
    { retries: 1, timeouts: SPONSORED_BROADCAST_TIMEOUT_MS },
  );
  if (!result.result) {
    return { error: result.message || result.code || 'UnsuccesfulTransfer' };
  }

  sponsorshipQuotes.delete(sponsorshipId);
  const sourceActionIds = [result.txid, result.payment_txid].filter((hash): hash is string => Boolean(hash));
  return {
    txId: result.txid,
    msgHashForCexSwap: result.txid,
    localActivityParams: {
      extra: {
        reconciliation: sourceActionIds.length > 1 ? {
          operationId: `wallet-sponsorship:${result.quote_id ?? sponsorshipId}`,
          sourceActionIds,
          hiddenSourceActionIds: result.payment_txid ? [result.payment_txid] : [],
          reason: 'wallet-sponsorship',
        } : undefined,
        walletSponsorship: {
          serviceFee: sponsorship.serviceFee,
          onchainFee: sponsorship.onchainFee,
        },
      },
    },
  };
}

export function getWalletSponsorshipDisplayError(error: ApiServerError) {
  const normalizedMessage = error.message.toLowerCase();

  if (error.code === 'insufficient_balance'
    || normalizedMessage.includes('insufficient token balance')
    || normalizedMessage.includes('insufficient trx balance')) {
    return ApiTransactionDraftError.InsufficientBalance;
  }
  if (error.code === 'wallet_access_required' || error.statusCode === 401) {
    return ApiTransactionDraftError.WalletPrepaidAuthorizationRequired;
  }
  if (error.code === 'wallet_sponsorship_disabled'
    || error.code === 'sponsorship_unavailable'
    || error.statusCode === 503
    || error.message.includes('wallet sponsorship is disabled')
    || error.message.includes('wallet sponsorship is not configured')) {
    return ApiTransactionDraftError.WalletSponsorshipUnavailable;
  }
  if (error.code === 'quote_expired'
    || error.code === 'quote_not_found'
    || error.code === 'resource_conditions_changed'
    || normalizedMessage.includes('resource conditions changed')
    || normalizedMessage.includes('sponsorship quote has expired')
    || normalizedMessage.includes('sponsorship quote was not found')) {
    return ApiTransactionDraftError.WalletSponsorshipQuoteChanged;
  }
  return undefined;
}

export function getCachedWalletSponsorshipActivityLinks(network: ApiNetwork, address: string) {
  return getValidSponsorshipCacheEntry(network, address)?.links ?? [];
}

export function getCheckedWalletSponsorshipTransactionIds(network: ApiNetwork, address: string) {
  return getValidSponsorshipCacheEntry(network, address)?.checkedTxids ?? new Set<string>();
}

export function getCheckedWalletPrepaidTopupTransactionIds(network: ApiNetwork, address: string) {
  return getValidSponsorshipCacheEntry(network, address)?.prepaidTopupCheckedTxids ?? new Set<string>();
}

export async function loadWalletSponsorshipActivityLinks(
  network: ApiNetwork,
  address: string,
  transactionIds?: string[],
  forceRefresh = false,
  accessToken?: string,
) {
  if (!IS_LEGENDS_WALLET || !accessToken) return [];
  if (transactionIds !== undefined) {
    const cacheKey = getSponsorshipCacheKey(network, address);
    const cached = getValidSponsorshipCacheEntry(network, address);
    const uniqueTxids = [...new Set(transactionIds)];
    const uncheckedTxids = forceRefresh
      ? uniqueTxids
      : uniqueTxids.filter((txid) => !cached?.checkedTxids.has(txid));
    if (!uncheckedTxids.length) return getCachedWalletSponsorshipActivityLinks(network, address);
    const requestKey = `${cacheKey}:${uncheckedTxids.slice().sort().join(',')}`;
    let request = sponsorshipExactRequests.get(requestKey);
    if (!request) {
      request = fetchWalletSponsorshipJson<WalletSponsorshipActivityLinksResponse>(
        network,
        'activity-links',
        { address, txids: uncheckedTxids.join(',') },
        { headers: { Authorization: `Bearer ${accessToken}` } },
        { retries: 1, timeouts: SPONSORSHIP_LINKS_TIMEOUT_MS },
      ).then(({
        links,
        checked_txids: checkedTxids = uncheckedTxids,
        purpose_checked_txids: purposeCheckedTxids = [],
      }) => {
        const latest = getValidSponsorshipCacheEntry(network, address);
        sponsorshipLinksCache.set(cacheKey, {
          links: mergeActivityLinks(latest?.links ?? [], links ?? []),
          checkedTxids: new Set([...(latest?.checkedTxids ?? []), ...checkedTxids]),
          prepaidTopupCheckedTxids: new Set([
            ...(latest?.prepaidTopupCheckedTxids ?? []),
            ...purposeCheckedTxids,
          ]),
          expiresAt: Date.now() + SPONSORSHIP_LINKS_CACHE_MS,
        });
      }).catch(() => {
        // Transaction details remain available when Wallet metadata is temporarily unavailable.
      }).finally(() => {
        sponsorshipExactRequests.delete(requestKey);
      });
      sponsorshipExactRequests.set(requestKey, request);
    }
    await request;
    return getCachedWalletSponsorshipActivityLinks(network, address);
  }
  return getCachedWalletSponsorshipActivityLinks(network, address);
}

export function rememberWalletSponsorshipActivityLink(
  network: ApiNetwork,
  address: string,
  link: WalletSponsorshipActivityLink,
) {
  const cacheKey = getSponsorshipCacheKey(network, address);
  const cached = getValidSponsorshipCacheEntry(network, address);
  sponsorshipLinksCache.set(cacheKey, {
    links: mergeActivityLinks([link], cached?.links ?? []),
    checkedTxids: new Set([
      ...(cached?.checkedTxids ?? []),
      ...[link.main_txid, link.payment_txid].filter((txId): txId is string => Boolean(txId)),
    ]),
    prepaidTopupCheckedTxids: new Set([
      ...(cached?.prepaidTopupCheckedTxids ?? []),
      ...(link.purpose === 'prepaid_topup' ? [link.main_txid] : []),
    ]),
    expiresAt: Date.now() + SPONSORSHIP_LINKS_CACHE_MS,
  });
}

export function reconcileWalletSponsorshipActivities(
  slug: string,
  activities: ApiActivity[],
  links: WalletSponsorshipActivityLink[],
  checkedTxids: Set<string> = new Set<string>(),
  prepaidTopupCheckedTxids: Set<string> = new Set<string>(),
): ApiActivity[] {
  const paymentIds = new Set(links.map(({ payment_txid: paymentTxId }) => paymentTxId).filter(Boolean));
  const linksByMainId = new Map(links.map((link) => [link.main_txid, link]));
  return activities.map((activity) => {
    if (slug === TRX.slug && paymentIds.has(activity.id)) return { ...activity, shouldHide: true };

    const link = linksByMainId.get(activity.id);
    if (!link || activity.kind !== 'transaction') {
      return checkedTxids.has(activity.id) && activity.kind === 'transaction'
        ? {
          ...activity,
          extra: {
            ...activity.extra,
            walletSponsorshipChecked: true,
            ...(prepaidTopupCheckedTxids.has(activity.id) && { walletPrepaidTopupChecked: true as const }),
          },
        }
        : activity;
    }
    const serviceFeeValue = link.service_fee_sun ?? link.charge_sun;
    const serviceFee = serviceFeeValue !== undefined ? BigInt(serviceFeeValue) : undefined;
    const onchainFee = link.onchain_fee_sun !== undefined ? BigInt(link.onchain_fee_sun) : serviceFee;
    const walletSponsorship = serviceFee !== undefined && onchainFee !== undefined
      ? { serviceFee, onchainFee }
      : undefined;
    return {
      ...activity,
      fee: serviceFee ?? activity.fee,
      extra: {
        ...activity.extra,
        walletSponsorshipChecked: true,
        ...((prepaidTopupCheckedTxids.has(activity.id) || link.purpose === 'prepaid_topup')
          && { walletPrepaidTopupChecked: true as const }),
        ...(walletSponsorship && { walletSponsorship }),
        ...(link.purpose === 'prepaid_topup' && { walletPrepaidTopup: true as const }),
        reconciliation: {
          operationId: `wallet-sponsorship:${link.quote_id}`,
          sourceActionIds: [link.main_txid, link.payment_txid].filter(Boolean),
          hiddenSourceActionIds: link.payment_txid ? [link.payment_txid] : [],
          reason: 'wallet-sponsorship',
        },
      },
    };
  });
}

export async function ensureSponsoredTransactionTtl(tronWeb: TronWeb, transaction: Types.Transaction) {
  const timestamp = Number(transaction.raw_data?.timestamp || 0);
  const expiration = Number(transaction.raw_data?.expiration || 0);
  const currentLifetimeSeconds = timestamp > 0 && expiration > timestamp
    ? Math.ceil((expiration - timestamp) / 1000)
    : 0;
  const extensionSeconds = Math.max(SPONSORED_TRANSACTION_TTL_SECONDS - currentLifetimeSeconds, 0);

  return extensionSeconds > 0
    ? tronWeb.transactionBuilder.extendExpiration(transaction, extensionSeconds)
    : transaction;
}

function getWalletSponsorshipUrl(network: ApiNetwork, endpoint: string) {
  const networkPrefix = network === 'testnet' ? '/testnet' : '';
  return `${BRILLIANT_API_BASE_URL}${networkPrefix}/wallet-sponsorship/${endpoint}`;
}

function getSponsorshipCacheKey(network: ApiNetwork, address: string) {
  return `${network}:${address}`;
}

function getValidSponsorshipCacheEntry(network: ApiNetwork, address: string) {
  const cacheKey = getSponsorshipCacheKey(network, address);
  const cached = sponsorshipLinksCache.get(cacheKey);
  if (cached && cached.expiresAt <= Date.now()) {
    sponsorshipLinksCache.delete(cacheKey);
    return undefined;
  }
  return cached;
}

function areSponsorshipIntentsEqual(a: WalletSponsorshipIntent, b: WalletSponsorshipIntent) {
  return a.network === b.network
    && a.ownerAddress === b.ownerAddress
    && a.toAddress === b.toAddress
    && a.tokenAddress === b.tokenAddress
    && a.amount === b.amount;
}

function mergeActivityLinks(
  priorityLinks: WalletSponsorshipActivityLink[],
  otherLinks: WalletSponsorshipActivityLink[],
) {
  const result = new Map(otherLinks.map((link) => [link.quote_id, link]));
  priorityLinks.forEach((link) => {
    result.set(link.quote_id, { ...result.get(link.quote_id), ...link });
  });
  return [...result.values()];
}

function pruneSponsorshipQuotes() {
  const now = Date.now();
  for (const [id, quote] of sponsorshipQuotes) {
    if (Date.parse(quote.expiresAt) <= now) sponsorshipQuotes.delete(id);
  }
  while (sponsorshipQuotes.size >= MAX_CACHED_QUOTES) {
    sponsorshipQuotes.delete(sponsorshipQuotes.keys().next().value!);
  }
}
