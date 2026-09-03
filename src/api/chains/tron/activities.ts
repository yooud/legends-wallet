import { TronWeb } from 'tronweb';

import type { ApiActivity, ApiFetchActivitySliceOptions, ApiNetwork, ApiTransactionActivity } from '../../types';
import { TronContractMethodSignature } from './types';

import { TRX } from '../../../config';
import { parseAccountId } from '../../../util/account';
import { mergeSortedActivities, sortActivities } from '../../../util/activities/order';
import { bucketKey } from '../../../util/circuit-breaker';
import { fetchJson } from '../../../util/fetch';
import isEmptyObject from '../../../util/isEmptyObject';
import { buildCollectionByKey } from '../../../util/iteratees';
import { getTokenSlugs } from './util/tokens';
import { fetchStoredWallet } from '../../common/accounts';
import { updateActivityMetadata } from '../../common/helpers';
import { buildTokenSlug, getTokenBySlug } from '../../common/tokens';
import { SEC } from '../../constants';
import { ApiServerError } from '../../errors';
import { NETWORK_CONFIG } from './constants';
import {
  getCheckedWalletSponsorshipTransactionIds,
  loadWalletSponsorshipActivityLinks,
  reconcileWalletSponsorshipActivities,
} from './sponsorship';

export async function fetchActivitySlice({
  accountId,
  tokenSlug,
  toTimestamp,
  fromTimestamp,
  limit,
}: ApiFetchActivitySliceOptions): Promise<ApiActivity[]> {
  const { network } = parseAccountId(accountId);
  const { address } = await fetchStoredWallet(accountId, 'tron');

  if (tokenSlug) {
    const { activities } = await getTokenActivitySlice(
      network,
      address,
      tokenSlug,
      toTimestamp,
      fromTimestamp,
      limit,
    );
    return activities;
  } else {
    return getAllActivitySlice(
      network,
      address,
      toTimestamp,
      fromTimestamp,
      limit,
    );
  }
}

export async function getTokenActivitySlice(
  network: ApiNetwork,
  address: string,
  slug: string,
  toTimestamp?: number,
  fromTimestamp?: number,
  limit?: number,
): Promise<{ activities: ApiActivity[]; hasMore: boolean }> {
  let activities: ApiActivity[];
  let rawCount: number;

  if (slug === TRX.slug) {
    const rawTransactions = await getTrxTransactions(network, address, {
      min_timestamp: fromTimestamp ? fromTimestamp + SEC : undefined,
      max_timestamp: toTimestamp ? toTimestamp - SEC : undefined,
      limit,
      search_internal: false, // The parsing is not supported and not needed currently
    });
    const sponsorshipLinks = await loadWalletSponsorshipActivityLinks(
      network,
      address,
      getHistoryTransactionIds(rawTransactions),
    );
    rawCount = rawTransactions.length;
    activities = reconcileWalletSponsorshipActivities(
      slug,
      rawTransactions.map((rawTx) => parseRawTrxTransaction(address, rawTx)),
      sponsorshipLinks,
      getCheckedWalletSponsorshipTransactionIds(network, address),
    )
      .filter((activity) => !activity.shouldHide);
  } else {
    const { tokenAddress } = getTokenBySlug(slug) || {};
    const rawTransactions = await getTrc20Transactions(network, address, {
      contract_address: tokenAddress,
      min_timestamp: fromTimestamp ? fromTimestamp + SEC : undefined,
      max_timestamp: toTimestamp ? toTimestamp - SEC : undefined,
      limit,
    });
    const sponsorshipLinks = await loadWalletSponsorshipActivityLinks(
      network,
      address,
      getHistoryTransactionIds(rawTransactions),
    );
    rawCount = rawTransactions.length;
    activities = reconcileWalletSponsorshipActivities(
      slug,
      rawTransactions.map((rawTx) => parseRawTrc20Transaction(address, rawTx)),
      sponsorshipLinks,
      getCheckedWalletSponsorshipTransactionIds(network, address),
    );
  }

  // `hasMore` is derived from the raw API response length (before `shouldHide` filtering),
  // so cursor-style pagination keeps advancing even when a page contains nothing but hidden
  // TRC10/transfer noise — otherwise the chain would be wrongly reported as exhausted while
  // older history still exists upstream.
  const hasMore = limit !== undefined && rawCount >= limit;

  // Even though the activities returned by the Tron API are sorted by timestamp, our sorting may differ.
  // It's important to enforce our sorting, because otherwise `mergeSortedActivities` may leave duplicates.
  return { activities: sortActivities(activities), hasMore };
}

