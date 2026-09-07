import type { GlobalState } from '../types';

import { callApiWithThrow } from '../../api';
import { dropEnclaveSessionHold, holdEnclaveSession, withEnclaveSessionRelease } from './enclave';

jest.mock('../../api', () => ({
  callApiWithThrow: jest.fn(() => Promise.resolve()),
}));

const global = {} as GlobalState;

function createActions() {
  return { releaseEnclaveSession: jest.fn() } as any;
}

describe('withEnclaveSessionRelease', () => {
  beforeEach(() => {
    jest.mocked(callApiWithThrow).mockClear();
  });

  it('gives the session back once the flow is done with it', async () => {
    const actions = createActions();

    await withEnclaveSessionRelease(() => Promise.resolve())(global, actions, { enclaveToken: 'passcode:aa' });

    expect(actions.releaseEnclaveSession).toHaveBeenCalledWith({ enclaveToken: 'passcode:aa' });
  });

  // A flow that dies halfway is exactly the one that leaves reads unspent, so the failure path is
  // where the release matters most - and the failure itself still has to reach the caller.
  it('gives the session back when the flow throws, and rethrows', async () => {
    const actions = createActions();
    const failing = withEnclaveSessionRelease(() => Promise.reject(new Error('nope')));

    await expect(failing(global, actions, { enclaveToken: 'passcode:aa' })).rejects.toThrow('nope');
    expect(actions.releaseEnclaveSession).toHaveBeenCalledWith({ enclaveToken: 'passcode:aa' });
  });

  it('has nothing to give back when the flow authorized nothing', async () => {
    const actions = createActions();

    await withEnclaveSessionRelease(() => Promise.resolve())(global, actions, undefined);

    expect(actions.releaseEnclaveSession).not.toHaveBeenCalled();
  });

  // One password entry can serve two flows at once - the multichain upgrade rides along on the
  // operation the user asked for - and the first one to finish must leave the session standing.
  it('waits for the last flow on a shared session', async () => {
    const actions = createActions();
    const payload = { enclaveToken: 'passcode:aa' };
    const alongside = withEnclaveSessionRelease(() => Promise.resolve());

    holdEnclaveSession(payload.enclaveToken);
    await alongside(global, actions, payload);

    expect(actions.releaseEnclaveSession).not.toHaveBeenCalled();

    expect(dropEnclaveSessionHold(payload.enclaveToken)).toBe(true);
  });

  it('counts holds per token, not across them', async () => {
    const actions = createActions();

    holdEnclaveSession('passcode:bb');
    await withEnclaveSessionRelease(() => Promise.resolve())(global, actions, { enclaveToken: 'passcode:aa' });

    expect(actions.releaseEnclaveSession).toHaveBeenCalledWith({ enclaveToken: 'passcode:aa' });

    dropEnclaveSessionHold('passcode:bb');
  });

  it('refreshes fee access while an unlocked account is being used', async () => {
    const actions = createActions();
    const unlockedGlobal = {
      currentAccountId: '0-testnet',
      accounts: {
        byId: {
          '0-testnet': {
            byChain: { tron: { address: 'TH8s8UjojVBtrT3jVwqYJox19sAWQkFTah' } },
          },
        },
      },
    } as unknown as GlobalState;

    await withEnclaveSessionRelease(() => Promise.resolve())(
      unlockedGlobal,
      actions,
      { enclaveToken: 'passcode:aa' },
    );

    expect(callApiWithThrow).toHaveBeenCalledWith('ensureWalletPrepaidAccess', '0-testnet', 'passcode:aa');
  });

  it('does not keep the signing flow waiting for fee access', async () => {
    let resolveAccess!: () => void;
    jest.mocked(callApiWithThrow).mockReturnValueOnce(new Promise<void>((resolve) => {
      resolveAccess = resolve;
    }));
    const actions = createActions();
    const unlockedGlobal = {
      currentAccountId: '0-testnet',
      accounts: {
        byId: {
          '0-testnet': { byChain: { tron: { address: 'tron-address' } } },
        },
      },
    } as unknown as GlobalState;

    await withEnclaveSessionRelease(() => Promise.resolve())(
      unlockedGlobal,
      actions,
      { enclaveToken: 'passcode:aa' },
    );

    expect(actions.releaseEnclaveSession).not.toHaveBeenCalled();
    resolveAccess();
    await Promise.resolve();
    await Promise.resolve();
    expect(actions.releaseEnclaveSession).toHaveBeenCalledWith({ enclaveToken: 'passcode:aa' });
  });

  it('can leave prepaid access to a handler that creates a different account', async () => {
    const actions = createActions();
    const unlockedGlobal = {
      currentAccountId: '0-testnet',
      accounts: {
        byId: {
          '0-testnet': { byChain: { tron: { address: 'tron-address' } } },
        },
      },
    } as unknown as GlobalState;

    await withEnclaveSessionRelease(
      () => Promise.resolve(),
      { shouldEnsureWalletPrepaidAccess: false },
    )(unlockedGlobal, actions, { enclaveToken: 'passcode:aa' });

    expect(callApiWithThrow).not.toHaveBeenCalled();
  });
});
