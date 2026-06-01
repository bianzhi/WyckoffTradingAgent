-- ============================================================
-- Wyckoff Trading Agent — 完整 Supabase 表结构
-- 在你自己的 Supabase 项目 SQL Editor 中执行全部语句即可
-- ============================================================

-- ──────────────────────────────────────────
-- 1. user_settings — 用户配置
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_settings (
    user_id             TEXT PRIMARY KEY,
    chat_provider       TEXT DEFAULT '1route',
    -- 自定义 provider (JSON)
    custom_providers    JSONB DEFAULT '{}'::jsonb,
    -- TickFlow
    tickflow_api_key    TEXT DEFAULT '',
    -- Tushare
    tushare_token       TEXT DEFAULT '',
    -- 通知渠道
    feishu_webhook      TEXT DEFAULT '',
    wecom_webhook       TEXT DEFAULT '',
    dingtalk_webhook    TEXT DEFAULT '',
    tg_bot_token        TEXT DEFAULT '',
    tg_chat_id          TEXT DEFAULT '',
    -- OpenAI
    openai_api_key      TEXT DEFAULT '',
    openai_model        TEXT DEFAULT '',
    openai_base_url     TEXT DEFAULT '',
    -- DeepSeek
    deepseek_api_key    TEXT DEFAULT '',
    deepseek_model      TEXT DEFAULT '',
    deepseek_base_url   TEXT DEFAULT '',
    -- Qwen（通义千问）
    qwen_api_key        TEXT DEFAULT '',
    qwen_model          TEXT DEFAULT '',
    qwen_base_url       TEXT DEFAULT '',
    -- Gemini
    gemini_api_key      TEXT DEFAULT '',
    gemini_model        TEXT DEFAULT '',
    gemini_base_url     TEXT DEFAULT '',
    -- Anthropic
    anthropic_api_key   TEXT DEFAULT '',
    anthropic_model     TEXT DEFAULT '',
    anthropic_base_url  TEXT DEFAULT '',
    -- 通用时间戳
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- RLS: 用户只能读写自己的设置
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own settings" ON public.user_settings
  FOR SELECT USING (auth.uid()::text = user_id);

CREATE POLICY "Users can insert own settings" ON public.user_settings
  FOR INSERT WITH CHECK (auth.uid()::text = user_id);

CREATE POLICY "Users can update own settings" ON public.user_settings
  FOR UPDATE USING (auth.uid()::text = user_id);

-- ──────────────────────────────────────────
-- 2. whitelist — 白名单（只有白名单用户可读数据库持仓）
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.whitelist (
    user_id     TEXT PRIMARY KEY,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ──────────────────────────────────────────
-- 3. market_signal_daily — 每日大盘信号
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.market_signal_daily (
    trade_date              TEXT PRIMARY KEY,
    -- 基准行情
    main_index_close        DOUBLE PRECISION,
    main_index_ma50         DOUBLE PRECISION,
    main_index_ma200        DOUBLE PRECISION,
    main_index_recent3_cum_pct  DOUBLE PRECISION,
    main_index_today_pct    DOUBLE PRECISION,
    -- 小盘指数
    smallcap_close          DOUBLE PRECISION,
    smallcap_recent3_cum_pct DOUBLE PRECISION,
    -- 新加坡 A50
    a50_close               DOUBLE PRECISION,
    a50_pct_chg             DOUBLE PRECISION,
    a50_value_date          TEXT,
    -- VIX
    vix_close               DOUBLE PRECISION,
    vix_pct_chg             DOUBLE PRECISION,
    vix_value_date          TEXT,
    -- 合成情绪字段
    benchmark_regime        TEXT,
    premarket_regime        TEXT,
    benchmark_slot          TEXT,
    premarket_slot          TEXT,
    market_posture_code     TEXT,
    market_posture_name     TEXT,
    wind_phrase             TEXT,
    water_phrase            TEXT,
    action_phrase           TEXT,
    -- 盘前理由 & 数据源元信息
    premarket_reasons       JSONB DEFAULT '[]'::jsonb,
    source_jobs             JSONB DEFAULT '{}'::jsonb,
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- ──────────────────────────────────────────
-- 4. recommendation_tracking — A 股推荐追踪
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.recommendation_tracking (
    id                  BIGSERIAL,
    code                INTEGER NOT NULL,
    name                TEXT DEFAULT '',
    recommend_reason    TEXT DEFAULT '',
    recommend_date      INTEGER NOT NULL,
    initial_price       DOUBLE PRECISION DEFAULT 0,
    current_price       DOUBLE PRECISION DEFAULT 0,
    change_pct          DOUBLE PRECISION DEFAULT 0,
    recommend_count     INTEGER DEFAULT 1,
    funnel_score        DOUBLE PRECISION,
    is_ai_recommended   BOOLEAN DEFAULT FALSE,
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (code, recommend_date)
);

-- ──────────────────────────────────────────
-- 5. recommendation_tracking_us — 美股推荐追踪
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.recommendation_tracking_us (
    id                  BIGSERIAL,
    code                TEXT NOT NULL,
    name                TEXT DEFAULT '',
    recommend_reason    TEXT DEFAULT '',
    recommend_date      INTEGER NOT NULL,
    initial_price       DOUBLE PRECISION DEFAULT 0,
    current_price       DOUBLE PRECISION DEFAULT 0,
    change_pct          DOUBLE PRECISION DEFAULT 0,
    funnel_score        DOUBLE PRECISION,
    is_ai_recommended   BOOLEAN DEFAULT FALSE,
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (code, recommend_date)
);

-- ──────────────────────────────────────────
-- 6. recommendation_tracking_hk — 港股推荐追踪
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.recommendation_tracking_hk (
    id                  BIGSERIAL,
    code                TEXT NOT NULL,
    name                TEXT DEFAULT '',
    recommend_reason    TEXT DEFAULT '',
    recommend_date      INTEGER NOT NULL,
    initial_price       DOUBLE PRECISION DEFAULT 0,
    current_price       DOUBLE PRECISION DEFAULT 0,
    change_pct          DOUBLE PRECISION DEFAULT 0,
    funnel_score        DOUBLE PRECISION,
    is_ai_recommended   BOOLEAN DEFAULT FALSE,
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (code, recommend_date)
);

-- ──────────────────────────────────────────
-- 7. signal_pending — 待确认的 L4 信号
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.signal_pending (
    id              BIGSERIAL PRIMARY KEY,
    code            INTEGER NOT NULL,
    name            TEXT DEFAULT '',
    signal_type     TEXT NOT NULL,
    signal_date     TEXT NOT NULL,
    signal_score    DOUBLE PRECISION DEFAULT 0,
    status          TEXT DEFAULT 'pending',
    ttl_days        INTEGER DEFAULT 0,
    days_elapsed    INTEGER DEFAULT 0,
    regime          TEXT DEFAULT 'NEUTRAL',
    industry        TEXT DEFAULT '',
    confirm_reason  TEXT DEFAULT '',
    confirm_date    TEXT,
    expire_date     TEXT,
    -- 价格快照
    snap_open       DOUBLE PRECISION,
    snap_high       DOUBLE PRECISION,
    snap_low        DOUBLE PRECISION,
    snap_close      DOUBLE PRECISION,
    snap_volume     DOUBLE PRECISION,
    snap_ma20       DOUBLE PRECISION,
    snap_ma50       DOUBLE PRECISION,
    snap_support    DOUBLE PRECISION,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ──────────────────────────────────────────
-- 8. portfolios — 投资组合
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.portfolios (
    portfolio_id    TEXT PRIMARY KEY,
    name            TEXT DEFAULT '我的持仓',
    free_cash       DOUBLE PRECISION DEFAULT 0,
    synced_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ──────────────────────────────────────────
-- 9. portfolio_positions — 持仓明细
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.portfolio_positions (
    portfolio_id    TEXT NOT NULL,
    code            TEXT NOT NULL,
    name            TEXT DEFAULT '',
    shares          INTEGER DEFAULT 0,
    cost_price      DOUBLE PRECISION DEFAULT 0,
    buy_dt          TEXT DEFAULT '',
    stop_loss       DOUBLE PRECISION,
    PRIMARY KEY (portfolio_id, code)
);

-- ──────────────────────────────────────────
-- 10. trade_orders — AI 生成交易指令
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trade_orders (
    id                      BIGSERIAL PRIMARY KEY,
    run_id                  TEXT NOT NULL,
    portfolio_id            TEXT NOT NULL,
    trade_date              TEXT NOT NULL,
    model                   TEXT DEFAULT '',
    market_view             TEXT DEFAULT '',
    code                    TEXT DEFAULT '',
    name                    TEXT DEFAULT '',
    action                  TEXT DEFAULT '',
    status                  TEXT DEFAULT '',
    shares                  INTEGER DEFAULT 0,
    price_hint              DOUBLE PRECISION,
    amount                  DOUBLE PRECISION DEFAULT 0,
    stop_loss               DOUBLE PRECISION,
    max_loss                DOUBLE PRECISION DEFAULT 0,
    drawdown_ratio          DOUBLE PRECISION DEFAULT 0,
    reason                  TEXT DEFAULT '',
    tape_condition          TEXT DEFAULT '',
    invalidate_condition    TEXT DEFAULT '',
    created_at              TIMESTAMPTZ DEFAULT NOW()
);

-- ──────────────────────────────────────────
-- 11. daily_nav — 每日净值
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.daily_nav (
    portfolio_id    TEXT NOT NULL,
    trade_date      TEXT NOT NULL,
    free_cash       DOUBLE PRECISION DEFAULT 0,
    positions_value DOUBLE PRECISION DEFAULT 0,
    total_equity    DOUBLE PRECISION DEFAULT 0,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (portfolio_id, trade_date)
);

-- ──────────────────────────────────────────
-- 12. tail_buy_history — 尾盘买入记录
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tail_buy_history (
    code                TEXT NOT NULL,
    name                TEXT DEFAULT '',
    run_date            TEXT NOT NULL,
    signal_date         TEXT DEFAULT '',
    signal_type         TEXT DEFAULT '',
    status              TEXT DEFAULT '',
    final_decision      TEXT DEFAULT 'BUY',
    rule_decision       TEXT DEFAULT '',
    rule_score          DOUBLE PRECISION DEFAULT 0,
    priority_score      DOUBLE PRECISION DEFAULT 0,
    rule_reasons        TEXT DEFAULT '',
    llm_decision        TEXT DEFAULT '',
    llm_reason          TEXT DEFAULT '',
    llm_confidence      DOUBLE PRECISION,
    llm_model_used      TEXT DEFAULT '',
    initial_price       DOUBLE PRECISION DEFAULT 0,
    current_price       DOUBLE PRECISION DEFAULT 0,
    change_pct          DOUBLE PRECISION DEFAULT 0,
    price_updated_at    TIMESTAMPTZ,
    last_close          DOUBLE PRECISION DEFAULT 0,
    vwap                DOUBLE PRECISION DEFAULT 0,
    dist_vwap_pct       DOUBLE PRECISION DEFAULT 0,
    close_pos           DOUBLE PRECISION DEFAULT 0,
    day_ret_pct         DOUBLE PRECISION DEFAULT 0,
    last30_ret_pct      DOUBLE PRECISION DEFAULT 0,
    last15_ret_pct      DOUBLE PRECISION DEFAULT 0,
    tail30_volume_share DOUBLE PRECISION DEFAULT 0,
    drop_from_high_pct  DOUBLE PRECISION DEFAULT 0,
    fetch_error         TEXT DEFAULT '',
    features_json       JSONB DEFAULT '{}'::jsonb,
    user_id             TEXT NOT NULL,
    UNIQUE (code, run_date, user_id)
);

-- ──────────────────────────────────────────
-- 13. concept_heat_history — 概念热度历史
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.concept_heat_history (
    trade_date      TEXT NOT NULL,
    concept_name    TEXT NOT NULL,
    pct             DOUBLE PRECISION DEFAULT 0,
    net_inflow      DOUBLE PRECISION DEFAULT 0,
    rank            INTEGER NOT NULL,
    source_id       TEXT DEFAULT '',
    UNIQUE (trade_date, concept_name)
);

-- ──────────────────────────────────────────
-- 14. signal_observations — L4 信号观察样本
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.signal_observations (
    id                  BIGSERIAL,
    market              TEXT NOT NULL DEFAULT 'cn',
    trade_date          TEXT NOT NULL,
    code                TEXT NOT NULL,
    name                TEXT DEFAULT '',
    signal_type         TEXT NOT NULL,
    track               TEXT DEFAULT 'Trend',
    regime              TEXT DEFAULT 'NEUTRAL',
    industry            TEXT DEFAULT '',
    stage               TEXT DEFAULT '',
    channel             TEXT DEFAULT '',
    trigger_score       DOUBLE PRECISION DEFAULT 0,
    priority_score      DOUBLE PRECISION DEFAULT 0,
    entry_price         DOUBLE PRECISION DEFAULT 0,
    selected_for_ai     BOOLEAN DEFAULT FALSE,
    ai_recommended      BOOLEAN DEFAULT FALSE,
    source              TEXT DEFAULT 'funnel',
    lifecycle_status    TEXT DEFAULT 'ACTIVE',
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (market, trade_date, code, signal_type)
);

-- ──────────────────────────────────────────
-- 15. signal_outcomes — 信号后续收益 / 回撤
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.signal_outcomes (
    observation_id      BIGINT NOT NULL,
    market              TEXT NOT NULL DEFAULT 'cn',
    trade_date          TEXT,
    code                TEXT DEFAULT '',
    signal_type         TEXT DEFAULT '',
    track               TEXT DEFAULT '',
    regime              TEXT DEFAULT 'NEUTRAL',
    horizon_days        INTEGER NOT NULL,
    status              TEXT DEFAULT 'pending',
    return_pct          DOUBLE PRECISION,
    max_drawdown_pct    DOUBLE PRECISION,
    UNIQUE (observation_id, horizon_days)
);

-- ──────────────────────────────────────────
-- 16. signal_health_daily — 按信号聚合的健康度快照
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.signal_health_daily (
    market              TEXT NOT NULL DEFAULT 'cn',
    as_of_date          TEXT NOT NULL,
    signal_type         TEXT NOT NULL,
    track               TEXT DEFAULT 'Trend',
    regime              TEXT NOT NULL DEFAULT 'NEUTRAL',
    horizon_days        INTEGER NOT NULL,
    sample_count        INTEGER DEFAULT 0,
    win_rate_pct        DOUBLE PRECISION,
    avg_return_pct      DOUBLE PRECISION,
    median_return_pct   DOUBLE PRECISION,
    avg_drawdown_pct    DOUBLE PRECISION,
    health_state        TEXT DEFAULT 'INSUFFICIENT',
    weight_multiplier   DOUBLE PRECISION DEFAULT 1.0,
    reason              TEXT DEFAULT '',
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (market, as_of_date, signal_type, regime, horizon_days)
);

-- ──────────────────────────────────────────
-- 17. signal_registry — 信号生命周期注册表
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.signal_registry (
    market              TEXT NOT NULL DEFAULT 'cn',
    signal_type         TEXT NOT NULL,
    track               TEXT DEFAULT 'Trend',
    status              TEXT DEFAULT 'ACTIVE',
    weight_multiplier   DOUBLE PRECISION DEFAULT 1.0,
    sample_count        INTEGER DEFAULT 0,
    win_rate_pct        DOUBLE PRECISION,
    avg_return_pct      DOUBLE PRECISION,
    horizon_days        INTEGER DEFAULT 10,
    reason              TEXT DEFAULT '',
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (market, signal_type)
);

-- ──────────────────────────────────────────
-- 18. signal_policy_shadow_runs — 动态策略 shadow run 记录
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.signal_policy_shadow_runs (
    market              TEXT NOT NULL DEFAULT 'cn',
    trade_date          TEXT NOT NULL,
    regime              TEXT DEFAULT 'NEUTRAL',
    base_policy         JSONB DEFAULT '{}'::jsonb,
    shadow_policy       JSONB DEFAULT '{}'::jsonb,
    signal_weights      JSONB DEFAULT '{}'::jsonb,
    base_selected       JSONB DEFAULT '[]'::jsonb,
    shadow_selected     JSONB DEFAULT '[]'::jsonb,
    diff_added          JSONB DEFAULT '[]'::jsonb,
    diff_removed        JSONB DEFAULT '[]'::jsonb,
    registry_snapshot   JSONB DEFAULT '[]'::jsonb,
    health_snapshot     JSONB DEFAULT '[]'::jsonb,
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (market, trade_date)
);

-- ──────────────────────────────────────────
-- 19. theme_radar_snapshot — 主题雷达快照
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.theme_radar_snapshot (
    trade_date      TEXT PRIMARY KEY,
    snapshot_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
    top_themes      TEXT[] DEFAULT '{}',
    top_candidates  TEXT[] DEFAULT '{}'
);

-- ============================================================
-- 索引建议（可选，加速常见查询）
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_recommendation_tracking_date
    ON public.recommendation_tracking (recommend_date DESC);
CREATE INDEX IF NOT EXISTS idx_recommendation_tracking_code
    ON public.recommendation_tracking (code);

CREATE INDEX IF NOT EXISTS idx_signal_pending_status
    ON public.signal_pending (status);
CREATE INDEX IF NOT EXISTS idx_signal_pending_date
    ON public.signal_pending (signal_date DESC);

CREATE INDEX IF NOT EXISTS idx_trade_orders_portfolio_date
    ON public.trade_orders (portfolio_id, trade_date DESC);

CREATE INDEX IF NOT EXISTS idx_tail_buy_user_date
    ON public.tail_buy_history (user_id, run_date DESC);

CREATE INDEX IF NOT EXISTS idx_signal_observations_date
    ON public.signal_observations (market, trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_signal_outcomes_date
    ON public.signal_outcomes (market, trade_date DESC);


-- ──────────────────────────────────────────
-- 20. funnel_requests — 漏斗选股请求队列
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.funnel_requests (
    id          BIGSERIAL PRIMARY KEY,
    user_id     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.funnel_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own funnel_requests" ON public.funnel_requests
  FOR SELECT USING (auth.uid()::text = user_id);

CREATE POLICY "Users can insert own funnel_requests" ON public.funnel_requests
  FOR INSERT WITH CHECK (auth.uid()::text = user_id);

CREATE INDEX IF NOT EXISTS idx_funnel_requests_user_date
    ON public.funnel_requests (user_id, created_at DESC);

-- ──────────────────────────────────────────
-- 21. analytics_excluded_users — 排除用户（不写入分析事件）
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.analytics_excluded_users (
    user_id     TEXT PRIMARY KEY,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.analytics_excluded_users ENABLE ROW LEVEL SECURITY;

-- 任何人都能读取排除列表（前端 isAnalyticsExcluded 检查用）
CREATE POLICY "Anyone can read excluded_users" ON public.analytics_excluded_users
    FOR SELECT USING (true);

-- 只有 service_role 能插入（通过后端或 SQL Editor 管理）
CREATE POLICY "Service role can insert excluded_users" ON public.analytics_excluded_users
    FOR INSERT WITH CHECK (true);

-- ──────────────────────────────────────────
-- 22. user_activity_events — 用户行为事件原始日志
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_activity_events (
    id          BIGSERIAL PRIMARY KEY,
    event_id    TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    source      TEXT DEFAULT 'web',
    session_id  TEXT NOT NULL,
    event_name  TEXT DEFAULT 'page_view',
    feature     TEXT DEFAULT '',
    route       TEXT NOT NULL,
    success     BOOLEAN DEFAULT TRUE,
    duration_ms INTEGER,
    app_version TEXT DEFAULT '',
    metadata    JSONB DEFAULT '{}'::jsonb,
    client_ts   TIMESTAMPTZ NOT NULL
);

ALTER TABLE public.user_activity_events ENABLE ROW LEVEL SECURITY;

-- 用户只能写入自己的事件（前端 recordActivity 用）
CREATE POLICY "Users can insert own events" ON public.user_activity_events
    FOR INSERT WITH CHECK (auth.uid()::text = user_id);

-- 用户只能读取自己的事件
CREATE POLICY "Users can read own events" ON public.user_activity_events
    FOR SELECT USING (auth.uid()::text = user_id);

-- ──────────────────────────────────────────
-- 23. user_daily_activity — 用户每日活动聚合
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_daily_activity (
    activity_date   TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    sources         TEXT[] DEFAULT '{}',
    event_count     INTEGER DEFAULT 0,
    session_count   INTEGER DEFAULT 0,
    first_seen_at   TIMESTAMPTZ,
    last_seen_at    TIMESTAMPTZ,
    feature_counts  JSONB DEFAULT '{}'::jsonb,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (activity_date, user_id)
);

ALTER TABLE public.user_daily_activity ENABLE ROW LEVEL SECURITY;

-- 用户只能写入自己的聚合（前端 upsertDailyActivity 用）
CREATE POLICY "Users can upsert own daily" ON public.user_daily_activity
    FOR INSERT WITH CHECK (auth.uid()::text = user_id);

CREATE POLICY "Users can update own daily" ON public.user_daily_activity
    FOR UPDATE USING (auth.uid()::text = user_id);

-- 用户只能读取自己的聚合
CREATE POLICY "Users can read own daily" ON public.user_daily_activity
    FOR SELECT USING (auth.uid()::text = user_id);

-- ============================================================
-- 索引（analytics 表查询加速）
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_activity_events_user
    ON public.user_activity_events (user_id, client_ts DESC);
CREATE INDEX IF NOT EXISTS idx_daily_activity_user_date
    ON public.user_daily_activity (user_id, activity_date DESC);

-- ============================================================
-- 完成！共 23 张表。
-- 如需重建，请在 Supabase Dashboard → SQL Editor 执行全部语句。
-- ============================================================
