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

function getHighestKnocksCount(state) {
  let highest = 0;

  Object.values(state).forEach((presences) => {
    presences.forEach((presence) => {
      const value = Number(
        presence?.knocks_count ??
          presence?.total_knocks ??
          presence?.count ??
          0,
      );
      if (Number.isFinite(value) && value > highest) {
        highest = value;
      }
    });
  });

  return highest;
}

export function connectPresence({
  page,
  onCountChange,
  onStatusChange,
  onPresenceMetadataChange,
  getPresenceMetadata,
}) {
  let channel = null;

  if (!isSupabaseConfigured) {
    onStatusChange?.("not-configured");
    return {
      disconnect() {},
      async updatePresenceMetadata() {},
    };
  }

  const setup = async () => {
    const visitorId = getVisitorId();
    channel = supabase.channel(PRESENCE_CHANNEL, {
      config: {
        presence: {
          key: visitorId,
        },
      },
    });

    const updateCount = () => {
      const state = channel?.presenceState?.() || {};
      onCountChange(countPresenceState(state));
      onPresenceMetadataChange?.(getHighestKnocksCount(state));
    };

    channel.on("presence", { event: "sync" }, updateCount);

    channel.subscribe(async (status) => {
      onStatusChange?.(status);

      if (status === "SUBSCRIBED") {
        await channel.track({
          page,
          online_at: new Date().toISOString(),
          visitor_id: visitorId,
          ...(getPresenceMetadata?.() || {}),
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

  const updatePresenceMetadata = async (overrideMetadata = {}) => {
    if (!channel) return;

    await channel.track({
      page,
      online_at: new Date().toISOString(),
      visitor_id: getVisitorId(),
      ...(getPresenceMetadata?.() || {}),
      ...overrideMetadata,
    });

    const state = channel?.presenceState?.() || {};
    onCountChange(countPresenceState(state));
    onPresenceMetadataChange?.(getHighestKnocksCount(state));
  };

  window.addEventListener("pagehide", disconnect, { once: true });

  return {
    disconnect,
    updatePresenceMetadata,
  };
}
