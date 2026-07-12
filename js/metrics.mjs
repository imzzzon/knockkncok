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

function getTrafficSource() {
  let referrerOrigin = null;

  if (document.referrer) {
    try {
      referrerOrigin = new URL(document.referrer).origin;
    } catch {
      // Ignore malformed referrers instead of preventing event logging.
    }
  }

  return {
    source_origin: window.location.origin,
    source_hostname: window.location.hostname,
    source_path: window.location.pathname,
    referrer_origin: referrerOrigin,
  };
}

export async function logEvent(eventName, metadata = {}) {
  if (!isSupabaseConfigured) return;

  try {
    const { error } = await supabase.from("event_logs").insert({
      event_name: eventName,
      page: currentPage,
      room_id: ROOM_ID,
      visitor_id: getVisitorId(),
      metadata: {
        ...metadata,
        ...getTrafficSource(),
      },
    });

    if (error) {
      console.error(`Supabase ${eventName} 지표 저장에 실패했습니다.`, error);
    }
  } catch (error) {
    console.error(`Supabase ${eventName} 지표 저장에 실패했습니다.`, error);
  }
}
