import type { CardBackgroundId } from '../../global/types';

import {
  DEFAULT_CARD_BACKGROUND_ID,
  LEGENDS_CARD_BACKGROUND_IDS,
} from '../../util/legendsCardBackground';

import boltDarkPurpleUrl from '../../assets/cards/legends/bolt-dark-purple.png';
import boltDarkTealUrl from '../../assets/cards/legends/bolt-dark-teal.png';
import boltPurpleUrl from '../../assets/cards/legends/bolt-purple.png';
import logoBlackUrl from '../../assets/cards/legends/logo-black.png';
import logoCyanUrl from '../../assets/cards/legends/logo-cyan.png';
import logoLightUrl from '../../assets/cards/legends/logo-light.png';
import logoPurpleUrl from '../../assets/cards/legends/logo-purple.png';
import textureLightUrl from '../../assets/cards/legends/texture-light.png';

export interface LegendsCardBackground {
  id: CardBackgroundId;
  imageUrl: string;
  hasDarkText: boolean;
}

export { DEFAULT_CARD_BACKGROUND_ID };

const BACKGROUNDS_BY_ID: Record<CardBackgroundId, Omit<LegendsCardBackground, 'id'>> = {
  'logo-purple': { imageUrl: logoPurpleUrl, hasDarkText: false },
  'texture-light': { imageUrl: textureLightUrl, hasDarkText: true },
  'bolt-purple': { imageUrl: boltPurpleUrl, hasDarkText: false },
  'bolt-dark-teal': { imageUrl: boltDarkTealUrl, hasDarkText: false },
  'logo-light': { imageUrl: logoLightUrl, hasDarkText: true },
  'bolt-dark-purple': { imageUrl: boltDarkPurpleUrl, hasDarkText: false },
  'logo-cyan': { imageUrl: logoCyanUrl, hasDarkText: true },
  'logo-black': { imageUrl: logoBlackUrl, hasDarkText: false },
};

export const LEGENDS_CARD_BACKGROUNDS: readonly LegendsCardBackground[] = LEGENDS_CARD_BACKGROUND_IDS.map((id) => ({
  id,
  ...BACKGROUNDS_BY_ID[id],
}));

export function getLegendsCardBackground(backgroundId?: CardBackgroundId) {
  return LEGENDS_CARD_BACKGROUNDS.find(({ id }) => id === backgroundId) ?? LEGENDS_CARD_BACKGROUNDS[0];
}
