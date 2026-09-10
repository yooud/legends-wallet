import { enclave } from '../../../enclave';
import { ensureCurrentWalletPrepaidAccessInBackground } from '../../helpers/enclave';
import { addActionHandler } from '../../index';

addActionHandler('setEnclaveSession', (global, actions, enclaveSession) => {
  const nextGlobal = { ...global, enclaveSession };

  // PasswordForm calls this for passcode and biometric unlocks. Start the fee-access proof while
  // that decryption is still authorized, rather than deferring it to the Fee Balance screen.
  ensureCurrentWalletPrepaidAccessInBackground(actions, nextGlobal, enclaveSession.token);

  return nextGlobal;
});

/**
 * Called by a flow that asked for more than one secret read once it stops needing them, so a budget
 * it overshot by does not stay spendable. Time-based sessions survive it - they are meant to be
 * reused until they run out - which is why a flow may call it without knowing which kind it got.
 *
 * A read still in flight elsewhere on the same session loses it. Only the multichain upgrade shares
 * a session that way, and it already puts its own count back and retries on the next password entry,
 * so the loss costs a retry rather than the upgrade.
 */
addActionHandler('releaseEnclaveSession', (global, actions, { enclaveToken }) => {
  void enclave.releaseSession(enclaveToken);

  const { token, validUntil } = global.enclaveSession ?? {};
  if (token !== enclaveToken || validUntil !== undefined) return global;

  return { ...global, enclaveSession: undefined };
});
