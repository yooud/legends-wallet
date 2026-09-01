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
const SPONSORSHIP_LINKS_CACHE_MS = 5_000;
const SPONSORSHIP_LINKS_TIMEOUT_MS = 3_000;
const MAX_CACHED_QUOTES = 20;

type SponsorshipQuoteResponse = {
  ok: true;
  sponsored: true;
  payment_required: boolean;
  quote_id: string;
  expires_at: string;
  treasury_address: string;
  charge_sun: number;
  onchain_fee_sun: number;
  payment_network_fee_sun: number;
  transaction: Types.Transaction;
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
  payment_txid: string;
  charge_sun: number | string;
  service_fee_sun?: number | string;
  onchain_fee_sun?: number | string;
};

type WalletSponsorshipActivityLinksResponse = {
  ok: true;
  links: WalletSponsorshipActivityLink[];
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
  serviceFee: bigint;
  onchainFee: bigint;
  paymentRequired: boolean;
  transaction: Types.Transaction;
};

type SponsorshipLinksCacheEntry = {
  links: WalletSponsorshipActivityLink[];
  expiresAt: number;
  request?: Promise<void>;
};

const sponsorshipQuotes = new Map<string, StoredSponsorshipQuote>();
const sponsorshipLinksCache = new Map<string, SponsorshipLinksCacheEntry>();

