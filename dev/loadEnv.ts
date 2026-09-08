import dotenv from 'dotenv';

const appEnv = process.env.APP_ENV || 'production';
const envFile = process.env.APP_RUNTIME_ENV_FILE || (appEnv === 'development' ? '.env.testnode' : undefined);
const result = dotenv.config(envFile ? { path: envFile } : undefined);

if (result.error && appEnv === 'development') {
  throw new Error(`Development environment file is required: ${envFile}`);
}

if (appEnv === 'development') {
  const requiredLocalUrls = [
    'BASE_URL',
    'BRILLIANT_API_BASE_URL',
    'TRON_MAINNET_API_URL',
    'TRON_TESTNET_API_URL',
    'TRON_MAINNET_HISTORY_API_URL',
    'TRON_TESTNET_HISTORY_API_URL',
  ];

  for (const key of requiredLocalUrls) {
    const value = process.env[key];
    if (!value) throw new Error(`Missing ${key} in ${envFile}`);

    const hostname = new URL(value).hostname;
    if (hostname === 'legends.energy' || hostname.endsWith('.legends.energy')) {
      throw new Error(`Development ${key} must not target production: ${hostname}`);
    }
  }
}
