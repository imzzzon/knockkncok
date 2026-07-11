import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import {
  SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_URL,
} from "./supabase-config.mjs";

const VISITOR_ID_KEY = "knockknock_visitor_id";

export const isSupabaseConfigured =
  SUPABASE_URL.startsWith("https://") &&
  SUPABASE_PUBLISHABLE_KEY !== "YOUR_SUPABASE_PUBLISHABLE_KEY";

export const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
);

export function getVisitorId() {
  const existingId = localStorage.getItem(VISITOR_ID_KEY);

  if (existingId) {
    return existingId;
  }

  const newId =
    crypto.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  localStorage.setItem(VISITOR_ID_KEY, newId);
  return newId;
}
