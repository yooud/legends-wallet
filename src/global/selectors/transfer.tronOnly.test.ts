import type { GlobalState } from '../types';

import { INITIAL_STATE } from '../initialState';
import { selectIsOffRampAllowed, selectIsOnRampAllowed } from './transfer';

describe('Tron-only ramp availability', () => {
  it('hides ramps while no account chain is selected', () => {
    const global = {
      ...INITIAL_STATE,
      settings: {
        ...INITIAL_STATE.settings,
        isTestnet: false,
      },
    } as GlobalState;

    expect(selectIsOnRampAllowed(global, undefined)).toBe(false);
    expect(selectIsOffRampAllowed(global, undefined)).toBe(false);
  });
});
