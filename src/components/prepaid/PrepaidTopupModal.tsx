import React, { memo, useEffect, useMemo, useState } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { ApiBaseCurrency, ApiWalletPrepaidOverview, ApiWalletPrepaidTopupAsset } from '../../api/types';
import type { UserToken } from '../../global/types';

import { selectAccountTokens } from '../../global/selectors';
import buildClassName from '../../util/buildClassName';
import { fromDecimal, toDecimal } from '../../util/decimals';
import { stopEvent } from '../../util/domEvents';
import { callApiWithThrow } from '../../api';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';
import { useAmountInputState } from '../ui/hooks/useAmountInputState';

import AmountInput from '../ui/AmountInput';
import Button from '../ui/Button';
import InteractiveTextField from '../ui/InteractiveTextField';
import Modal from '../ui/Modal';
import ModalHeader from '../ui/ModalHeader';
import PasswordForm from '../ui/PasswordForm';

import transferStyles from '../transfer/Transfer.module.scss';
import modalStyles from '../ui/Modal.module.scss';
import styles from './PrepaidTopupModal.module.scss';

interface OwnProps {
  isOpen: boolean;
  accountId: string;
  onClose: NoneToVoidFunction;
  onSuccess: NoneToVoidFunction;
}

interface StateProps {
  tokens?: UserToken[];
  baseCurrency: ApiBaseCurrency;
  isSensitiveDataHidden?: true;
}

