const TIME_ZONE = "Asia/Seoul";
const PAGE_SIZE = 1000;
const VALID_RANGES = new Set(["day", "week", "month", "all"]);
const RANGE_DURATIONS = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};
const WEEKDAY_LABELS = ["월", "화", "수", "목", "금", "토", "일"];

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

async function createSupabaseRequestError(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    // Keep the public response generic even when Supabase returns a non-JSON body.
  }

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
  const dailyKnocks = new Map();
  const dailyChats = new Map();
  let homeViews = 0;
  let doorEnters = 0;
  let squareEnters = 0;
  let totalKnocks = 0;
  let chatSends = 0;
  let durationTotal = 0;
  let durationSampleCount = 0;
  let earliestDate = null;

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
    if (row.event_name === "door_enter") doorEnters += 1;
    if (row.event_name === "square_enter") squareEnters += 1;

    if (row.event_name === "knock") {
      const count = toFiniteNumber(row.metadata?.count) ?? 0;
      totalKnocks += count;
      addToNumberMap(dailyKnocks, date, count);
    }

    if (row.event_name === "chat_send") {
      chatSends += 1;
      addToNumberMap(dailyChats, date, 1);
    }

    if (row.event_name === "session_end") {
      const durationSec = toFiniteNumber(row.metadata?.durationSec);
      if (durationSec !== null && durationSec >= 0) {
        durationTotal += durationSec;
        durationSampleCount += 1;
      }
    }
  }

  const visitorCount = visitors.size;
  const returningVisitors = [...visitorDates.values()].filter((dates) => dates.size >= 2).length;
  const lastDate = getKstParts(now).date;
  const firstDate = range === "all" ? earliestDate : getKstParts(startAt).date;
  const dailyVisitorCounts = new Map([...dailyVisitors].map(([date, set]) => [date, set.size]));

  return {
    summary: {
      visitors: visitorCount,
      returningVisitors,
      returnRate: visitorCount ? round(returningVisitors / visitorCount, 4) : 0,
      homeViews,
      doorEnters,
      squareEnters,
      totalKnocks: round(totalKnocks),
      avgKnocksPerVisitor: visitorCount ? round(totalKnocks / visitorCount) : 0,
      chatSends,
      avgChatsPerVisitor: visitorCount ? round(chatSends / visitorCount) : 0,
      avgDurationSec: durationSampleCount ? round(durationTotal / durationSampleCount) : null,
      durationSampleCount,
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

async function fetchAllEvents({ supabaseUrl, serviceRoleKey, startAt }) {
  const rows = [];
  let offset = 0;

  while (true) {
    const url = new URL(`${supabaseUrl}/rest/v1/event_logs`);
    url.searchParams.set("select", "created_at,event_name,visitor_id,metadata");
    url.searchParams.set("order", "created_at.asc");
    if (startAt) url.searchParams.set("created_at", `gte.${startAt.toISOString()}`);

    const response = await fetch(url, {
      headers: createSupabaseHeaders(serviceRoleKey, offset),
    });

    if (!response.ok) throw await createSupabaseRequestError(response);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error("supabase-response-invalid");
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return rows;
}

async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Content-Type", "application/json; charset=utf-8");

  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "허용되지 않은 요청입니다" });
  }

  const rawRange = Array.isArray(request.query?.range) ? request.query.range[0] : request.query?.range;
  const range = rawRange || "week";
  if (!VALID_RANGES.has(range)) return response.status(400).json({ error: "올바르지 않은 조회 기간입니다" });

  const supabaseUrl = normalizeSupabaseUrl(process.env.SUPABASE_URL);
  const serviceRoleKey = normalizeEnvValue(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!supabaseUrl || !serviceRoleKey) return response.status(500).json({ error: "관리자 지표를 불러올 수 없습니다" });

  try {
    const now = new Date();
    const startAt = range === "all" ? null : new Date(now.getTime() - RANGE_DURATIONS[range]);
    const rows = await fetchAllEvents({ supabaseUrl, serviceRoleKey, startAt });
    const aggregated = aggregateEvents(rows, { range, startAt, now });
    return response.status(200).json({ range, generatedAt: now.toISOString(), ...aggregated });
  } catch (error) {
    const secrets = [serviceRoleKey, supabaseUrl];
    console.error("admin-metrics Supabase request failed", {
      status: error instanceof SupabaseRequestError ? error.status : null,
      code: error instanceof SupabaseRequestError ? error.code : "ADMIN_METRICS_INTERNAL",
      message: redactLogValue(error instanceof Error ? error.message : error, secrets),
    });
    return response.status(500).json({ error: "관리자 지표를 불러올 수 없습니다" });
  }
}

module.exports = handler;
module.exports.aggregateEvents = aggregateEvents;
module.exports.getKstParts = getKstParts;
