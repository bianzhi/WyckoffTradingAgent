import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolDeps, KlineRow } from '../chat-tools'
import {
  buildValueAgentDigest,
  buildKlineDigest,
  execSearchStock,
  execViewPortfolio,
  execMarketOverview,
  execQueryRecommendations,
  execQueryTailBuy,
  execExecutePortfolioUpdate,
  execScreenStocks,
  execAnalyzeStock,
  execMarketHistory,
  execGetSignalQuality,
  execPortfolioRisk,
  execTuneParameters,
} from '../chat-tools'

// ── mock DataSkill ─────────────────────────────────────────
// Tools no longer make direct TickFlow/tushare calls; they delegate to
// /api/data/* via DataSkill.  We mock DataSkill methods to control the
// data pipeline and test tool logic (digest building, error handling).

vi.mock('../data-skill', () => ({
  dataSkill: {
    fetchKline: vi.fn(),
    fetchIndex: vi.fn(),
    fetchValueSnapshot: vi.fn(),
    fetchQuotes: vi.fn().mockResolvedValue({}),
    fetchIndexLive: vi.fn().mockRejectedValue(new Error('no-key')),
    fetchIntraday: vi.fn().mockResolvedValue({ symbol: '', periods: {}, error: 'no-key' }),
    fetchSignalQuality: vi.fn().mockResolvedValue({ report: '', error: 'no-key' }),
    fetchPortfolioRisk: vi.fn().mockResolvedValue({ error: 'no-key' }),
    fetchParameterTuning: vi.fn().mockResolvedValue({ error: 'no-key' }),
  },
}))

import { dataSkill } from '../data-skill'

// ── helpers ────────────────────────────────────────────────

function createMockChain(resolvedData: unknown = null, error: unknown = null) {
  const chain: Record<string, unknown> = {}
  const terminal = () => Promise.resolve({ data: resolvedData, error })
  for (const method of ['select', 'eq', 'ilike', 'order', 'limit', 'delete', 'update', 'maybeSingle']) {
    chain[method] = vi.fn().mockReturnValue(chain)
  }
  chain['insert'] = vi.fn().mockImplementation(terminal)
  chain['single'] = vi.fn().mockImplementation(terminal)
  chain['upsert'] = vi.fn().mockImplementation(terminal)
  // make the chain itself thenable for queries without .single()
  chain['then'] = (resolve: (v: unknown) => void) => resolve({ data: resolvedData, error })
  return chain
}

function createPortfolioWriteDeps(existingRow: Record<string, unknown> | null) {
  const updateChain = createMockChain(existingRow)
  const insertChain = createMockChain(null)
  const mockFrom = vi.fn()
    .mockReturnValueOnce(updateChain)   // first from(): maybeSingle query
    .mockReturnValueOnce(insertChain)   // second from(): insert
  const deps = {
    supabase: { from: mockFrom } as unknown as ToolDeps['supabase'],
    fetch: vi.fn(),
    generateText: vi.fn(),
  } as unknown as ToolDeps
  return { deps, updateChain, insertChain }
}

function createMockDeps(tableData: Record<string, unknown> = {}): ToolDeps {
  const mockFrom = vi.fn().mockImplementation((table: string) => {
    const data = tableData[table] ?? null
    return createMockChain(data)
  })

  return {
    supabase: { from: mockFrom } as unknown as ToolDeps['supabase'],
    fetch: vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) } as Response),
    generateText: vi.fn().mockResolvedValue({ text: 'mocked LLM response' }),
  }
}

