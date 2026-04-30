export type Market = 'us' | 'kr'

export type CostConfig = {
  commissionRate: number
  slippageBps: number
  taxRate: number
}

export const DEFAULT_COST_CONFIG: Record<Market, CostConfig> = {
  us: {
    commissionRate: 0.0005,
    slippageBps: 10,
    taxRate: 0,
  },
  kr: {
    commissionRate: 0.00015,
    slippageBps: 20,
    taxRate: 0.0018,
  },
}

export function resolveCostConfig(
  market: Market,
  overrides?: Partial<CostConfig>,
): CostConfig {
  const base = DEFAULT_COST_CONFIG[market]
  return {
    commissionRate: overrides?.commissionRate ?? base.commissionRate,
    slippageBps: overrides?.slippageBps ?? base.slippageBps,
    taxRate: overrides?.taxRate ?? base.taxRate,
  }
}

export function applyEntryPrice(price: number, config: CostConfig) {
  const slippageRate = config.slippageBps / 10000
  const slipped = price * (1 + slippageRate)
  const fee = slipped * config.commissionRate
  return {
    effectivePrice: slipped + fee,
    costAmount: fee + price * slippageRate,
  }
}

export function applyExitPrice(price: number, config: CostConfig) {
  const slippageRate = config.slippageBps / 10000
  const slipped = price * (1 - slippageRate)
  const fee = slipped * config.commissionRate
  const tax = slipped * config.taxRate
  return {
    effectivePrice: slipped - fee - tax,
    costAmount: fee + tax + price * slippageRate,
  }
}
