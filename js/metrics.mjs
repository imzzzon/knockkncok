import {
  getVisitorId,
  isSupabaseConfigured,
  supabase,
} from "./supabase-client.mjs";

const ROOM_ID = "hospital-001";
let currentPage = "hospital";

export function setMetricsPage(page) {
  currentPage = page;
}

export function getMetricsPage() {
  return currentPage;
}

export async function logEvent(eventName, metadata = {}) {
  if (!isSupabaseConfigured) return;

  try {
    const { error } = await supabase.from("event_logs").insert({
      event_name: eventName,
      page: currentPage,
      room_id: ROOM_ID,
      visitor_id: getVisitorId(),
      metadata,
    });

    if (error) {
      console.error(`Supabase ${eventName} 지표 저장에 실패했습니다.`, error);
    }
  } catch (error) {
    console.error(`Supabase ${eventName} 지표 저장에 실패했습니다.`, error);
  }
}
