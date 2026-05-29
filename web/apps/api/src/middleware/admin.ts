import { createMiddleware } from 'hono/factory'
import { createClient } from '@supabase/supabase-js'
import type { Env } from '../index'

/**
 * Admin middleware — must run AFTER authMiddleware.
 * Checks user_roles table; denies if not 'admin'.
 */
export const adminMiddleware = createMiddleware<{
  Bindings: Env
  Variables: { auth: { userId: string; accessToken: string } }
}>(async (c, next) => {
  const userId = c.get('auth').userId
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY)

  const { data, error } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', userId)
    .maybeSingle()

  if (error || !data || data.role !== 'admin') {
    return c.json({ error: 'Forbidden: admin only' }, 403)
  }

  await next()
})
