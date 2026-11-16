import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let supabaseClient: SupabaseClient | undefined

export function getSupabaseClient(): SupabaseClient {
  if (supabaseClient) {
    return supabaseClient
  }

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()

  if (!supabaseUrl || !publishableKey) {
    const missingVariables = [
      !supabaseUrl && 'VITE_SUPABASE_URL',
      !publishableKey && 'VITE_SUPABASE_PUBLISHABLE_KEY',
    ].filter((variable): variable is string => Boolean(variable))

    throw new Error(
      `Supabase is not configured. Set ${missingVariables.join(' and ')} in .env.local (see .env.example).`,
    )
  }

  supabaseClient = createClient(supabaseUrl, publishableKey)
  return supabaseClient
}
