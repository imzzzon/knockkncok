import {
  getVisitorId,
  isSupabaseConfigured,
  supabase,
} from "./supabase-client.mjs";

const PRESENCE_CHANNEL = "knockknock-visitors";

function countPresenceState(state) {
  return Object.values(state).reduce((total, presences) => {
    return total + presences.length;
  }, 0);
}

export function connectPresence({ page, onCountChange, onStatusChange }) {
  let channel = null;

  if (!isSupabaseConfigured) {
    onStatusChange?.("not-configured");
    return {
      disconnect() {},
    };
  }

  const setup = async () => {
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
    if (!channel) return;
    channel.untrack();
    supabase.removeChannel(channel);
  };

  window.addEventListener("pagehide", disconnect, { once: true });

  return {
    disconnect,
  };
}
