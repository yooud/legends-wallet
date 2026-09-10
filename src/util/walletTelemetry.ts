import { pack } from '@rrweb/packer';
import { record } from '@rrweb/record';
import type { eventWithTime } from '@rrweb/types';

import type { Account } from '../global/types';

import { APP_COMMIT_HASH, IS_TELEGRAM_APP } from '../config';
import { suppressStrict } from '../lib/fasterdom/stricterdom';
import { getTelemetryTranslationKey } from './langProvider';

export type WalletTelemetryEvent = {
  sequence: number;
  type: 'api_operation' | 'app_error' | 'interaction' | 'lifecycle' | 'network' | 'screen_view' | 'scroll';
  name: string;
  screen?: string;
  offset_ms: number;
  details?: Record<string, unknown>;
};

export type WalletTelemetryReplayEvent = {
  sequence: number;
  offset_ms: number;
  payload: string;
};

export type WalletTelemetryPayload = {
  session_id: string;
  started_at: string;
  wallet_addresses: string[];
  context: Record<string, boolean | number | string>;
  events: WalletTelemetryEvent[];
  replay_events: WalletTelemetryReplayEvent[];
};

type TelemetrySender = (payload: WalletTelemetryPayload) => Promise<unknown>;
type WalletAddressProvider = () => string[];

const FLUSH_INTERVAL_MS = 5_000;
const MAX_QUEUE_SIZE = 250;
const MAX_BATCH_SIZE = 50;
const MAX_REPLAY_QUEUE_SIZE = 2_000;
const MAX_REPLAY_BATCH_SIZE = 250;
const MAX_BATCH_PAYLOAD_BYTES = 1_500_000;
const MAX_REPLAY_EVENT_BYTES = 1_000_000;
const MAX_REPLAY_SESSION_BYTES = 8 * 1024 * 1024;
const REPLAY_CHECKOUT_INTERVAL_MS = 60_000;
const STATIC_ASSET_PATH_RE = new RegExp(
  String.raw`^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.[a-f0-9]{8,64}\.`
  + String.raw`(?:avif|css|gif|jpg|jpeg|png|svg|tgs|webp|woff2?)$`,
  'i',
);
const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const PRIVATE_DOM_ATTRIBUTES = new Set([
  'alt', 'aria-description', 'aria-label', 'data-address', 'data-value', 'placeholder', 'srcset', 'title', 'value',
]);
const USER_API_METHODS = new Set([
  'addAllFoundSubwallets',
  'addSubWallet',
  'authorizeWalletPrepaid',
  'confirmDappRequest',
  'confirmDappRequestConnect',
  'confirmDappRequestSendTransaction',
  'confirmDappRequestSignData',
  'confirmMfaRemovalRequest',
  'confirmSwapMfaRequest',
  'createSubWallet',
  'deleteAllDapps',
  'deleteDapp',
  'importLedgerAccount',
  'importMnemonic',
  'importNewWalletVersion',
  'importPrivateKey',
  'importToken',
  'importViewAccount',
  'removeAccount',
  'revokeWalletPermission',
  'signDappData',
  'signDappTransfers',
  'submitDnsChangeWallet',
  'submitDnsRenewal',
  'submitNftTransfers',
  'submitStake',
  'submitStakingClaimOrUnlock',
  'submitTransfer',
  'submitUnstake',
]);

let sender: TelemetrySender | undefined;
let walletAddressProvider: WalletAddressProvider | undefined;
let sessionId = '';
let startedAt = 0;
let startedAtIso = '';
let sequence = 0;
let replaySequence = 0;
let currentScreen = '';
let queue: WalletTelemetryEvent[] = [];
let replayQueue: WalletTelemetryReplayEvent[] = [];
let replayBytes = 0;
let isFlushing = false;
let scrollTimer: number | undefined;
let stopReplayRecording: NoneToVoidFunction | undefined;
let isReplayLimitReached = false;
const recordedScrollDepths = new Set<string>();

export function initWalletTelemetry(send: TelemetrySender, getWalletAddresses?: WalletAddressProvider) {
  if (sender) return;
  sender = send;
  walletAddressProvider = getWalletAddresses;
  sessionId = createUuid();
  startedAt = Date.now();
  startedAtIso = new Date(startedAt).toISOString();
  recordEvent('lifecycle', 'session_start');

  document.addEventListener('click', handleClick, true);
  document.addEventListener('focusin', handleFocus, true);
  document.addEventListener('scroll', handleScroll, true);
  window.addEventListener('online', handleNetworkChange);
  window.addEventListener('offline', handleNetworkChange);
  window.addEventListener('error', handleError);
  window.addEventListener('unhandledrejection', handleUnhandledRejection);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('pagehide', handlePageHide);
  window.setInterval(() => void flushWalletTelemetry(), FLUSH_INTERVAL_MS);
}

