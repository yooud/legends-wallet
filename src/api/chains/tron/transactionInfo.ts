import { TronWeb } from 'tronweb';

import type {
  ApiActivity, ApiFetchTransactionByIdOptions, ApiNetwork, ApiTransactionActivity,
} from '../../types';

import { SECOND } from '../../../util/dateFormat';
import isEmptyObject from '../../../util/isEmptyObject';
import { logDebugError } from '../../../util/logs';
import { getTronClient } from './util/tronweb';
import {
  getTrc20Transactions,
  parseRawTrc20ContractTransaction,
  parseRawTrc20Transaction,
  parseRawTrxTransaction,
} from './activities';
import {
  getCheckedWalletPrepaidTopupTransactionIds,
  getCheckedWalletSponsorshipTransactionIds,
  loadWalletSponsorshipActivityLinks,
  reconcileWalletSponsorshipActivities,
} from './sponsorship';

/**
 * Fetches transaction/trace info by hash or trace ID for deeplink viewing.
 * Returns all activities from a transaction, regardless of which wallet initiated it.
 * `walletAddress` is only used for determining the isIncoming perspective.
 * For TRON, `txId` is a transaction hash.
 */
export async function fetchTransactionById(
  { network, walletAddress, walletAccessToken, ...options }: ApiFetchTransactionByIdOptions,
): Promise<ApiActivity[]> {
  const isTxId = 'txId' in options;
  const txId = isTxId ? options.txId : options.txHash;

  try {
    const tronWeb = getTronClient(network);
    const sponsorshipLinksPromise = walletAddress && walletAccessToken
      ? getWalletSponsorshipLinksForTransaction(network, walletAddress, txId, walletAccessToken)
      : undefined;

    const [txResult, txInfoResult] = await Promise.all([
      tronWeb.trx.getTransaction(txId),
      tronWeb.trx.getTransactionInfo(txId),
    ]);

    if (!txResult || !txResult.raw_data) {
      return [];
    }

    if (!walletAddress) {
      const ownerAddressHex = txResult.raw_data.contract[0].parameter.value.owner_address;
      walletAddress = TronWeb.address.fromHex(ownerAddressHex);
    }

    const timestamp = txInfoResult.blockTimeStamp ?? txResult.raw_data.timestamp;
    if (!timestamp) return [];

    const fee = BigInt(txInfoResult.fee ?? 0);
    const status = getTransactionStatus(txResult, txInfoResult);
    const sponsorshipLinks = sponsorshipLinksPromise
      ? await sponsorshipLinksPromise
      : await loadWalletSponsorshipActivityLinks(network, walletAddress, [txId], false, walletAccessToken);

    const directTokenActivity = parseRawTrc20ContractTransaction(walletAddress, txResult, timestamp, status);
    if (directTokenActivity) {
      directTokenActivity.fee = fee;
      return reconcileWalletSponsorshipActivities(
        directTokenActivity.slug,
        [directTokenActivity],
        sponsorshipLinks,
        getCheckedWalletSponsorshipTransactionIds(network, walletAddress),
        getCheckedWalletPrepaidTopupTransactionIds(network, walletAddress),
      );
    }

    const contractType = txResult.raw_data.contract?.[0]?.type;
    if (String(contractType) === 'TriggerSmartContract' && !isEmptyObject(txInfoResult)) {
      const trc20Transactions = await getTrc20Transactions(network, walletAddress, {
        min_timestamp: timestamp - SECOND,
        max_timestamp: timestamp + SECOND,
      });

      const matchingTrc20Tx = trc20Transactions.find((tx) => tx.transaction_id === txId);

      if (matchingTrc20Tx) {
        const activity = parseRawTrc20Transaction(walletAddress, matchingTrc20Tx, status);
        activity.fee = fee;
        return reconcileWalletSponsorshipActivities(
          activity.slug,
          [activity],
          sponsorshipLinks,
          getCheckedWalletSponsorshipTransactionIds(network, walletAddress),
          getCheckedWalletPrepaidTopupTransactionIds(network, walletAddress),
        );
      }
    }

    const combinedTx = {
      ...txResult,
      txID: txResult.txID,
      raw_data: txResult.raw_data,
      energy_fee: txInfoResult.receipt?.energy_fee ?? 0,
      net_fee: txInfoResult.receipt?.net_fee ?? 0,
      block_timestamp: timestamp,
    };

    const activity = parseRawTrxTransaction(walletAddress, combinedTx);
    activity.status = status;
    return reconcileWalletSponsorshipActivities(
      activity.slug,
      [activity],
      sponsorshipLinks,
      getCheckedWalletSponsorshipTransactionIds(network, walletAddress),
      getCheckedWalletPrepaidTopupTransactionIds(network, walletAddress),
    );
  } catch (err) {
    logDebugError('fetchTransactionById', 'tron', err);
    return [];
  }
}

export function getTransactionStatus(txResult: any, txInfoResult: any): ApiTransactionActivity['status'] {
  if (
    !txInfoResult
    || isEmptyObject(txInfoResult)
    || (!Number(txInfoResult.blockNumber) && !Number(txInfoResult.blockTimeStamp))
  ) {
    return 'pending';
  }

  const infoResult = txInfoResult.result;
  if (infoResult === 1 || String(infoResult || '').toUpperCase() === 'FAILED') return 'failed';

  const receiptResult = txInfoResult.receipt?.result;
  if (
    receiptResult !== undefined
    && receiptResult !== 0
    && receiptResult !== 1
    && !['DEFAULT', 'SUCCESS'].includes(String(receiptResult).toUpperCase())
  ) {
    return 'failed';
  }

  const contractResult = String(txResult?.ret?.[0]?.contractRet || '').toUpperCase();
  if (contractResult && contractResult !== 'DEFAULT' && contractResult !== 'SUCCESS') return 'failed';

  return 'completed';
}

function getWalletSponsorshipLinksForTransaction(
  network: ApiNetwork,
  address: string,
  txId: string,
  walletAccessToken: string,
) {
  return loadWalletSponsorshipActivityLinks(network, address, [txId], true, walletAccessToken);
}
