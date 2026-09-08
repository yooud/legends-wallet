import type { CardBackgroundId } from '../global/types';

export const LEGENDS_CARD_BACKGROUND_IDS = [
  'logo-purple',
  'texture-light',
  'bolt-purple',
  'bolt-dark-teal',
  'logo-light',
  'bolt-dark-purple',
  'logo-cyan',
  'logo-black',
] as const satisfies readonly CardBackgroundId[];

export const DEFAULT_CARD_BACKGROUND_ID: CardBackgroundId = LEGENDS_CARD_BACKGROUND_IDS[0];

export function getRandomLegendsCardBackgroundId(): CardBackgroundId {
  return LEGENDS_CARD_BACKGROUND_IDS[Math.floor(Math.random() * LEGENDS_CARD_BACKGROUND_IDS.length)];
}
