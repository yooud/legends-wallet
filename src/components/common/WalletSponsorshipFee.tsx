import React, { memo } from '../../lib/teact/teact';

import type { FeeToken } from '../ui/Fee';

import buildClassName from '../../util/buildClassName';

import useLang from '../../hooks/useLang';

import Fee from '../ui/Fee';
import IconWithTooltip from '../ui/IconWithTooltip';

import styles from './WalletSponsorshipFee.module.scss';

interface OwnProps {
  serviceFee: bigint;
  onchainFee: bigint;
  token: FeeToken;
  label?: string;
  shouldShowOnchainFee?: boolean;
  prepaidBalance?: bigint;
  onTopUp?: NoneToVoidFunction;
  className?: string;
}

function WalletSponsorshipFee({
  serviceFee,
  onchainFee,
  token,
  label,
  shouldShowOnchainFee,
  prepaidBalance,
  onTopUp,
  className,
}: OwnProps) {
  const lang = useLang();
  const feeDifference = onchainFee - serviceFee;
  const savedFee = feeDifference > 0n ? feeDifference : 0n;

  return (
    <div className={buildClassName(styles.root, className)}>
      <div className={styles.feeRow}>
        <span className={styles.feeLabel}>
          {label ?? lang('$wallet_sponsorship_fee')}
          <IconWithTooltip
            message={lang('$wallet_sponsorship_help')}
            size="small"
            direction="bottom"
            iconClassName={styles.helpIcon}
          />
        </span>
        <strong className={styles.feeAmount}>
          <Fee
            terms={{ native: serviceFee }}
            precision="exact"
            token={token}
            shouldPreferIcons
          />
        </strong>
      </div>
      <div className={styles.feeDetails}>
        <div className={buildClassName(styles.savings, savedFee === 0n && styles.savings_none)}>
          <span>{lang('$wallet_sponsorship_saved')}</span>
          <Fee terms={{ native: savedFee }} precision="approximate" token={token} />
        </div>
        {shouldShowOnchainFee && (
          <div className={styles.onchainFee}>
            <span>{lang('$wallet_sponsorship_onchain_fee')}</span>
            <Fee terms={{ native: onchainFee }} precision="approximate" token={token} />
          </div>
        )}
      </div>
      {prepaidBalance !== undefined && (
        <div className={styles.prepaidRow}>
          <span>{lang('Prepaid Balance')}</span>
          <span><Fee terms={{ native: prepaidBalance }} precision="exact" token={token} /></span>
          {onTopUp && <button type="button" onClick={onTopUp}>{lang('Top Up')}</button>}
        </div>
      )}
    </div>
  );
}

export default memo(WalletSponsorshipFee);