function makeKlineRows(n: number, base = 10): KlineRow[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2024-01-${String(i + 1).padStart(2, '0')}`,
    open: base + i * 0.1,
    high: base + i * 0.1 + 0.5,
    low: base + i * 0.1 - 0.3,
    close: base + i * 0.12,
    volume: 100000 + i * 1000,
  }))
}

// ── tests ──────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  // Reset DataSkill mocks to defaults
  const mockDS = vi.mocked(dataSkill)
  mockDS.fetchKline.mockReset().mockResolvedValue({ source: 'mock', rows: [], error: 'mock-not-configured' })
  mockDS.fetchIndex.mockReset().mockResolvedValue({ source: 'mock', rows: [], error: 'mock-not-configured' })
  mockDS.fetchValueSnapshot.mockReset().mockResolvedValue({ symbol: '', source: 'none', metrics: null, reason: 'missing-source' } as const)
  mockDS.fetchQuotes.mockReset().mockResolvedValue({})
  mockDS.fetchIndexLive.mockReset().mockRejectedValue(new Error('no-key'))
  mockDS.fetchIntraday.mockReset().mockResolvedValue({ symbol: '', periods: {}, error: 'no-key' })
})

describe('buildKlineDigest', () => {
  it('returns placeholder for empty data', () => {
    expect(buildKlineDigest([])).toBe('无可用K线数据')
  })

  it('produces stable output for 5 rows', () => {
    const rows = makeKlineRows(5)
    expect(buildKlineDigest(rows)).toMatchSnapshot()
  })

  it('produces stable output for 20 rows', () => {
    const rows = makeKlineRows(20)
    expect(buildKlineDigest(rows)).toMatchSnapshot()
  })

  it('includes MA50 for 50+ rows', () => {
    const rows = makeKlineRows(60)
    const result = buildKlineDigest(rows)
    expect(result).toContain('MA50=')
  })

  it('includes MA120 for 120+ rows', () => {
    const rows = makeKlineRows(130)
    const result = buildKlineDigest(rows)
    expect(result).toContain('MA120=')
  })
})

describe('buildValueAgentDigest', () => {
  it('adds score signals to the compact value prompt', () => {
    const digest = buildValueAgentDigest({
      symbol: '600519.SH',
      source: 'tickflow',
      metrics: {
        period_end: '2026-03-31',
        roe: 18.2,
        net_income_yoy: 11.8,
        revenue_yoy: 6.5,
        gross_margin: 91.6,
        debt_to_asset_ratio: 21.4,
        operating_cash_to_revenue: 16.2,
      },
    })

    expect(digest).toContain('价值面摘要（来源：TickFlow，报告期：2026-03-31）')
    expect(digest).toContain('ROE=18.20%')
    expect(digest).toContain('价值面评级：稳健')
    expect(digest).toContain('质量信号：')
  })
})

describe('execSearchStock', () => {
  it('returns not-found message when no results', async () => {
    const deps = createMockDeps({
      recommendation_tracking: [],
      portfolio_positions: [],
      tail_buy_history: [],
    })
    const result = await execSearchStock(deps, 'user1', '999999')
    expect(result).toContain('未找到匹配')
  })

  it('returns formatted stock list with code and name', async () => {
    const stocks = [{ code: 600519, name: '贵州茅台' }]
    const deps = createMockDeps({
      recommendation_tracking: stocks,
      portfolio_positions: [],
      tail_buy_history: [],
    })
    const result = await execSearchStock(deps, 'user1', '贵州')
    expect(result).toContain('600519')
    expect(result).toContain('贵州茅台')
  })
})

describe('execViewPortfolio', () => {
  it('returns empty portfolio message', async () => {
    const deps = createMockDeps({
      portfolios: { free_cash: 50000 },
      portfolio_positions: [],
    })
    const result = await execViewPortfolio(deps, 'user1')
    expect(result).toContain('当前无持仓')
    expect(result).toContain('50,000')
  })

  it('returns formatted positions', async () => {
    const deps = createMockDeps({
      portfolios: { free_cash: 10000 },
      portfolio_positions: [
        { code: '000001', name: '平安银行', shares: 1000, cost_price: 12.5, buy_dt: '2024-01-01', stop_loss: 11.0 },
      ],
    })
    const result = await execViewPortfolio(deps, 'user1')
    expect(result).toContain('持仓 1 只')
    expect(result).toContain('平安银行')
    expect(result).toContain('1000股')
  })
})

describe('execMarketOverview', () => {
  it('returns no-data message when DB empty and index-live unavailable', async () => {
    const deps = createMockDeps({ market_signal_daily: [] })
    const result = await execMarketOverview(deps)
    expect(result).toContain('暂无最新市场信号数据')
  })

  it('returns formatted market data', async () => {
    const deps = createMockDeps({
      market_signal_daily: [
        { benchmark_regime: 'RISK_ON', main_index_close: 3200, main_index_today_pct: 1.5, a50_close: 14000, a50_pct_chg: 0.8, vix_close: 15.2 },
      ],
    })
    const result = await execMarketOverview(deps)
    expect(result).toContain('偏强')
    expect(result).toContain('3200')
  })

  it('falls back to live quotes when DB has data but missing fields', async () => {
    const deps = createMockDeps({
      market_signal_daily: [{ benchmark_regime: 'NEUTRAL' }],
    })
    const result = await execMarketOverview(deps)
    expect(result).toContain('中性')
  })
})

describe('execMarketHistory', () => {
  it('builds index digest and returns LLM analysis via DataSkill', async () => {
    const deps = createMockDeps({})
    const mockDS = vi.mocked(dataSkill)
    mockDS.fetchIndex.mockResolvedValue({
      source: 'tickflow',
      rows: makeKlineRows(3, 3000).map(r => ({ ...r, close: r.close + 2000 })),
    })

    const result = await execMarketHistory(deps, 'user1', {}, 100, 'sse')

    expect(result).toBe('mocked LLM response')
    expect(mockDS.fetchIndex).toHaveBeenCalledWith('000001.SH', 100)
    expect(deps.generateText).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('最近3个交易日'),
    }))
  })

  it('returns error message when DataSkill fails', async () => {
    const deps = createMockDeps({})
    const mockDS = vi.mocked(dataSkill)
    mockDS.fetchIndex.mockResolvedValue({ source: 'none', rows: [], error: 'no key configured' })

    const result = await execMarketHistory(deps, 'user1', {}, 100, 'sse')

    expect(result).toContain('无法获取')
    expect(result).toContain('上证指数')
    expect(result).toContain('来源')
    expect(result).toContain('no key configured')
  })
})

describe('execQueryRecommendations', () => {
  it('returns no-data message when empty', async () => {
    const deps = createMockDeps({ recommendation_tracking: [] })
    const result = await execQueryRecommendations(deps, 10)
    expect(result).toBe('暂无推荐记录')
  })

  it('formats recommendation entries', async () => {
    const deps = createMockDeps({
      recommendation_tracking: [
        { code: 600519, name: '贵州茅台', recommend_date: 20240101, recommend_count: 3, initial_price: 1800, current_price: 1900, change_pct: 5.56, is_ai_recommended: true },
      ],
    })
    const result = await execQueryRecommendations(deps, 10)
    expect(result).toContain('600519')
    expect(result).toContain('推荐3次')
    expect(result).toContain('+5.56%')
    expect(result).toContain('[AI]')
  })
})

describe('execQueryTailBuy', () => {
  it('returns no-data message when empty', async () => {
    const deps = createMockDeps({ tail_buy_history: [] })
    const result = await execQueryTailBuy(deps, 10)
    expect(result).toBe('暂无尾盘买入记录')
  })
})

describe('execExecutePortfolioUpdate', () => {
  it('handles delete action', async () => {
    const deps = createMockDeps({ portfolio_positions: null })
    const result = await execExecutePortfolioUpdate(deps, 'user1', 'delete', '600519', '贵州茅台', null, null, null)
    expect(result).toContain('已删除')
    expect(result).toContain('600519')
  })

  it('rejects add without required fields', async () => {
    const deps = createMockDeps({})
    const result = await execExecutePortfolioUpdate(deps, 'user1', 'add', '600519', null, null, null, null)
    expect(result).toContain('执行失败')
  })

  it('handles add action with all fields', async () => {
    const deps = createMockDeps({ portfolio_positions: null })
    const result = await execExecutePortfolioUpdate(deps, 'user1', 'add', '600519', '贵州茅台', 100, 1800, 1700)
    expect(result).toContain('已新增')
    expect(result).toContain('100股')
  })

  it('updates an existing position without inserting a duplicate row', async () => {
    const { deps, insertChain } = createPortfolioWriteDeps({ id: 'pos-1' })

    const result = await execExecutePortfolioUpdate(deps, 'user1', 'update', '600519', '贵州茅台', 200, 1810, 1700)

    expect(result).toContain('已更新')
    expect(insertChain.update).toHaveBeenCalledWith(expect.objectContaining({ name: '贵州茅台', shares: 200 }))
    expect(insertChain.eq).toHaveBeenCalledWith('id', 'pos-1')
    expect(insertChain.insert).not.toHaveBeenCalled()
  })

  it('inserts a position only when no existing row matches', async () => {
    const { deps, insertChain } = createPortfolioWriteDeps(null)

    const result = await execExecutePortfolioUpdate(deps, 'user1', 'add', '600519', '贵州茅台', 100, 1800, 1700)

    expect(result).toContain('已新增')
    expect(insertChain.insert).toHaveBeenCalledWith(expect.objectContaining({ portfolio_id: 'USER_LIVE:user1', code: '600519' }))
  })
})

describe('execScreenStocks', () => {
  it('returns no-data message when empty', async () => {
    const deps = createMockDeps({ recommendation_tracking: [] })
    const result = await execScreenStocks(deps)
    const parsed = JSON.parse(result)
    expect(parsed.stocks).toEqual([])
    expect(parsed.meta.ai_count).toBe(0)
  })
})

describe('execAnalyzeStock', () => {
  it('builds full digest from K-line + value snapshot via DataSkill', async () => {
    const deps = createMockDeps({})
    const mockDS = vi.mocked(dataSkill)

    mockDS.fetchKline.mockResolvedValue({
      source: 'tickflow',
      rows: makeKlineRows(2, 100),
    })

    mockDS.fetchValueSnapshot.mockResolvedValue({
      symbol: '600519.SH',
      source: 'tickflow',
      metrics: {
        period_end: '2026-03-31',
        roe: 18.2,
        net_income_yoy: 11.8,
        revenue_yoy: 6.5,
        gross_margin: 91.6,
        net_margin: 48.3,
        debt_to_asset_ratio: 21.4,
        operating_cash_to_revenue: 16.2,
      },
      reason: undefined,
    })

    const result = await execAnalyzeStock(
      deps,
      'user1',
      { api_key: 'llm-key', model: 'test-model', base_url: 'https://example.com/v1' },
      {},
      '600519',
      '贵州茅台',
    )

    expect(result).toBe('mocked LLM response')
    expect(mockDS.fetchKline).toHaveBeenCalledWith('600519', 250)
    expect(mockDS.fetchValueSnapshot).toHaveBeenCalledWith('600519')
    expect(deps.generateText).toHaveBeenCalledWith(expect.objectContaining({
      system: expect.stringContaining('价值面校准'),
      prompt: expect.stringContaining('价值面摘要（来源：TickFlow，报告期：2026-03-31）'),
    }))
    expect(deps.generateText).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('K线共2根'),
    }))
  })

  it('falls back to tushare when TickFlow value fails', async () => {
    const deps = createMockDeps({})
    const mockDS = vi.mocked(dataSkill)

    mockDS.fetchKline.mockResolvedValue({
      source: 'tushare',
      rows: makeKlineRows(5, 10),
    })

    mockDS.fetchValueSnapshot.mockResolvedValue({
      symbol: '000001.SZ',
      source: 'tushare',
      metrics: {
        period_end: '20251231',
        eps_basic: 2.5,
        bps: 15.0,
        roe: 16.0,
      },
      reason: undefined,
    })

    const result = await execAnalyzeStock(
      deps,
      'user1',
      { api_key: 'llm-key', model: 'test-model', base_url: 'https://example.com/v1' },
      {},
      '000001',
      '平安银行',
    )

    expect(result).toBe('mocked LLM response')
    expect(mockDS.fetchKline).toHaveBeenCalledWith('000001', 250)
    expect(mockDS.fetchValueSnapshot).toHaveBeenCalledWith('000001')
  })

  it('explains missing data for market symbols', async () => {
    const deps = createMockDeps({})
    const mockDS = vi.mocked(dataSkill)
    mockDS.fetchKline.mockResolvedValue({ source: 'none', rows: [], error: 'not found' })

    const result = await execAnalyzeStock(
      deps,
      'user1',
      { api_key: 'llm-key', model: 'test-model', base_url: 'https://example.com/v1' },
      {},
      'AAPL.US',
      '苹果',
    )

    expect(result).toContain('请在设置中配置 TickFlow API Key')
    expect(mockDS.fetchKline).toHaveBeenCalledWith('AAPL.US', 250)
  })
})

describe('execGetSignalQuality', () => {
  it('returns report when available', async () => {
    const mockDS = vi.mocked(dataSkill)
    mockDS.fetchSignalQuality.mockResolvedValue({
      report: '## 信号注册表\n\n| 信号 | 赛道 | 状态 |\n|------|------|------|\n| sos | Trend | HEALTHY |',
    })

    const result = await execGetSignalQuality()

    expect(result).toContain('信号注册表')
    expect(result).toContain('sos')
    expect(result).toContain('HEALTHY')
  })

  it('returns error message when fetch fails', async () => {
    const mockDS = vi.mocked(dataSkill)
    mockDS.fetchSignalQuality.mockResolvedValue({ report: '', error: 'DB connection failed' })

    const result = await execGetSignalQuality()

    expect(result).toContain('信号质量数据获取失败')
    expect(result).toContain('DB connection failed')
  })

  it('returns empty message when no data', async () => {
    const mockDS = vi.mocked(dataSkill)
    mockDS.fetchSignalQuality.mockResolvedValue({ report: '' })

    const result = await execGetSignalQuality()

    expect(result).toContain('暂无信号质量数据')
  })
})

describe('execPortfolioRisk', () => {
  it('returns error when positions list is empty', async () => {
    const deps = createMockDeps({})
    const result = await execPortfolioRisk(deps, [], null)
    expect(result).toContain('请提供持仓列表')
  })

  it('returns error from API', async () => {
    const deps = createMockDeps({})
    vi.mocked(dataSkill).fetchPortfolioRisk.mockResolvedValue({ error: '无法获取任何持仓的K线数据' })
    const result = await execPortfolioRisk(deps, [{ code: '000001', shares: 1000, cost_price: 12.5 }], null)
    expect(result).toContain('风险分析失败')
    expect(result).toContain('无法获取任何持仓的K线数据')
  })

  it('builds full risk report', async () => {
    const deps = createMockDeps({})
    vi.mocked(dataSkill).fetchPortfolioRisk.mockResolvedValue({
      portfolio: { total_value: 50000, position_count: 3, positions: [] },
      var: {
        historical_95pct: 2.5, parametric_95pct: 2.8, historical_99pct: 4.2,
        cvar_95pct: 3.1, cvar_99pct: 5.0, portfolio_var_95pct: 2.6, portfolio_cvar_95pct: 3.3,
      },
      volatility: { annualized_vol_pct: 18.5 },
      max_drawdown: { max_drawdown_pct: -12.3, peak_value: 58000, trough_value: 50866 },
      correlation: { high_correlation_warnings: ['⚠️ 高相关对（>0.7）：000001-600519(0.82)'] },
      stress_test: [
        { scenario: '温和回调 (-5%)', loss_amount: -2500, loss_pct: -5, remaining_value: 47500, remaining_pct: 95 },
        { scenario: '股灾 (-30%)', loss_amount: -15000, loss_pct: -30, remaining_value: 35000, remaining_pct: 70 },
      ],
    })

    const result = await execPortfolioRisk(deps, [
      { code: '000001', shares: 1000, cost_price: 12.5 },
      { code: '600519', shares: 100, cost_price: 1800 },
      { code: '000333', shares: 500, cost_price: 55 },
    ], 252)

    expect(result).toContain('组合风险报告')
    expect(result).toContain('50000 元')
    expect(result).toContain('历史 VaR(95%)')
    expect(result).toContain('2.5%')
    expect(result).toContain('年化波动率')
    expect(result).toContain('18.5%')
    expect(result).toContain('-12.3%')
    expect(result).toContain('高相关对')
    expect(result).toContain('000001-600519')
    expect(result).toContain('压力测试')
    expect(result).toContain('股灾 (-30%)')
  })
})

describe('execTuneParameters', () => {
  it('returns error from API', async () => {
    vi.mocked(dataSkill).fetchParameterTuning.mockResolvedValue({ error: '无法获取基准指数数据' })
    const result = await execTuneParameters(null, null, null)
    expect(result).toContain('参数调优失败')
    expect(result).toContain('无法获取基准指数数据')
  })

  it('returns empty message when no data', async () => {
    vi.mocked(dataSkill).fetchParameterTuning.mockResolvedValue({})
    const result = await execTuneParameters(null, null, null)
    expect(result).toContain('参数调优对比')
  })

  it('renders full tuning report', async () => {
    vi.mocked(dataSkill).fetchParameterTuning.mockResolvedValue({
      regime: 'RISK_OFF',
      market_context: { close: 3050.2, ma50: 3120.5, ma200: 3001.8, recent3_cum_pct: -3.5, main_volume_state: '缩量', main_vol_ratio_5_20: 0.72, smallcap_recent3_cum_pct: -5.2 },
      panic: { triggered: false, reasons: [] },
      repair: { triggered: false, reasons: [] },
      breadth: { ratio_pct: 18.5, delta_pct: -8.2, sample_size: 4823 },
      outlook_summary: '防守优先',
      outlook: '次日推演：防守优先，若出现放量下压并失守MA50，继续收缩风险敞口。',
      before_after: {
        before: { min_avg_amount_wan: 5000, rs_min_long: 2.0, rs_min_short: 1.0, rps_fast_min: 65, rps_slow_min: 70, enable_evr_trigger: true },
        after: { min_avg_amount_wan: 8000, rs_min_long: 2.0, rs_min_short: 0.5, rps_fast_min: 80, rps_slow_min: 75, enable_evr_trigger: true },
        changed: { min_avg_amount_wan: true, rs_min_long: false, rs_min_short: true, rps_fast_min: true, rps_slow_min: true, enable_evr_trigger: false },
      },
    })

    const result = await execTuneParameters('000001', '399006', 252)

    expect(result).toContain('自适应参数调优报告')
    expect(result).toContain('RISK_OFF')
    expect(result).toContain('3050.2')
    expect(result).toContain('缩量')
    expect(result).toContain('18.5%')
    expect(result).toContain('✅')
    expect(result).toContain('—')
    expect(result).toContain('防守优先')
  })
})
