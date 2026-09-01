import type { ApiNetwork } from '../../../types';

import { TRX } from '../../../../config';
import { buildTokenSlug } from '../../../common/tokens';
import { NETWORK_CONFIG } from '../constants';

export function getTokenSlugs(network: ApiNetwork) {
  return [
    TRX.slug,
    ...NETWORK_CONFIG[network].tokenAddresses.map((address) => buildTokenSlug('tron', address)),
  ];
}

export function formatTrc20Uint256(value: bigint) {
  return value.toString(10);
}