async function getAllActivitySlice(
  network: ApiNetwork,
  address: string,
  toTimestamp?: number,
  fromTimestamp?: number,
  limit?: number,
) {
  const tokenSlugs = getTokenSlugs(network);
  const txsBySlug: Record<string, ApiActivity[]> = {};

  await Promise.all(tokenSlugs.map(async (slug) => {
    const { activities: txs } = await getTokenActivitySlice(
      network, address, slug, toTimestamp, fromTimestamp, limit,
    );

    if (txs.length) {
      txsBySlug[slug] = txs;
    }
  }));

  if (isEmptyObject(txsBySlug)) {
    return [];
  }

  // TODO Нужно, чтобы чанки всегда именли "все транзакции", так как это всё работает только при корректной работе лимита.
  // А только потом должна быть очистка от ненужных транзакций.
  const mainChunk = Object.values(txsBySlug).reduce((prevChunk, chunk) => {
    if (prevChunk.length > chunk.length) return prevChunk;
    if (prevChunk.length < chunk.length) return chunk;
    if (prevChunk[prevChunk.length - 1].timestamp < chunk[chunk.length - 1].timestamp) return chunk;
    return prevChunk;
  }, [] as ApiTransactionActivity[]);

  const oldestTimestamp = mainChunk[mainChunk.length - 1].timestamp;

  return mergeActivities(txsBySlug)
    .filter(({ timestamp }) => timestamp >= oldestTimestamp);
}

async function getTrxTransactions(
  network: ApiNetwork,
  address: string,
  queryParams: {
    only_confirmed?: boolean;
    only_unconfirmed?: boolean;
    only_to?: boolean;
    only_from?: boolean;
    limit?: number;
    fingerprint?: string;
    order_by?: 'block_timestamp,asc' | 'block_timestamp,desc';
    min_timestamp?: number;
    max_timestamp?: number;
    search_internal?: boolean;
  } = {},
): Promise<any[]> {
  const baseUrl = NETWORK_CONFIG[network].historyApiUrl;
  const url = new URL(`${baseUrl}/v1/accounts/${address}/transactions`);

  const result = await fetchHistoryJson(network, url, queryParams);

  return result.data;
}

function isTokenTransferTransaction(rawTx: any): boolean {
  const rawData = rawTx.raw_data;
  if (!rawData?.contract?.[0]) return false;

  const contract = rawData.contract[0];
  if (contract.type !== 'TriggerSmartContract') return false;

  const data = contract.parameter?.value?.data;
  if (!data) return false;

  return data.startsWith(TronContractMethodSignature.Transfer)
    || data.startsWith(TronContractMethodSignature.TransferFrom);
}

export function parseRawTrxTransaction(address: string, rawTx: any): ApiTransactionActivity {
  const {
    raw_data: rawData,
    txID: txId,
    block_timestamp: timestamp,
  } = rawTx;

  const parameters = rawData.contract[0].parameter.value;
  const amount = BigInt(parameters.amount ?? 0);
  const fromAddress = TronWeb.address.fromHex(parameters.owner_address);
  const toAddress = TronWeb.address.fromHex(
    parameters.to_address || parameters.receiver_address || parameters.contract_address,
  );

  const slug = TRX.slug;
  const isIncoming = toAddress === address;
  const normalizedAddress = isIncoming ? fromAddress : toAddress;
  const fee = BigInt(rawTx.ret?.[0].fee ?? 0);
  const type = rawData.contract[0].type === 'TriggerSmartContract' ? 'callContract' : undefined;
  const shouldHide = rawData.contract[0].type === 'TransferAssetContract' || isTokenTransferTransaction(rawTx);

  return updateActivityMetadata({
    id: txId,
    kind: 'transaction',
    timestamp,
    fromAddress,
    toAddress,
    amount: isIncoming ? amount : -amount,
    slug,
    isIncoming,
    normalizedAddress,
    fee,
    type,
    shouldHide,
    extra: getWalletHistoryMetadata(rawTx),
    status: getRawTransactionStatus(rawTx),
  });
}

export function parseRawTrc20ContractTransaction(
  walletAddress: string,
  rawTx: any,
  timestamp: number,
  status: ApiTransactionActivity['status'] = 'completed',
): ApiTransactionActivity | undefined {
  const contract = rawTx.raw_data?.contract?.[0];
  if (contract?.type !== 'TriggerSmartContract') return undefined;

  const parameters = contract.parameter?.value;
  const data = String(parameters?.data || '').replace(/^0x/, '').toLowerCase();
  const method = data.slice(0, 8) as TronContractMethodSignature;
  let fromAddress: string;
  let toAddress: string;
  let value: string;

  if (method === TronContractMethodSignature.Transfer && data.length >= 136) {
    fromAddress = TronWeb.address.fromHex(parameters.owner_address);
    toAddress = decodeTronAddress(data.slice(8, 72));
    value = BigInt(`0x${data.slice(72, 136)}`).toString();
  } else if (method === TronContractMethodSignature.TransferFrom && data.length >= 200) {
    fromAddress = decodeTronAddress(data.slice(8, 72));
    toAddress = decodeTronAddress(data.slice(72, 136));
    value = BigInt(`0x${data.slice(136, 200)}`).toString();
  } else {
    return undefined;
  }

  return parseRawTrc20Transaction(walletAddress, {
    transaction_id: rawTx.txID,
    block_timestamp: timestamp,
    from: fromAddress,
    to: toAddress,
    value,
    token_info: {
      address: TronWeb.address.fromHex(parameters.contract_address),
    },
    legends_energy: rawTx.legends_energy,
  }, status);
}