function PrepaidTopupModal({
  isOpen,
  accountId,
  onClose,
  onSuccess,
  tokens,
  baseCurrency,
  isSensitiveDataHidden,
}: OwnProps & StateProps) {
  const { releaseEnclaveSession } = getActions();
  const lang = useLang();
  const [overview, setOverview] = useState<ApiWalletPrepaidOverview>();
  const [tokenSlug, setTokenSlug] = useState<string>();
  const [amount, setAmount] = useState<bigint>();
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const topupTokens = useMemo(() => tokens?.filter((token) => (
    token.chain === 'tron'
    && overview?.topup_assets.some((asset) => doesTokenMatchAsset(token, asset))
  )) ?? [], [overview?.topup_assets, tokens]);
  const selectedToken = useMemo(
    () => topupTokens.find((token) => token.slug === tokenSlug) ?? topupTokens[0],
    [tokenSlug, topupTokens],
  );
  const selectedAsset = useMemo(
    () => overview?.topup_assets.find((asset) => selectedToken && doesTokenMatchAsset(selectedToken, asset)),
    [overview?.topup_assets, selectedToken],
  );
  const isAmountAboveBalance = amount !== undefined && selectedToken !== undefined && amount > selectedToken.amount;
  const isBelowMinimum = getIsBelowMinimum(amount, selectedToken, selectedAsset);

  const amountInputProps = useAmountInputState({
    amount,
    token: selectedToken,
    baseCurrency,
    onAmountChange: setAmount,
    onTokenChange: setTokenSlug,
  });

  useEffect(() => {
    if (!isOpen) return;
    setOverview(undefined);
    setTokenSlug(undefined);
    setAmount(undefined);
    setIsAuthorizing(false);
    setError('');
    void callApiWithThrow('fetchWalletPrepaidOverview', accountId).then(setOverview).catch((loadError) => {
      setError(getErrorText(loadError));
    });
  }, [accountId, isOpen]);

  useEffect(() => {
    if (selectedToken && selectedToken.slug !== tokenSlug) {
      setTokenSlug(selectedToken.slug);
    }
  }, [selectedToken, tokenSlug]);

  const continueTopup = useLastCallback(() => {
    const isIncomplete = !overview?.enabled || !overview.deposit_address || !selectedToken || !selectedAsset;
    if (isIncomplete || !amount || amount <= 0n) {
      setError(lang('$prepaid_invalid_amount'));
      return;
    }
    if (isAmountAboveBalance) {
      setError(lang('Insufficient balance'));
      return;
    }
    if (isBelowMinimum) {
      setError(lang('$prepaid_minimum_value', { amount: selectedAsset.minimum_usdt }) as string);
      return;
    }
    setError('');
    setIsAuthorizing(true);
  });

  const handleSubmit = useLastCallback((event: React.FormEvent) => {
    stopEvent(event);
    continueTopup();
  });

  const authorize = useLastCallback(async (enclaveToken: string) => {
    if (!selectedToken || !amount) {
      releaseEnclaveSession({ enclaveToken });
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      const result = await callApiWithThrow(
        'topUpWalletPrepaid', accountId, enclaveToken, selectedToken.slug, amount,
      );
      if (result && 'error' in result) throw new Error(result.error);
      onSuccess();
      onClose();
    } catch (topupError) {
      setError(getErrorText(topupError));
    } finally {
      setIsLoading(false);
      releaseEnclaveSession({ enclaveToken });
    }
  });

  const handleClear = useLastCallback(() => {
    setAmount(undefined);
    setError('');
  });

  const handleBack = useLastCallback(() => {
    setIsAuthorizing(false);
    setError('');
  });

  return (
    <Modal
      isOpen={isOpen}
      noBackdropClose
      dialogClassName={transferStyles.modalDialog}
      onClose={onClose}
    >
      {isAuthorizing ? (
        <>
          <ModalHeader title={lang('Confirm Sending')} onClose={onClose} />
          <PasswordForm
            isActive={isOpen}
            isLoading={isLoading}
            operationType="transfer"
            error={error}
            submitLabel={lang('Confirm')}
            cancelLabel={lang('Back')}
            noAutoConfirm
            onAuthorize={authorize}
            onCancel={handleBack}
            onUpdate={() => setError('')}
          />
        </>
      ) : (
        <form className={modalStyles.transitionContent} action="#" onSubmit={handleSubmit}>
          <Button
            isRound
            className={buildClassName(modalStyles.closeButton, transferStyles.closeButton)}
            ariaLabel={lang('Close')}
            onClick={onClose}
          >
            <i className={buildClassName(modalStyles.closeIcon, 'icon-close')} aria-hidden />
          </Button>

          <div className={transferStyles.transferTitle}>{lang('Top Up')}</div>

          <div className={transferStyles.label}>{lang('Counterparty')}</div>
          <InteractiveTextField
            isStatic
            text="Legends Energy"
            className={styles.counterparty}
          />

          <AmountInput
            {...amountInputProps}
            maxAmount={selectedToken?.amount}
            token={selectedToken}
            allTokens={topupTokens}
            hasError={isAmountAboveBalance || isBelowMinimum}
            withChainIcon
            isMaxAmountLoading={!tokens}
            isSensitiveDataHidden={isSensitiveDataHidden}
            renderBottomRight={() => undefined}
            onPressEnter={handleSubmit}
          />

          {error && <div className={styles.error}>{error}</div>}

          <div className={transferStyles.footer}>
            <div className={buildClassName(transferStyles.buttons, styles.buttons)}>
              <Button
                isDisabled={!amount}
                className={transferStyles.button}
                onClick={handleClear}
              >
                {lang('Clear')}
              </Button>
              <Button
                isPrimary
                isSubmit
                isDisabled={!amount || !selectedToken || !overview?.enabled || isAmountAboveBalance}
                className={transferStyles.button}
              >
                {lang('Continue')}
              </Button>
            </div>
          </div>
        </form>
      )}
    </Modal>
  );
}

function doesTokenMatchAsset(token: UserToken, asset: ApiWalletPrepaidTopupAsset) {
  return token.symbol === asset.asset_code
    && token.decimals === asset.decimals
    && (token.tokenAddress || undefined) === (asset.token_contract || undefined);
}

function getIsBelowMinimum(
  amount: bigint | undefined,
  token: UserToken | undefined,
  asset: ApiWalletPrepaidTopupAsset | undefined,
) {
  if (!amount || !token || !asset) return false;

  if (asset.asset_code === 'USDT') {
    return amount < fromDecimal(asset.minimum_usdt, asset.decimals);
  }

  if (!token.priceUsd) return false;

  return Number(toDecimal(amount, token.decimals)) * token.priceUsd < Number(asset.minimum_usdt);
}

function getErrorText(error: unknown) {
  return error instanceof Error ? error.message : 'Unexpected error';
}

export default memo(withGlobal<OwnProps>((global, { accountId }): StateProps => ({
  tokens: selectAccountTokens(global, accountId),
  baseCurrency: global.settings.baseCurrency,
  isSensitiveDataHidden: global.settings.isSensitiveDataHidden,
}))(PrepaidTopupModal));
