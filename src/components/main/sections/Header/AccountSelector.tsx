import type { ElementRef } from '../../../../lib/teact/teact';
import React, { memo, useMemo, useState } from '../../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../../global';

import type { ApiBaseCurrency, ApiCurrencyRates, ApiStakingState } from '../../../../api/types';
import type { Account, UserToken } from '../../../../global/types';
import type { MenuHandler } from '../Actions/helpers/walletMenu';

import {
  selectAccountStakingStates,
  selectCurrentAccountId,
  selectCurrentAccountTokens,
  selectNetworkAccounts,
} from '../../../../global/selectors';
import { getAccountTitle } from '../../../../util/account';
import buildClassName from '../../../../util/buildClassName';
import { calculateFullBalance } from '../../../../util/calculateFullBalance';
import { getShortCurrencySymbol } from '../../../../util/formatNumber';

import { useDeviceScreen } from '../../../../hooks/useDeviceScreen';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import SensitiveData from '../../../ui/SensitiveData';
import Transition from '../../../ui/Transition';
import WithContextMenu from '../../../ui/WithContextMenu';
import LogOutModal from '../../modals/LogOutModal';
import { handleWalletMenuItemClick, WALLET_CONTEXT_MENU_ITEMS } from '../Actions/helpers/walletMenu';

import styles from './AccountSelector.module.scss';

interface OwnProps {
  withAccountSelector?: boolean;
  withBalance?: boolean;
}

interface StateProps {
  currentAccountId?: string;
  currentAccount?: Account;
  tokens?: UserToken[];
  baseCurrency: ApiBaseCurrency;
  currencyRates: ApiCurrencyRates;
  stakingStates?: ApiStakingState[];
  isSensitiveDataHidden?: true;
}

function AccountSelector({
  currentAccountId,
  currentAccount,
  withAccountSelector,
  withBalance,
  tokens,
  baseCurrency,
  currencyRates,
  stakingStates,
  isSensitiveDataHidden,
}: OwnProps & StateProps) {
  const { openAccountSelector } = getActions();

  const lang = useLang();
  const { isPortrait } = useDeviceScreen();
  const [logOutAccountId, setLogOutAccountId] = useState<string>();
  const balanceValues = useMemo(() => {
    return tokens ? calculateFullBalance(tokens, stakingStates, currencyRates[baseCurrency]) : undefined;
  }, [tokens, stakingStates, currencyRates, baseCurrency]);
  const shortBaseSymbol = getShortCurrencySymbol(baseCurrency);
  const { primaryWholePart, primaryFractionPart } = balanceValues || {};

  function handleOpenAccountSelector() {
    openAccountSelector();
  }

  const handleMenuItemClick = useLastCallback((value: MenuHandler) => {
    if (!currentAccountId) return;

    handleWalletMenuItemClick(value, currentAccountId, setLogOutAccountId);
  });

  const handleLogOutModalClose = useLastCallback(() => {
    setLogOutAccountId(undefined);
  });

  const accountTitleClassName = buildClassName(
    styles.accountTitle,
    withAccountSelector && !withBalance && styles.accountTitleInteractive,
    withBalance && styles.withBalance,
  );

  function renderAccountTitle(menuProps?: {
    ref: ElementRef<HTMLDivElement | HTMLButtonElement>;
    onMouseDown: (e: React.MouseEvent) => void;
    onContextMenu: (e: React.MouseEvent) => void;
  }) {
    return currentAccount && (
      <button
        ref={menuProps?.ref as ElementRef<HTMLButtonElement>}
        type="button"
        className={accountTitleClassName}
        aria-label={lang('Switch Account')}
        aria-haspopup="dialog"
        onClick={withAccountSelector ? handleOpenAccountSelector : undefined}
        onMouseDown={menuProps?.onMouseDown}
        onContextMenu={menuProps?.onContextMenu}
        disabled={!withAccountSelector}
      >
        <span className={styles.accountTitleInner}>
          {getAccountTitle(currentAccount)}
        </span>
        {withAccountSelector && !withBalance && (
          <i className={buildClassName('icon icon-expand', styles.expandIcon)} aria-hidden />
        )}
      </button>
    );
  }

  return (
    <>
      <Transition
        name="slideVerticalFade"
        activeKey={withBalance ? 1 : 0}
        className={styles.root}
        slideClassName={styles.slide}
      >
        {withBalance && (
          <div className={buildClassName(styles.balance, 'rounded-font')}>
            <SensitiveData
              isActive={isSensitiveDataHidden}
              shouldHoldSize
              align="center"
              cols={10}
              rows={2}
              cellSize={8.5}
            >
              <span
                className={styles.currencySwitcher}
              >
                {shortBaseSymbol.length === 1 && (
                  <span className={buildClassName(styles.balanceCurrency, styles.balanceCurrencyPrefix)}>
                    {shortBaseSymbol}
                  </span>
                )}
                {primaryWholePart}
                {primaryFractionPart && <span className={styles.balanceFractionPart}>.{primaryFractionPart}</span>}
                {shortBaseSymbol.length > 1 && (
                  <span className={styles.balanceCurrency}>&nbsp;{shortBaseSymbol}</span>
                )}
              </span>
            </SensitiveData>
          </div>
        )}
        {isPortrait && withAccountSelector && currentAccount ? (
          <WithContextMenu
            items={WALLET_CONTEXT_MENU_ITEMS}
            withBackdrop
            onItemClick={handleMenuItemClick}
          >
            {(menuProps) => renderAccountTitle(menuProps)}
          </WithContextMenu>
        ) : renderAccountTitle()}
      </Transition>

      <LogOutModal
        isOpen={Boolean(logOutAccountId)}
        targetAccountId={logOutAccountId}
        onClose={handleLogOutModalClose}
      />
    </>
  );
}

export default memo(withGlobal<OwnProps>(
  (global): StateProps => {
    const {
      currencyRates,
      settings: {
        baseCurrency,
        isSensitiveDataHidden,
      },
    } = global;

    const accounts = selectNetworkAccounts(global);
    const currentAccountId = selectCurrentAccountId(global)!;
    const currentAccount = accounts?.[currentAccountId];
    const stakingStates = selectAccountStakingStates(global, currentAccountId);

    return {
      currentAccountId,
      currentAccount,
      tokens: selectCurrentAccountTokens(global),
      baseCurrency,
      currencyRates,
      stakingStates,
      isSensitiveDataHidden,
    };
  },
  (global, _, stickToFirst) => stickToFirst(selectCurrentAccountId(global)),
)(AccountSelector));
