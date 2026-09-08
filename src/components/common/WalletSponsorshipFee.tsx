import React, { memo } from '../../lib/teact/teact';

import type { FeeToken } from '../ui/Fee';

import buildClassName from '../../util/buildClassName';

import useLang from '../../hooks/useLang';

import Fee from '../ui/Fee';

import styles from './WalletSponsorshipFee.module.scss';

interface OwnProps {
  serviceFee: bigint;
  token: FeeToken;
  className?: string;
}

function WalletSponsorshipFee({
  serviceFee,
  token,
  className,
}: OwnProps) {
  const lang = useLang();

  return (
    <div className={buildClassName(styles.root, className)}>
      <div className={styles.feeRow}>
        <span className={styles.feeLabel}>{lang('Fee')}</span>
        <strong className={styles.feeAmount}>
          <Fee
            terms={{ native: serviceFee }}
            precision="exact"
            token={token}
          />
        </strong>
      </div>
    </div>
  );
}

export default memo(WalletSponsorshipFee);