export function trackWalletScreen(screen: string) {
  const safeScreen = safeIdentifier(screen, 96);
  if (!safeScreen || safeScreen === currentScreen) return;
  currentScreen = safeScreen;
  recordEvent('screen_view', 'view');
  updateReplayRecording();
}

export function trackWalletApiOperation(method: string, outcome: 'error' | 'success', durationMs: number) {
  if (method === 'submitWalletTelemetry' || method === 'submitDiagnosticLogs') return;
  if (outcome === 'success' && !USER_API_METHODS.has(method)) return;
  recordEvent('api_operation', method, {
    outcome,
    duration_bucket_ms: durationBucket(durationMs),
  });
}

export async function flushWalletTelemetry() {
  if (!sender || isFlushing || (!queue.length && !replayQueue.length)) return;
  isFlushing = true;
  const batch = takeTelemetryBatch();
  if (!batch.events.length && !batch.replayEvents.length) {
    isFlushing = false;
    return;
  }
  let didSend = false;
  try {
    const result = await sender({
      session_id: sessionId,
      started_at: startedAtIso,
      wallet_addresses: walletAddressProvider?.() ?? [],
      context: getContext(),
      events: batch.events,
      replay_events: batch.replayEvents,
    });
    if (result) {
      didSend = true;
    } else {
      restoreTelemetryBatch(batch);
    }
  } catch {
    restoreTelemetryBatch(batch);
  } finally {
    isFlushing = false;
    if (didSend && (queue.length >= MAX_BATCH_SIZE || replayQueue.length >= MAX_REPLAY_BATCH_SIZE)) {
      void flushWalletTelemetry();
    }
  }
}

export function selectTelemetryWalletAddresses(accounts?: Record<string, Account>) {
  const addresses = Object.values(accounts ?? {})
    .filter((account) => account.type !== 'view' && !account.isTemporary && !account.isRecoveryRequired)
    .map((account) => account.byChain.tron?.address)
    .filter((address): address is string => Boolean(address && TRON_ADDRESS_RE.test(address)));

  return Array.from(new Set(addresses));
}

export function getTelemetryElementDetails(element: Element) {
  const interactive = element.closest<HTMLElement>(
    'button, a, input, select, textarea, [role="button"], [role="menuitem"], [role="tab"], [role="switch"]',
  );
  if (!interactive || interactive.closest('.rr-block, [data-telemetry-block]')) return undefined;
  const icon = Array.from(interactive.querySelectorAll<HTMLElement>('[class]'))
    .flatMap((item) => Array.from(item.classList))
    .find((className) => /^icon-[a-z0-9-]+$/i.test(className));
  const telemetryId = safeIdentifier(interactive.dataset.telemetryId, 64);
  const staticClass = Array.from(interactive.classList)
    .find((className) => /^[A-Za-z][A-Za-z0-9_-]{1,63}$/.test(className));
  const tag = interactive.tagName.toLowerCase();
  const rect = interactive.getBoundingClientRect();
  return {
    element: telemetryId || `${tag}${staticClass ? `.${staticClass}` : ''}`,
    ...(interactive.getAttribute('role') && { role: safeIdentifier(interactive.getAttribute('role'), 32) }),
    ...(icon && { icon }),
    ...(interactive instanceof HTMLInputElement && { input_type: safeIdentifier(interactive.type, 24) || 'text' }),
    ...((interactive instanceof HTMLButtonElement || interactive instanceof HTMLInputElement)
      && { control_type: safeIdentifier(interactive.type, 24) || tag }),
    ...((rect.width > 0 || rect.height > 0) && {
      target_box: serializeBox(rect),
    }),
  };
}

export function maskWalletReplayText(text: string) {
  if (!text.trim() || getTelemetryTranslationKey(text)) return text;
  return text.replace(/\S/g, '*');
}

export function isWalletReplayBlockedScreen(screen: string) {
  return screen === 'AppLock'
    || screen.startsWith('Auth.')
    || screen === 'Settings.BackupWallet';
}

export function shouldRecordWalletReplay(screen: string) {
  return Boolean(screen) && !isWalletReplayBlockedScreen(screen);
}

export function sanitizeWalletReplayEvent(event: eventWithTime): eventWithTime {
  const sanitized = JSON.parse(JSON.stringify(event)) as eventWithTime;
  sanitizeReplayObject(sanitized);
  return sanitized;
}

