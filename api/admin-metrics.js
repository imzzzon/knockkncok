const TIME_ZONE = "Asia/Seoul";
const PAGE_SIZE = 1000;
const VALID_RANGES = new Set(["day", "week", "month", "all"]);
const WEEKDAY_LABELS = ["월", "화", "수", "목", "금", "토", "일"];
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

class SupabaseRequestError extends Error {
  constructor({ status, code, message }) {
    super(message);
    this.name = "SupabaseRequestError";
    this.status = status;
    this.code = code;
  }
}

const kstPartsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  weekday: "short",
});

function getKstParts(value) {
  const parts = Object.fromEntries(
    kstPartsFormatter.formatToParts(value).map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    weekday: parts.weekday,
  };
}

function getKstDateStart(dateString) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString || "");
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  const startAt = new Date(Date.UTC(year, month - 1, day) - KST_OFFSET_MS);
  return getKstParts(startAt).date === dateString ? startAt : null;
}

function getCalendarRange(range, now, selectedDate = null) {
  if (range === "all") {
    return { startAt: null, startDate: null, endDate: getKstParts(now).date };
  }

  if (range === "day" && selectedDate) {
    const startAt = getKstDateStart(selectedDate);
    if (!startAt) return null;
    return {
      startAt,
      endAt: new Date(startAt.getTime() + 24 * 60 * 60 * 1000),
      startDate: selectedDate,
      endDate: selectedDate,
    };
  }

  // Shift KST wall-clock time into UTC fields so calendar arithmetic is
  // independent of the server's own timezone.
  const kstClock = new Date(now.getTime() + KST_OFFSET_MS);
  const year = kstClock.getUTCFullYear();
  const monthIndex = kstClock.getUTCMonth();
  let day = kstClock.getUTCDate();

  if (range === "week") {
    const weekday = kstClock.getUTCDay();
    day -= weekday === 0 ? 6 : weekday - 1;
  } else if (range === "month") {
    day = 1;
  }

  const startAt = new Date(Date.UTC(year, monthIndex, day) - KST_OFFSET_MS);
  return {
    startAt,
    startDate: getKstParts(startAt).date,
    endDate: getKstParts(now).date,
  };
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function addToSetMap(map, key, value) {
  if (!value) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

function addToNumberMap(map, key, value) {
  map.set(key, (map.get(key) || 0) + value);
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function normalizeEnvValue(value) {
  let normalized = typeof value === "string" ? value.trim() : "";
  const first = normalized[0];
  const last = normalized[normalized.length - 1];
  if (normalized.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"))) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

function normalizeSupabaseUrl(value) {
  return normalizeEnvValue(value).replace(/\/+$/, "");
}

function isLegacyJwtKey(key) {
  return key.split(".").length === 3;
}

function createSupabaseHeaders(serviceRoleKey, offset) {
  const headers = {
    apikey: serviceRoleKey,
    Accept: "application/json",
    Range: `${offset}-${offset + PAGE_SIZE - 1}`,
    "Cache-Control": "no-cache",
  };

  // New sb_secret_ keys are opaque API keys, not JWTs. Legacy service_role
  // keys remain JWTs and still need the Authorization header for REST.
  if (isLegacyJwtKey(serviceRoleKey)) {
    headers.Authorization = `Bearer ${serviceRoleKey}`;
  }

  return headers;
}

function createSupabaseRequestError(response, body) {
  return new SupabaseRequestError({
    status: response.status,
    code: typeof body?.code === "string" ? body.code : "SUPABASE_HTTP_ERROR",
    message: typeof body?.message === "string" ? body.message : response.statusText || "Supabase request failed",
  });
}

function redactLogValue(value, secrets) {
  let redacted = typeof value === "string" ? value : String(value ?? "unknown-error");
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

// TEMP DEBUG: Remove these helpers and diagnostic response fields after the
// production failure is identified.
function safeDebugMessage(value, secrets) {
  return redactLogValue(value, secrets).replace(/[\r\n]+/g, " ").slice(0, 240);
}

function firstStackLines(error, secrets) {
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
  return redactLogValue(stack, secrets).split("\n").slice(0, 3).join("\n");
}

function fillDailySeries(map, firstDate, lastDate) {
  if (!firstDate || !lastDate) return [];
  const result = [];
  let cursor = new Date(`${firstDate}T00:00:00+09:00`);
  const end = new Date(`${lastDate}T00:00:00+09:00`);
  while (cursor <= end) {
    const date = getKstParts(cursor).date;
    result.push({ date, label: date.slice(5).replace("-", "/"), value: map.get(date) || 0 });
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return result;
}

function aggregateEvents(rows, { range, startAt, now }) {
  const visitors = new Set();
  const visitorDates = new Map();
  const dailyVisitors = new Map();
  const hourlyVisitors = new Map(Array.from({ length: 24 }, (_, hour) => [hour, new Set()]));
  const weekdayVisitors = new Map(WEEKDAY_LABELS.map((label) => [label, new Set()]));
  const knockParticipants = new Set();
  const chatParticipants = new Set();
  const dailyKnocks = new Map();
  const todayKnocksByVisitor = new Map();
  const dailyChats = new Map();
  let homeViews = 0;
  let squareEnters = 0;
  let totalKnocks = 0;
  let chatSends = 0;
  let durationTotal = 0;
  let durationSampleCount = 0;
  let hospitalDurationTotal = 0;
  let hospitalDurationSampleCount = 0;
  let squareDurationTotal = 0;
  let squareDurationSampleCount = 0;
  let earliestDate = null;
  const todayDate = getKstParts(now).date;

  for (const row of rows) {
    const createdAt = new Date(row.created_at);
    if (Number.isNaN(createdAt.getTime())) continue;
    const { date, hour, weekday } = getKstParts(createdAt);
    if (!earliestDate || date < earliestDate) earliestDate = date;

    const visitorId = typeof row.visitor_id === "string" && row.visitor_id ? row.visitor_id : null;
    if (visitorId) {
      visitors.add(visitorId);
      addToSetMap(dailyVisitors, date, visitorId);
      addToSetMap(hourlyVisitors, hour, visitorId);
      const weekdayIndex = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[weekday];
      if (weekdayIndex !== undefined) addToSetMap(weekdayVisitors, WEEKDAY_LABELS[weekdayIndex], visitorId);
      addToSetMap(visitorDates, visitorId, date);
    }

    if (row.event_name === "home_view") homeViews += 1;
    if (row.event_name === "square_enter") squareEnters += 1;

    if (row.event_name === "knock") {
      if (visitorId) knockParticipants.add(visitorId);
      const count = toFiniteNumber(row.metadata?.count) ?? 0;
      totalKnocks += count;
      addToNumberMap(dailyKnocks, date, count);
      if (visitorId && date === todayDate) {
        addToNumberMap(todayKnocksByVisitor, visitorId, count);
      }
    }

    if (row.event_name === "chat_send") {
      if (visitorId) chatParticipants.add(visitorId);
      chatSends += 1;
      addToNumberMap(dailyChats, date, 1);
    }

    if (row.event_name === "session_end") {
      const durationSec = toFiniteNumber(row.metadata?.durationSec);
      if (durationSec !== null && durationSec >= 0) {
        durationTotal += durationSec;
        durationSampleCount += 1;
      }
      const hospitalDurationSec = toFiniteNumber(row.metadata?.hospitalDurationSec);
      if (hospitalDurationSec !== null && hospitalDurationSec > 0) {
        hospitalDurationTotal += hospitalDurationSec;
        hospitalDurationSampleCount += 1;
      }
      const squareDurationSec = toFiniteNumber(row.metadata?.squareDurationSec);
      if (squareDurationSec !== null && squareDurationSec > 0) {
        squareDurationTotal += squareDurationSec;
        squareDurationSampleCount += 1;
      }
    }
  }

  const visitorCount = visitors.size;
  const returningVisitors = [...visitorDates.values()].filter((dates) => dates.size >= 2).length;
  const lastDate = getKstParts(now).date;
  const firstDate = range === "all" ? earliestDate : getKstParts(startAt).date;
  const dailyVisitorCounts = new Map([...dailyVisitors].map(([date, set]) => [date, set.size]));
  const todayTopKnocks = [...todayKnocksByVisitor.values()].reduce(
    (highest, count) => Math.max(highest, count),
    0,
  );

  return {
    summary: {
      visitors: visitorCount,
      returningVisitors,
      returnRate: visitorCount ? round(returningVisitors / visitorCount, 4) : 0,
      homeViews,
      knockParticipants: knockParticipants.size,
      squareEnters,
      chatParticipants: chatParticipants.size,
      totalKnocks: round(totalKnocks),
      avgKnocksPerVisitor: visitorCount ? round(totalKnocks / visitorCount) : 0,
      todayTopKnocks: round(todayTopKnocks),
      chatSends,
      avgChatsPerVisitor: visitorCount ? round(chatSends / visitorCount) : 0,
      avgDurationSec: durationSampleCount ? round(durationTotal / durationSampleCount) : null,
      durationSampleCount,
      avgHospitalDurationSec: hospitalDurationSampleCount
        ? round(hospitalDurationTotal / hospitalDurationSampleCount)
        : null,
      hospitalDurationSampleCount,
      avgSquareDurationSec: squareDurationSampleCount
        ? round(squareDurationTotal / squareDurationSampleCount)
        : null,
      squareDurationSampleCount,
    },
    series: {
      dailyVisitors: fillDailySeries(dailyVisitorCounts, firstDate, lastDate),
      dailyKnocks: fillDailySeries(dailyKnocks, firstDate, lastDate),
      dailyChats: fillDailySeries(dailyChats, firstDate, lastDate),
      hourlyVisitors: Array.from({ length: 24 }, (_, hour) => ({ hour, label: `${hour}시`, value: hourlyVisitors.get(hour).size })),
      weekdayVisitors: WEEKDAY_LABELS.map((label) => ({ weekday: label, label, value: weekdayVisitors.get(label).size })),
    },
  };
}

async function fetchAllEvents({ supabaseUrl, serviceRoleKey, startAt, endAt, debug }) {
  const rows = [];
  let offset = 0;
  let pageIndex = 0;

  while (true) {
    const rangeStart = offset;
    const rangeEnd = offset + PAGE_SIZE - 1;
    const url = new URL(`${supabaseUrl}/rest/v1/event_logs`);
    url.searchParams.set("select", "created_at,event_name,visitor_id,metadata");
    url.searchParams.set("order", "created_at.asc");
    if (startAt) url.searchParams.append("created_at", `gte.${startAt.toISOString()}`);
    if (endAt) url.searchParams.append("created_at", `lt.${endAt.toISOString()}`);

    // TEMP DEBUG: Stage logs intentionally exclude URLs, keys, and row data.
    debug.stage = "before-fetch";
    console.log("[admin-metrics] stage=before-fetch");
    const response = await fetch(url, {
      headers: createSupabaseHeaders(serviceRoleKey, offset),
    });
    debug.stage = "after-fetch";
    debug.status = response.status;
    debug.message = response.statusText || "Supabase response received";
    console.log("[admin-metrics] stage=after-fetch", {
      status: response.status,
      statusText: response.statusText,
    });
    console.log("[admin-metrics] stage=page", {
      pageIndex,
      rangeStart,
      rangeEnd,
      status: response.status,
    });

    debug.stage = "before-body-parse";
    console.log("[admin-metrics] stage=before-body-parse", { pageIndex });
    let page;
    try {
      page = await response.json();
    } catch (error) {
      debug.stage = "body-parse-error";
      debug.message = "Supabase response body parsing failed";
      console.log("[admin-metrics] stage=after-body-parse", { pageIndex, parsed: false });
      throw error;
    }
    debug.stage = "after-body-parse";
    console.log("[admin-metrics] stage=after-body-parse", { pageIndex, parsed: true });

    if (!response.ok) {
      debug.stage = "supabase-error";
      const requestError = createSupabaseRequestError(response, page);
      debug.message = requestError.message;
      throw requestError;
    }
    if (!Array.isArray(page)) throw new Error("supabase-response-invalid");
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    pageIndex += 1;
  }

  return rows;
}

async function handler(request, response) {
  // TEMP DEBUG: Remove all [admin-metrics] stage logs after diagnosis.
  console.log("[admin-metrics] stage=start");
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Content-Type", "application/json; charset=utf-8");

  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "허용되지 않은 요청입니다" });
  }

  const rawRange = Array.isArray(request.query?.range) ? request.query.range[0] : request.query?.range;
  const range = rawRange || "week";
  if (!VALID_RANGES.has(range)) return response.status(400).json({ error: "올바르지 않은 조회 기간입니다" });
  const rawDate = Array.isArray(request.query?.date) ? request.query.date[0] : request.query?.date;
  const selectedDate = typeof rawDate === "string" && rawDate ? rawDate : null;
  const todayDate = getKstParts(new Date()).date;
  if (selectedDate && (range !== "day" || !getKstDateStart(selectedDate) || selectedDate > todayDate)) {
    return response.status(400).json({ error: "올바르지 않은 조회 날짜입니다" });
  }

  const debug = { stage: "start", status: null, message: "Request failed" };
  let supabaseUrl = "";
  let serviceRoleKey = "";
  try {
    supabaseUrl = normalizeSupabaseUrl(process.env.SUPABASE_URL);
    serviceRoleKey = normalizeEnvValue(process.env.SUPABASE_SERVICE_ROLE_KEY);
    debug.stage = "env";
    console.log("[admin-metrics] stage=env", {
      hasUrl: Boolean(process.env.SUPABASE_URL),
      hasKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      keyType: serviceRoleKey.startsWith("sb_secret_") ? "secret" : "legacy",
    });
    if (!supabaseUrl || !serviceRoleKey) {
      debug.status = "ENV_MISSING";
      debug.message = "Required environment variables are missing";
      throw new Error(debug.message);
    }

    const now = new Date();
    const calendarRange = getCalendarRange(range, now, selectedDate);
    const { startAt, endAt } = calendarRange;
    const rows = await fetchAllEvents({ supabaseUrl, serviceRoleKey, startAt, endAt, debug });
    debug.stage = "aggregation";
    const aggregationNow = range === "day" && selectedDate ? startAt : now;
    const aggregated = aggregateEvents(rows, { range, startAt, now: aggregationNow });
    if (range === "all") {
      calendarRange.startDate = aggregated.series.dailyVisitors[0]?.date || null;
    }
    debug.stage = "complete";
    return response.status(200).json({
      range,
      period: calendarRange,
      generatedAt: now.toISOString(),
      ...aggregated,
    });
  } catch (error) {
    const secrets = [serviceRoleKey, supabaseUrl];
    const message = safeDebugMessage(error instanceof Error ? error.message : error, secrets);
    if (debug.status === null) debug.status = "INTERNAL_ERROR";
    debug.message = message || "Request failed";
    // TEMP DEBUG: Limited to safe error fields and the first three stack lines.
    console.error("[admin-metrics] stage=error", {
      name: error instanceof Error ? error.name : "UnknownError",
      message: debug.message,
      stack: firstStackLines(error, secrets),
    });
    // TEMP DEBUG: Revert to the generic error response after diagnosis.
    return response.status(500).json({
      stage: debug.stage,
      debugStatus: debug.status,
      debugMessage: debug.message,
    });
  }
}

module.exports = handler;
module.exports.aggregateEvents = aggregateEvents;
module.exports.getKstParts = getKstParts;
module.exports.getCalendarRange = getCalendarRange;
module.exports.getKstDateStart = getKstDateStart;