export async function getTrc20Transactions(
  network: ApiNetwork,
  address: string,
  queryParams: {
    only_confirmed?: boolean;
    only_unconfirmed?: boolean;
    limit?: number;
    fingerprint?: string;
    order_by?: 'block_timestamp,asc' | 'block_timestamp,desc';
    min_timestamp?: number;
    max_timestamp?: number;
    contract_address?: string;
    only_to?: boolean;
    only_from?: boolean;
  } = {},
): Promise<any[]> {
  const baseUrl = NETWORK_CONFIG[network].historyApiUrl;
  const url = new URL(`${baseUrl}/v1/accounts/${address}/transactions/trc20`);

  const result = await fetchHistoryJson(network, url, queryParams);

  return result.data;
}

function getHistoryRequestInit(network: ApiNetwork): RequestInit | undefined {
  const { historyApiKey } = NETWORK_CONFIG[network];
  return historyApiKey ? { headers: { 'TRON-PRO-API-KEY': historyApiKey } } : undefined;
}

async function fetchHistoryJson(
  network: ApiNetwork,
  url: URL,
  queryParams: Parameters<typeof fetchJson>[1],
): Promise<{ data: any[] }> {
  const requestInit = getHistoryRequestInit(network);
  const options = { bucketKey: bucketKey(url, { includePathPrefix: true }) };

  try {
    return await fetchJson(url.toString(), queryParams, requestInit, options);
  } catch (error) {
    const isRejectedApiKey = requestInit
      && error instanceof ApiServerError
      && (error.statusCode === 401 || error.statusCode === 403);
    if (!isRejectedApiKey) throw error;

    return fetchJson(url.toString(), queryParams, undefined, options);
  }
}

export function parseRawTrc20Transaction(
  address: string,
  rawTx: any,
  status: ApiTransactionActivity['status'] = 'completed',
): ApiTransactionActivity {
  const {
    transaction_id: txId,
    block_timestamp: timestamp,
    from: fromAddress,
    to: toAddress,
    value,
    token_info: tokenInfo,
  } = rawTx;

  const amount = BigInt(value);
  const slug = buildTokenSlug(TRX.chain, tokenInfo.address);
  const isIncoming = toAddress === address;
  const normalizedAddress = isIncoming ? fromAddress : toAddress;
  const fee = 0n;

  return updateActivityMetadata({
    id: txId,
    kind: 'transaction',
    timestamp,
    fromAddress,
    toAddress,
    amount: isIncoming ? amount : -amount,
    slug,
    isIncoming,
    normalizedAddress,
    fee,
    extra: getWalletHistoryMetadata(rawTx),
    status,
  });
}

function getRawTransactionStatus(rawTx: any): ApiTransactionActivity['status'] {
  const contractResult = String(rawTx?.ret?.[0]?.contractRet || '').toUpperCase();
  return contractResult && contractResult !== 'SUCCESS' && contractResult !== 'DEFAULT'
    ? 'failed'
    : 'completed';
}

function getWalletHistoryMetadata(rawTransaction: any): ApiTransactionActivity['extra'] {
  return rawTransaction?.legends_energy?.wallet_sponsorship_checked
    ? { walletSponsorshipChecked: true }
    : undefined;
}

function getHistoryTransactionIds(rawTransactions: any[]) {
  return [...new Set(rawTransactions
    .map((transaction) => String(transaction?.transaction_id || transaction?.txID || '').trim().toLowerCase())
    .filter((txId) => txId.length === 64))];
}

function decodeTronAddress(word: string) {
  return TronWeb.address.fromHex(`41${word.slice(-40)}`);
}

export function mergeActivities(txsBySlug: Record<string, ApiActivity[]>): ApiActivity[] {
  const seenTxIds = new Set<string>();
  const isSeenTxId = (id: string) => {
    if (seenTxIds.has(id)) return true;
    seenTxIds.add(id);
    return false;
  };

  const {
    [TRX.slug]: trxTxs = [],
    ...tokenTxs
  } = txsBySlug;

  const trxTxById = buildCollectionByKey(trxTxs, 'id');

  return mergeSortedActivities(
    ...Object.values(tokenTxs).map((tokenTxList) =>
      tokenTxList
        // Different tokens have the same transaction id if they share the same backend swap.
        // The duplicates need to removed.
        .filter((tokenTx) => !isSeenTxId(tokenTx.id))
        .map((tokenTx) => {
          const trxTx = trxTxById[tokenTx.id];
          if (tokenTx.kind === 'transaction' && trxTx?.kind === 'transaction') {
            tokenTx.fee = trxTx.fee;
          }
          return tokenTx;
        }),
    ),
    // Because of `isSeenTxId`, it's necessary to filter the TRX transactions after the token transactions
    trxTxs.filter(
      (trxTx) => !isSeenTxId(trxTx.id) && !trxTx.shouldHide && (trxTx.kind !== 'transaction' || trxTx.toAddress),
    ),
  );
}

export function fetchActivityDetails() {
  return undefined;
}