function updateReplayRecording() {
  if (isReplayLimitReached || !shouldRecordWalletReplay(currentScreen)) {
    stopReplayRecording?.();
    stopReplayRecording = undefined;
    return;
  }
  if (stopReplayRecording) return;

  stopReplayRecording = suppressStrict(() => record({
    emit: handleReplayEvent,
    blockSelector: '.rr-block, [data-telemetry-block]',
    maskTextSelector: '*',
    maskTextFn: maskWalletReplayText,
    maskAllInputs: true,
    checkoutEveryNms: REPLAY_CHECKOUT_INTERVAL_MS,
    recordCanvas: false,
    recordCrossOriginIframes: false,
    inlineImages: false,
    collectFonts: false,
    sampling: {
      mousemove: 100,
      mouseInteraction: true,
      scroll: 150,
      input: 'last',
    },
  }));
}

function handleReplayEvent(event: eventWithTime) {
  const encodedPayload = window.btoa(pack(sanitizeWalletReplayEvent(event)));
  const payloadBytes = encodedPayload.length;
  if (payloadBytes > MAX_REPLAY_EVENT_BYTES || replayBytes + payloadBytes > MAX_REPLAY_SESSION_BYTES) {
    isReplayLimitReached = true;
    stopReplayRecording?.();
    stopReplayRecording = undefined;
    return;
  }
  replayBytes += payloadBytes;
  replayQueue.push({
    sequence: replaySequence++,
    offset_ms: Math.max(0, Date.now() - startedAt),
    payload: encodedPayload,
  });
  if (replayQueue.length > MAX_REPLAY_QUEUE_SIZE) replayQueue.shift();
  if (replayQueue.length >= MAX_REPLAY_BATCH_SIZE) void flushWalletTelemetry();
}

function sanitizeReplayObject(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(sanitizeReplayObject);
    return;
  }

  const item = value as Record<string, unknown>;
  if (typeof item.href === 'string') item.href = safeReplayPageUrl(item.href);
  if (item.attributes && typeof item.attributes === 'object' && !Array.isArray(item.attributes)) {
    sanitizeReplayAttributes(item.attributes as Record<string, unknown>);
  }
  Object.values(item).forEach(sanitizeReplayObject);
}

function sanitizeReplayAttributes(attributes: Record<string, unknown>) {
  for (const [name, rawValue] of Object.entries(attributes)) {
    const normalizedName = name.toLowerCase();
    if (PRIVATE_DOM_ATTRIBUTES.has(normalizedName)
      || (normalizedName.startsWith('data-') && normalizedName !== 'data-telemetry-id')) {
      delete attributes[name];
      continue;
    }
    if (normalizedName === 'href' || normalizedName === 'src') {
      const safeUrl = safeReplayAssetUrl(rawValue);
      if (safeUrl) attributes[name] = safeUrl;
      else delete attributes[name];
      continue;
    }
    if (normalizedName === 'style' && typeof rawValue === 'string') {
      attributes[name] = rawValue.replace(/url\(([^)]+)\)/gi, (match, url) => (
        safeReplayAssetUrl(String(url).replace(/["']/g, '').trim()) ? match : 'none'
      ));
    }
  }
}

function safeReplayPageUrl(value: string) {
  try {
    const url = new URL(value, window.location.href);
    return url.origin === window.location.origin ? `${url.origin}${url.pathname}` : window.location.origin;
  } catch {
    return window.location.origin;
  }
}

function safeReplayAssetUrl(value: unknown) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value, window.location.href);
    return url.origin === window.location.origin && STATIC_ASSET_PATH_RE.test(url.pathname)
      ? `${url.origin}${url.pathname}`
      : '';
  } catch {
    return '';
  }
}

function recordEvent(
  type: WalletTelemetryEvent['type'],
  name: string,
  details?: WalletTelemetryEvent['details'],
) {
  if (!sender) return;
  const safeName = safeIdentifier(name, 96);
  if (!safeName) return;
  queue.push({
    sequence: sequence++,
    type,
    name: safeName,
    screen: currentScreen,
    offset_ms: Math.max(0, Date.now() - startedAt),
    ...(details && { details }),
  });
  if (queue.length > MAX_QUEUE_SIZE) queue.shift();
  if (queue.length >= MAX_BATCH_SIZE) void flushWalletTelemetry();
}

function handleClick(event: MouseEvent) {
  if (!(event.target instanceof Element)) return;
  const details = getTelemetryElementDetails(event.target);
  if (!details) return;
  recordEvent('interaction', 'activate', {
    ...details,
    pointer: event.detail === 0 ? 'keyboard' : 'pointer',
  });
}

