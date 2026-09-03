import dotenv from 'dotenv';

const envFile = process.env.APP_RUNTIME_ENV_FILE;

dotenv.config(envFile ? { path: envFile } : undefined);
