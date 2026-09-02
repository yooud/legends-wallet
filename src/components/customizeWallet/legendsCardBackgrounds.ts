import type { CardBackgroundId } from '../../global/types';

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

export const DEFAULT_CARD_BACKGROUND_ID: CardBackgroundId = 'logo-purple';

export const LEGENDS_CARD_BACKGROUNDS: readonly LegendsCardBackground[] = [
  { id: 'logo-purple', imageUrl: logoPurpleUrl, hasDarkText: false },
  { id: 'texture-light', imageUrl: textureLightUrl, hasDarkText: true },
  { id: 'bolt-purple', imageUrl: boltPurpleUrl, hasDarkText: false },
  { id: 'bolt-dark-teal', imageUrl: boltDarkTealUrl, hasDarkText: false },
  { id: 'logo-light', imageUrl: logoLightUrl, hasDarkText: true },
  { id: 'bolt-dark-purple', imageUrl: boltDarkPurpleUrl, hasDarkText: false },
  { id: 'logo-cyan', imageUrl: logoCyanUrl, hasDarkText: true },
  { id: 'logo-black', imageUrl: logoBlackUrl, hasDarkText: false },
];

export function getLegendsCardBackground(backgroundId?: CardBackgroundId) {
  return LEGENDS_CARD_BACKGROUNDS.find(({ id }) => id === backgroundId) ?? LEGENDS_CARD_BACKGROUNDS[0];
}
