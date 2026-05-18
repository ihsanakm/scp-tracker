import { createClient } from "@supabase/supabase-js";

// Load from environment variables
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "";
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

export const isSupabaseConfigured = !!(supabaseUrl && supabaseAnonKey);

if (!isSupabaseConfigured) {
  console.warn(
    "⚠️ Supabase environment variables are missing. Falling back to browser LocalStorage.\n" +
    "To connect your live database, add the following to your .env file:\n" +
    "VITE_SUPABASE_URL=your-supabase-url\n" +
    "VITE_SUPABASE_ANON_KEY=your-supabase-anon-key"
  );
}

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;
