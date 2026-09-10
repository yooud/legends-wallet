import { logDebugError } from '../logs';
import { debounce } from '../schedulers';
import { getTelegramApp } from './index';

interface CallbackEntry {
  id: number;
  callback: NoneToVoidFunction;
}

const runDebounce = debounce((cb) => cb(), 300, false);
const callbacks: CallbackEntry[] = [];
let isGlobalHandlerAttached = false;
let uniqueId = 0;
let suspendCount = 0;

function getNextId() {
  uniqueId += 1;
  return uniqueId;
}

function updateBackButtonState() {
  const backButton = getTelegramApp()!.BackButton;

  if (callbacks.length > 0 && !suspendCount && !isGlobalHandlerAttached) {
    backButton.show();
    backButton.onClick(handleBackButtonClick);
    isGlobalHandlerAttached = true;
  } else if ((!callbacks.length || suspendCount) && isGlobalHandlerAttached) {
    backButton.hide();
    backButton.offClick(handleBackButtonClick);
    isGlobalHandlerAttached = false;
  }
}

export function registerCallback(cb: NoneToVoidFunction) {
  const id = getNextId();
  callbacks.push({ id, callback: cb });
  runDebounce(updateBackButtonState);
  return id;
}

export function unregisterCallback(id: number) {
  const index = callbacks.findIndex((entry) => entry.id === id);
  if (index !== -1) {
    callbacks.splice(index, 1);
    runDebounce(updateBackButtonState);
  }
}

/**
 * A full-screen picker has its own close affordance. Keep Telegram's native BackButton out of its
 * hit area without unregistering the navigation handlers that need to resume after the picker closes.
 */
export function suspendTelegramBackButton() {
  suspendCount += 1;
  updateBackButtonState();

  let isReleased = false;
  return () => {
    if (isReleased) return;
    isReleased = true;
    suspendCount = Math.max(0, suspendCount - 1);
    updateBackButtonState();
  };
}

function handleBackButtonClick() {
  if (callbacks.length > 0) {
    const entry = callbacks.pop()!;
    try {
      entry.callback();
    } catch (err: any) {
      logDebugError('[handleBackButtonClick]', err);
    }
  }

  runDebounce(updateBackButtonState);
}
