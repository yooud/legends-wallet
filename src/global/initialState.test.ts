import { INITIAL_STATE } from './initialState';

describe('initial network', () => {
  it('follows DEFAULT_NETWORK', () => {
    expect(Boolean(INITIAL_STATE.settings.isTestnet)).toBe(process.env.DEFAULT_NETWORK === 'testnet');
  });
});