export async function requestWalletSponsorshipQuote(
  tronWeb: TronWeb,
  intent: WalletSponsorshipIntent,
  transaction: Types.Transaction,
): Promise<ApiTransferSponsorship> {
  const extendedTransaction = await ensureSponsoredTransactionTtl(tronWeb, transaction);
  const result = await fetchJson<SponsorshipQuoteResponse>(
    getWalletSponsorshipUrl(intent.network, 'quote'),
    undefined,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: extendedTransaction }),
    },
  );

  if (result.transaction.txID !== extendedTransaction.txID
    || result.transaction.raw_data_hex !== extendedTransaction.raw_data_hex) {
    throw new ApiServerError('Wallet sponsorship returned a different transaction', 502, 'invalid_quote');
  }

  pruneSponsorshipQuotes();
  const serviceFee = BigInt(result.charge_sun) + BigInt(result.payment_network_fee_sun);
  sponsorshipQuotes.set(result.quote_id, {
    intent,
    expiresAt: result.expires_at,
    treasuryAddress: result.treasury_address,
    charge: BigInt(result.charge_sun),
    serviceFee,
    onchainFee: BigInt(result.onchain_fee_sun),
    paymentRequired: result.payment_required,
    transaction: result.transaction,
  });

  return {
    id: result.quote_id,
    expiresAt: result.expires_at,
    serviceFee,
    onchainFee: BigInt(result.onchain_fee_sun),
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

  const signedTransaction = await tronWeb.trx.sign(sponsorship.transaction, privateKey);
  let signedPayment: Awaited<ReturnType<typeof tronWeb.trx.sign>> | undefined;
  let paymentTxId = '';

  if (sponsorship.paymentRequired) {
    const payment = await tronWeb.transactionBuilder.sendTrx(
      sponsorship.treasuryAddress,
      Number(sponsorship.charge),
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

  const result = await fetchJson<SponsorshipBroadcastResponse>(
    getWalletSponsorshipUrl(intent.network, 'broadcast'),
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
    localActivityParams: sourceActionIds.length > 1 ? {
      extra: {
        reconciliation: {
          operationId: `wallet-sponsorship:${result.quote_id ?? sponsorshipId}`,
          sourceActionIds,
          hiddenSourceActionIds: result.payment_txid ? [result.payment_txid] : [],
          reason: 'wallet-sponsorship',
        },
        walletSponsorship: {
          serviceFee: sponsorship.serviceFee,
          onchainFee: sponsorship.onchainFee,
        },
      },
    } : undefined,
  };
}

export function getWalletSponsorshipDisplayError(error: ApiServerError) {
  if (error.code === 'wallet_sponsorship_disabled'
    || error.code === 'sponsorship_unavailable'
    || error.statusCode === 503
    || error.message.includes('wallet sponsorship is disabled')
    || error.message.includes('wallet sponsorship is not configured')) {
    return ApiTransactionDraftError.WalletSponsorshipUnavailable;
  }
  if (error.code === 'validation_error'
    || error.code === 'quote_expired'
    || error.code === 'quote_not_found'
    || error.code === 'resource_conditions_changed') {
    return ApiTransactionDraftError.WalletSponsorshipQuoteChanged;
  }
  return undefined;
}

export function getCachedWalletSponsorshipActivityLinks(network: ApiNetwork, address: string) {
  return sponsorshipLinksCache.get(getSponsorshipCacheKey(network, address))?.links ?? [];
}

export function refreshWalletSponsorshipActivityLinks(network: ApiNetwork, address: string) {
  if (!IS_LEGENDS_WALLET) return;

  const cacheKey = getSponsorshipCacheKey(network, address);
  const now = Date.now();
  const cached = sponsorshipLinksCache.get(cacheKey);
  if (cached?.request || (cached?.expiresAt ?? 0) > now) return;

  const request = fetchJson<WalletSponsorshipActivityLinksResponse>(
    getWalletSponsorshipUrl(network, 'activity-links'),
    { address },
    undefined,
    { retries: 1, timeouts: SPONSORSHIP_LINKS_TIMEOUT_MS },
  ).then(({ links }) => {
    const latest = sponsorshipLinksCache.get(cacheKey);
    sponsorshipLinksCache.set(cacheKey, {
      links: mergeActivityLinks(latest?.links ?? [], links ?? []),
      expiresAt: Date.now() + SPONSORSHIP_LINKS_CACHE_MS,
    });
  }).catch(() => {
    const latest = sponsorshipLinksCache.get(cacheKey);
    sponsorshipLinksCache.set(cacheKey, {
      links: latest?.links ?? [],
      expiresAt: Date.now() + SPONSORSHIP_LINKS_CACHE_MS,
    });
  });

  sponsorshipLinksCache.set(cacheKey, {
    links: cached?.links ?? [],
    expiresAt: cached?.expiresAt ?? 0,
    request,
  });
}

export function rememberWalletSponsorshipActivityLink(
  network: ApiNetwork,
  address: string,
  link: WalletSponsorshipActivityLink,
) {
  const cacheKey = getSponsorshipCacheKey(network, address);
  const cached = sponsorshipLinksCache.get(cacheKey);
  sponsorshipLinksCache.set(cacheKey, {
    links: mergeActivityLinks([link], cached?.links ?? []),
    expiresAt: Date.now() + SPONSORSHIP_LINKS_CACHE_MS,
    request: cached?.request,
  });
}

export function reconcileWalletSponsorshipActivities(
  slug: string,
  activities: ApiActivity[],
  links: WalletSponsorshipActivityLink[],
): ApiActivity[] {
  if (!links.length) return activities;
  if (slug === TRX.slug) {
    const paymentIds = new Set(links.map(({ payment_txid: paymentTxId }) => paymentTxId));
    return activities.map((activity) => paymentIds.has(activity.id)
      ? { ...activity, shouldHide: true }
      : activity);
  }

  const linksByMainId = new Map(links.map((link) => [link.main_txid, link]));
  return activities.map((activity) => {
    const link = linksByMainId.get(activity.id);
    if (!link || activity.kind !== 'transaction') return activity;
    const serviceFee = BigInt(link.service_fee_sun ?? link.charge_sun);
    const onchainFee = BigInt(link.onchain_fee_sun ?? serviceFee);
    return {
      ...activity,
      fee: serviceFee,
      extra: {
        ...activity.extra,
        walletSponsorship: {
          serviceFee,
          onchainFee,
        },
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

async function ensureSponsoredTransactionTtl(tronWeb: TronWeb, transaction: Types.Transaction) {
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
  priorityLinks.forEach((link) => result.set(link.quote_id, link));
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
