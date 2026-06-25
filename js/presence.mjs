import {
  SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_URL,
} from "./supabase-config.mjs";

const PRESENCE_CHANNEL = "knockknock-visitors";
const VISITOR_ID_KEY = "knockknock_visitor_id";

const isConfigured =
  SUPABASE_URL.startsWith("https://") &&
  SUPABASE_PUBLISHABLE_KEY !== "YOUR_SUPABASE_PUBLISHABLE_KEY";

function getVisitorId() {
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

function countPresenceState(state) {
  return Object.values(state).reduce((total, presences) => {
    return total + presences.length;
  }, 0);
}

export function connectPresence({ page, onCountChange, onStatusChange }) {
  let channel = null;
  let supabase = null;

  if (!isConfigured) {
    onStatusChange?.("not-configured");
    return {
      disconnect() {},
    };
  }

  const setup = async () => {
    const { createClient } = await import(
      "https://esm.sh/@supabase/supabase-js@2"
    );

    supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
    const visitorId = getVisitorId();
    channel = supabase.channel(PRESENCE_CHANNEL, {
      config: {
        presence: {
          key: `${visitorId}:${page}`,
        },
      },
    });

    const updateCount = () => {
      onCountChange(countPresenceState(channel.presenceState()));
    };

    channel.on("presence", { event: "sync" }, updateCount);

    channel.subscribe(async (status) => {
      onStatusChange?.(status);

      if (status === "SUBSCRIBED") {
        await channel.track({
          page,
          online_at: new Date().toISOString(),
          visitor_id: visitorId,
        });
        updateCount();
      }
    });
  };

  setup().catch((error) => {
    console.error("Supabase Presence 연결에 실패했습니다.", error);
    onStatusChange?.("error");
  });

  const disconnect = () => {
    if (!channel || !supabase) return;
    channel.untrack();
    supabase.removeChannel(channel);
  };

  window.addEventListener("pagehide", disconnect, { once: true });

  return {
    disconnect,
  };
}