function handleFocus(event: FocusEvent) {
  if (!(event.target instanceof HTMLInputElement
    || event.target instanceof HTMLSelectElement
    || event.target instanceof HTMLTextAreaElement)) return;
  const details = getTelemetryElementDetails(event.target);
  if (!details) return;
  recordEvent('interaction', 'focus', {
    ...details,
    input_type: event.target instanceof HTMLInputElement
      ? safeIdentifier(event.target.type, 24) || 'text'
      : 'text',
  });
}

function handleScroll(event: Event) {
  if (scrollTimer) window.clearTimeout(scrollTimer);
  scrollTimer = window.setTimeout(() => {
    const target = event.target === document ? document.scrollingElement : event.target;
    if (!(target instanceof Element)) return;
    const maximum = target.scrollHeight - target.clientHeight;
    if (maximum <= 0) return;
    const depth = Math.min(100, Math.floor((target.scrollTop / maximum) * 4) * 25);
    if (!depth) return;
    const key = `${currentScreen}:${depth}`;
    if (recordedScrollDepths.has(key)) return;
    recordedScrollDepths.add(key);
    recordEvent('scroll', 'depth', { depth });
  }, 200);
}

function handleNetworkChange() {
  recordEvent('network', navigator.onLine ? 'online' : 'offline', { online: navigator.onLine });
}

function handleError(event: ErrorEvent) {
  recordEvent('app_error', 'window_error', {
    error_name: safeIdentifier(event.error?.name, 64) || 'Error',
    ...(event.filename && { source: safeSource(event.filename) }),
  });
}

function handleUnhandledRejection(event: PromiseRejectionEvent) {
  recordEvent('app_error', 'unhandled_rejection', {
    error_name: safeIdentifier(event.reason?.name, 64) || 'Error',
  });
}

function handleVisibilityChange() {
  recordEvent('lifecycle', document.hidden ? 'hidden' : 'visible');
  if (document.hidden) void flushWalletTelemetry();
}

function handlePageHide() {
  recordEvent('lifecycle', 'page_hide');
  void flushWalletTelemetry();
}

function serializeBox(rect: Pick<DOMRect, 'height' | 'width' | 'x' | 'y'>): [number, number, number, number] {
  return [
    quantize(rect.x, -16_384, 32_768),
    quantize(rect.y, -16_384, 32_768),
    quantize(rect.width, 0, 32_768),
    quantize(rect.height, 0, 32_768),
  ];
}

function quantize(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, Math.round(value / 4) * 4));
}

function takeTelemetryBatch() {
  const events: WalletTelemetryEvent[] = [];
  const replayEvents: WalletTelemetryReplayEvent[] = [];
  let size = 512;
  while (queue.length && events.length < MAX_BATCH_SIZE) {
    const event = queue[0];
    const eventSize = JSON.stringify(event).length + 1;
    if ((events.length || replayEvents.length) && size + eventSize > MAX_BATCH_PAYLOAD_BYTES) break;
    queue.shift();
    events.push(event);
    size += eventSize;
  }
  while (replayQueue.length && replayEvents.length < MAX_REPLAY_BATCH_SIZE) {
    const event = replayQueue[0];
    const eventSize = event.payload.length + 96;
    if ((events.length || replayEvents.length) && size + eventSize > MAX_BATCH_PAYLOAD_BYTES) break;
    replayQueue.shift();
    replayEvents.push(event);
    size += eventSize;
  }
  return { events, replayEvents };
}

function restoreTelemetryBatch(batch: {
  events: WalletTelemetryEvent[];
  replayEvents: WalletTelemetryReplayEvent[];
}) {
  queue = [...batch.events, ...queue].slice(0, MAX_QUEUE_SIZE);
  replayQueue = [...batch.replayEvents, ...replayQueue].slice(0, MAX_REPLAY_QUEUE_SIZE);
}

function getContext(): WalletTelemetryPayload['context'] {
  return {
    commit: APP_COMMIT_HASH,
    build: IS_TELEGRAM_APP ? 'telegram' : 'web',
    language: navigator.language,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    device_pixel_ratio: window.devicePixelRatio,
    theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    telegram: IS_TELEGRAM_APP,
    standalone: window.matchMedia('(display-mode: standalone)').matches,
    replay_format: 'rrweb-packed-base64-v1',
  };
}

function durationBucket(durationMs: number) {
  const buckets = [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 120_000];
  return buckets.find((bucket) => durationMs <= bucket) || 120_000;
}

function safeSource(value: string) {
  const filename = value.split(/[?#]/)[0].split('/').pop();
  return safeIdentifier(filename, 96) || 'unknown';
}

function safeIdentifier(value: unknown, maximum: number) {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return text
    .slice(0, maximum)
    .replace(/[^A-Za-z0-9_.:/-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function createUuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
