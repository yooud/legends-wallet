import type { ApiCheckTransactionDraftResult } from '../../api/types';
import type { GlobalState } from '../types';

import { pick } from '../../util/iteratees';
import { replaceActivityId } from '../helpers/misc';
import { INITIAL_STATE } from '../initialState';
import { selectCurrentTransferMaxAmount, selectTokenMatchingCurrentTransferAddressSlow } from '../selectors';

export type TransferFeeDraft = {
  tokenSlug: string;
  toAddress: string;
  amount?: bigint;
  comment?: string;
  shouldEncrypt?: boolean;
  binPayload?: string;
  stateInit?: string;
};

export function updateCurrentTransferByCheckResult(global: GlobalState, result: ApiCheckTransactionDraftResult) {
  const nextGlobal = updateCurrentTransfer(global, {
    toAddressName: result.addressName,
    ...pick(result, [
      'isScam',
      'isMemoRequired',
      'diesel',
      'isToAddressNew',
      'resolvedAddress',
      'explainedFee',
      'sponsorship',
    ]),
  });
  return preserveMaxTransferAmount(global, nextGlobal);
}

export function updateCurrentTransfer(global: GlobalState, update: Partial<GlobalState['currentTransfer']>) {
  return {
    ...global,
    currentTransfer: {
      ...global.currentTransfer,
      ...update,
    },
  };
}

export function isSameTransferFeeDraft(
  current: GlobalState['currentTransfer'],
  draft: TransferFeeDraft,
) {
  return !current.nfts?.length
    && current.tokenSlug === draft.tokenSlug
    && current.toAddress === draft.toAddress
    && current.amount === draft.amount
    && normalizeOptionalString(current.comment) === normalizeOptionalString(draft.comment)
    && Boolean(current.shouldEncrypt) === Boolean(draft.shouldEncrypt)
    && normalizeOptionalString(current.binPayload) === normalizeOptionalString(draft.binPayload)
    && normalizeOptionalString(current.stateInit) === normalizeOptionalString(draft.stateInit);
}

export function clearCurrentTransfer(global: GlobalState) {
  return {
    ...global,
    currentTransfer: INITIAL_STATE.currentTransfer,
  };
}

/**
 * Preserves the maximum transfer amount, if it was selected.
 * Returns a modified version of `nextGlobal`.
 */
export function preserveMaxTransferAmount(prevGlobal: GlobalState, nextGlobal: GlobalState) {
  const previousMaxAmount = selectCurrentTransferMaxAmount(prevGlobal);
  const wasMaxAmountSelected = previousMaxAmount && prevGlobal.currentTransfer.amount === previousMaxAmount;
  if (!wasMaxAmountSelected) {
    return nextGlobal;
  }
  const nextMaxAmount = selectCurrentTransferMaxAmount(nextGlobal);
  return updateCurrentTransfer(nextGlobal, { amount: nextMaxAmount });
}

export function updateCurrentTransferLoading(global: GlobalState, isLoading: boolean): GlobalState {
  return {
    ...global,
    currentTransfer: {
      ...global.currentTransfer,
      isLoading,
    },
  };
}

export function setCurrentTransferAddress(global: GlobalState, toAddress: string | undefined) {
  global = updateCurrentTransfer(global, { toAddress });

  // Unless the user has filled the amount, the token should change to match the "to" address
  if (!global.currentTransfer.amount) {
    global = updateCurrentTransfer(global, {
      tokenSlug: selectTokenMatchingCurrentTransferAddressSlow(global),
    });
  }

  return global;
}

/** replaceMap: keys - old (removed) activity ids, value - new (added) activity ids */
export function replaceCurrentTransferId(global: GlobalState, replaceMap: Record<string, string>) {
  return updateCurrentTransfer(global, {
    txId: replaceActivityId(global.currentTransfer.txId, replaceMap),
  });
}

function normalizeOptionalString(value: string | undefined) {
  return value || undefined;
}
