import React, { memo } from '../../lib/teact/teact';

import type { ApiBaseCurrency, ApiCurrencyRates, ApiNft } from '../../api/types';
import type { UserToken } from '../../global/types';
import type { LegendsCardBackground } from './legendsCardBackgrounds';

import { DEFAULT_CARD_ADDRESS } from './constants';

import useLastCallback from '../../hooks/useLastCallback';

import NftCardItem from './NftCardItem';

import styles from './CardGrid.module.scss';

interface OwnProps {
  cards?: ApiNft[];
  backgrounds?: readonly LegendsCardBackground[];
  selectedAddress?: string;
  onCardSelect: (address: string) => void;
  tokens?: UserToken[];
  baseCurrency?: ApiBaseCurrency;
  currencyRates?: ApiCurrencyRates;
}

function CardGrid({
  cards, backgrounds, selectedAddress, onCardSelect, tokens, baseCurrency, currencyRates,
}: OwnProps) {
  const handleCardClick = useLastCallback((address: string) => {
    onCardSelect(address);
  });

  return (
    <div className={styles.grid}>
      {!backgrounds && (
        <NftCardItem
          key="default"
          isSelected={selectedAddress === DEFAULT_CARD_ADDRESS}
          tokens={tokens}
          baseCurrency={baseCurrency}
          currencyRates={currencyRates}
          onClick={handleCardClick}
        />
      )}
      {backgrounds?.map((background) => (
        <NftCardItem
          key={background.id}
          background={background}
          isSelected={background.id === selectedAddress}
          tokens={tokens}
          baseCurrency={baseCurrency}
          currencyRates={currencyRates}
          onClick={handleCardClick}
        />
      ))}
      {cards?.map((card) => (
        <NftCardItem
          key={card.address}
          card={card}
          isSelected={card.address === selectedAddress}
          tokens={tokens}
          baseCurrency={baseCurrency}
          currencyRates={currencyRates}
          onClick={handleCardClick}
        />
      ))}
    </div>
  );
}

export default memo(CardGrid);
