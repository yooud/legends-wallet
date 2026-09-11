import { logDebug } from '../../util/logs';

const MAX_SAMPLE_ROUND_TRIP_MS = 10_000;
const CLOCK_JUMP_MS = 5_000;
const SIGNIFICANT_OFFSET_MS = 5_000;
const LOG_OFFSET_CHANGE_MS = 1_000;

let offsetMs: number | undefined;
let sampleRoundTripMs = Infinity;
let lastLoggedOffsetMs: number | undefined;

export function updateBackendClock(
  serverTimeMs: number,
  requestStartedAt: number,
  responseReceivedAt = Date.now(),
) {
  const roundTripMs = responseReceivedAt - requestStartedAt;
  if (!Number.isFinite(serverTimeMs)
    || !Number.isFinite(requestStartedAt)
    || !Number.isFinite(responseReceivedAt)
    || roundTripMs < 0
    || roundTripMs > MAX_SAMPLE_ROUND_TRIP_MS) {
    return;
  }

  const nextOffsetMs = serverTimeMs - (requestStartedAt + responseReceivedAt) / 2;
  const didClockJump = offsetMs !== undefined && Math.abs(nextOffsetMs - offsetMs) >= CLOCK_JUMP_MS;
  if (offsetMs === undefined || didClockJump || roundTripMs < sampleRoundTripMs) {
    offsetMs = nextOffsetMs;
    sampleRoundTripMs = roundTripMs;
  }

  if (Math.abs(offsetMs) >= SIGNIFICANT_OFFSET_MS
    && (lastLoggedOffsetMs === undefined || Math.abs(offsetMs - lastLoggedOffsetMs) >= LOG_OFFSET_CHANGE_MS)) {
    lastLoggedOffsetMs = offsetMs;
    logDebug('[clock] backend offset detected', {
      offsetMs: Math.round(offsetMs),
      roundTripMs,
    });
  }
}

export function getBackendNow() {
  return Date.now() + (offsetMs ?? 0);
}

export function getBackendClockOffset() {
  return offsetMs;
}

export function resetBackendClockForTests() {
  offsetMs = undefined;
  sampleRoundTripMs = Infinity;
  lastLoggedOffsetMs = undefined;
}
