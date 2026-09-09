export type ApiWalletPrepaidCoverageMode = 'auto' | 'prepaid' | 'direct';

export type ApiWalletBalanceIntegrationAuth = {
  type: 'api_key';
  apiKey: string;
} | {
  type: 'telegram_mini_app';
  initData: string;
  botCode?: string;
  projectId?: number;
};

export type ApiWalletBalanceIntegrationProject = {
  id: number;
  name: string;
  balance_trx: string;
  available_trx: string;
};

export type ApiWalletBalanceIntegrationProjects = {
  auth_method: 'api_key' | 'telegram_mini_app';
  bot_username?: string | null;
  projects: ApiWalletBalanceIntegrationProject[];
};

export type ApiWalletBalanceIntegration = {
  id: string;
  auth_method: 'api_key' | 'telegram_mini_app';
  project_name: string;
  has_multiple_projects?: boolean;
  bot_username?: string | null;
  balance_trx: string;
  reserved_trx: string;
  available_trx: string;
};

export type ApiWalletPrepaidAddress = {
  address: string;
  role: 'owner' | 'linked';
  coverage_mode: ApiWalletPrepaidCoverageMode;
  linked_at: string;
};

export type ApiWalletPrepaidTopupAsset = {
  asset_code: string;
  token_contract?: string | null;
  decimals: number;
  minimum_usdt: string;
};

export type ApiWalletPrepaidEntry = {
  id: string;
  type: string;
  amount_trx: string;
  balance_after_trx: string;
  asset_code?: string;
  asset_amount?: string;
  tx_hash?: string;
  description?: string;
  created_at: string;
};

export type ApiWalletPrepaidOverview = {
  balance_id?: string;
  network: 'mainnet' | 'testnet';
  enabled: boolean;
  status: string;
  balance_source: 'prepaid' | 'bot_project';
  integration?: ApiWalletBalanceIntegration | null;
  balance_trx: string;
  reserved_trx: string;
  available_trx: string;
  balance_sun: number;
  reserved_sun: number;
  available_sun: number;
  coverage_mode: ApiWalletPrepaidCoverageMode;
  deposit_address?: string;
  minimum_topup_usdt: string;
  topup_assets: ApiWalletPrepaidTopupAsset[];
  addresses: ApiWalletPrepaidAddress[];
  entries: ApiWalletPrepaidEntry[];
  topups: Array<{
    id: string;
    status: string;
    asset_code: string;
    amount: string;
    amount_usdt?: string;
    credited_trx: string;
    resource_charge_trx: string;
    tx_hash?: string;
    created_at: string;
  }>;
};
