# Technical debt

## Token price charts

The TRON-only Legends fork hides token price charts and does not call
`/prices/chart/*`. The wallet API currently provides current TRX/USDT prices
and fiat conversion rates only. Re-enable charts after the Legends backend has
a durable historical price source and a compatible MyWallet response contract.

## Help center

The Legends fork hides the MyWallet Help Center links because the published
content, branding, and product behavior do not describe Legends Wallet. Add a
Legends-owned help center with localized TRON documentation, then replace the
Help Center URL contract and remove the `NO_HELP_CENTER` feature gate.
