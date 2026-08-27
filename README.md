# Legends Wallet

Legends Wallet is a self-custodial TRON wallet for TRX and USDT TRC-20. The web app and Telegram Mini App keep private keys on the user's device and expose only the TRON product surface.

This repository is a GPL-3.0 fork of [My Wallet](https://github.com/mytonwallet-org/mytonwallet). The original copyright notices and license are preserved. See [NOTICE.md](NOTICE.md) for provenance and the main product changes.

## Requirements

- Node.js 22.6+ or 24
- npm 10.8+ or 11

## Development

```bash
cp .env.example .env
npm ci
npm run dev
```

The fork defaults to `IS_TRON_ONLY=1`. Set `IS_TRON_ONLY=0` only when validating compatibility with the upstream multichain code.

## Builds

```bash
npm run build:production
npm run telegram:build:production
```

Runtime API URLs and credentials must be supplied through environment variables. Never commit production secrets.

## License

GPL-3.0. See [LICENSE](LICENSE).
