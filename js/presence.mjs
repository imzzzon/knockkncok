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
  let countUpdateTimer = null;
  let lastAppliedCount = null;
  let pendingCount = null;
  let pendingMetadata = null;
  let isBootstrapping = true;

  const applyPendingCount = () => {
    if (pendingCount === null) return;
    if (pendingCount === lastAppliedCount) {
      pendingCount = null;
      pendingMetadata = null;
      return;
    }

    lastAppliedCount = pendingCount;
    onCountChange(pendingCount);
    onPresenceMetadataChange?.(pendingMetadata);
    pendingCount = null;
    pendingMetadata = null;
  };

  const scheduleCountUpdate = (nextCount, state) => {
    pendingCount = nextCount;
    pendingMetadata = getHighestKnocksCount(state);

    if (countUpdateTimer) {
      clearTimeout(countUpdateTimer);
    }

    countUpdateTimer = setTimeout(() => {
      countUpdateTimer = null;
      if (isBootstrapping && lastAppliedCount === null) {
        isBootstrapping = false;
      }
      applyPendingCount();
    }, 500);
  };

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
      const nextCount = countPresenceState(state);
      scheduleCountUpdate(nextCount, state);
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
    if (countUpdateTimer) {
      clearTimeout(countUpdateTimer);
      countUpdateTimer = null;
    }
    if (!channel) return;
    channel.untrack();
    supabase.removeChannel(channel);
    channel = null;
    lastAppliedCount = null;
    pendingCount = null;
    pendingMetadata = null;
    isBootstrapping = true;
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
    const nextCount = countPresenceState(state);
    scheduleCountUpdate(nextCount, state);
  };

  window.addEventListener("pagehide", disconnect, { once: true });

  return {
    disconnect,
    updatePresenceMetadata,
  };
}
