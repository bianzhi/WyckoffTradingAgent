-- ============================================================
-- 管理员角色 & 系统全局配置
-- 在你的 Supabase 项目 SQL Editor 中执行即可
-- ============================================================

-- 1. user_roles — 用户角色（目前只区分 admin / member）
CREATE TABLE IF NOT EXISTS public.user_roles (
    user_id     UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
-- 所有登录用户可查看自己角色
CREATE POLICY "Users can read own role" ON public.user_roles
  FOR SELECT USING (auth.uid() = user_id);
-- 仅当前 admin 可为他人赋权（未来扩展）
CREATE POLICY "Admins can insert" ON public.user_roles
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin'
  ));
CREATE POLICY "Admins can update" ON public.user_roles
  FOR UPDATE USING (EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin'
  ));

-- 2. system_settings — 管理员配置的全局资源（LLM、数据源、通知）
CREATE TABLE IF NOT EXISTS public.system_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL DEFAULT '',
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
-- 所有登录用户可读取（通过 /api/settings/system-config）
CREATE POLICY "Authenticated users can read" ON public.system_settings
  FOR SELECT USING (auth.role() = 'authenticated');
-- 仅 admin 可写入
CREATE POLICY "Admins can insert" ON public.system_settings
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin'
  ));
CREATE POLICY "Admins can update" ON public.system_settings
  FOR UPDATE USING (EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin'
  ));

-- 3. 初始化种子：将环境变量中的配置迁入 system_settings（如有）
-- 运行前先把环境变量值替换到下面的占位符，或运行后在 Web UI 中配置
INSERT INTO public.system_settings (key, value) VALUES
  ('llm_provider', ''),
  ('llm_api_key', ''),
  ('llm_model', ''),
  ('llm_base_url', ''),
  ('tickflow_api_key', ''),
  ('tushare_token', '')
ON CONFLICT (key) DO NOTHING;
