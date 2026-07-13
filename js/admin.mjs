import { isSupabaseConfigured, supabase } from "./supabase-client.mjs";

const DEFAULT_RANGE = "week";
const PRESENCE_CHANNEL = "knockknock-visitors";
const numberFormatter = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });
const dateTimeFormatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const chartInstances = new Map();
let selectedRange = DEFAULT_RANGE;
let requestController = null;

const elements = {
  content: document.getElementById("dashboard-content"),
  statusPanel: document.getElementById("status-panel"),
  statusMessage: document.getElementById("status-message"),
  retryButton: document.getElementById("retry-button"),
  refreshButton: document.getElementById("refresh-button"),
  updatedAt: document.getElementById("updated-at"),
};

function formatNumber(value) {
  return numberFormatter.format(Number.isFinite(Number(value)) ? Number(value) : 0);
}

function formatPercent(value) {
  const percent = (Number(value) || 0) * 100;
  return `${numberFormatter.format(percent)}%`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "데이터 부족";
  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return minutes > 0 ? `${minutes}분 ${remainder}초` : `${remainder}초`;
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function setLoading(isLoading) {
  elements.content.classList.toggle("is-loading", isLoading);
  elements.content.setAttribute("aria-busy", String(isLoading));
  elements.refreshButton.disabled = isLoading;
  document.querySelectorAll("[data-range]").forEach((button) => {
    button.disabled = isLoading;
  });

  if (isLoading) {
    elements.statusPanel.hidden = false;
    elements.statusPanel.classList.remove("error");
    elements.statusMessage.textContent = "지표를 불러오는 중입니다";
    elements.retryButton.hidden = true;
  }
}

function showError() {
  elements.statusPanel.hidden = false;
  elements.statusPanel.classList.add("error");
  elements.statusMessage.textContent = "지표를 불러오지 못했습니다";
  elements.retryButton.hidden = false;
}

function destroyCharts() {
  chartInstances.forEach((chart) => chart.destroy());
  chartInstances.clear();
}

function hasChartData(series) {
  return Array.isArray(series) && series.some((item) => Number(item.value) > 0);
}

function renderChart({ canvasId, emptyId, series, type, label }) {
  const canvas = document.getElementById(canvasId);
  const empty = document.getElementById(emptyId);
  const hasData = hasChartData(series);

  canvas.hidden = !hasData;
  empty.hidden = hasData;
  if (!hasData) return;

  if (typeof window.Chart !== "function") {
    canvas.hidden = true;
    empty.hidden = false;
    empty.textContent = "차트 라이브러리를 불러오지 못했습니다";
    return;
  }

  const chart = new window.Chart(canvas, {
    type,
    data: {
      labels: series.map((item) => item.label),
      datasets: [{
        label,
        data: series.map((item) => Number(item.value) || 0),
        borderColor: "#246bfd",
        backgroundColor: type === "line" ? "rgba(36, 107, 253, 0.10)" : "rgba(36, 107, 253, 0.78)",
        pointBackgroundColor: "#246bfd",
        pointBorderColor: "#ffffff",
        pointBorderWidth: 2,
        pointRadius: type === "line" ? 3 : 0,
        pointHoverRadius: 5,
        borderWidth: type === "line" ? 2 : 0,
        borderRadius: type === "bar" ? 5 : 0,
        borderSkipped: false,
        fill: type === "line",
        tension: 0.32,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 280 },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#182230",
          padding: 11,
          cornerRadius: 8,
          displayColors: false,
          callbacks: { label: (context) => `${label}: ${formatNumber(context.parsed.y)}` },
        },
      },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { color: "#667085", maxRotation: 0, autoSkip: true, maxTicksLimit: 12, font: { size: 11 } } },
        y: { beginAtZero: true, grid: { color: "#eef1f5" }, border: { display: false }, ticks: { color: "#667085", precision: 0, font: { size: 11 } } },
      },
    },
  });

  chartInstances.set(canvasId, chart);
}

function renderMetrics(data) {
  const { summary = {}, series = {} } = data;
  setText("visitors", formatNumber(summary.visitors));
  setText("returning-visitors", formatNumber(summary.returningVisitors));
  setText("return-rate", `재방문율 ${formatPercent(summary.returnRate)}`);
  setText("total-knocks", formatNumber(summary.totalKnocks));
  setText("avg-knocks", formatNumber(summary.avgKnocksPerVisitor));
  setText("chat-sends", formatNumber(summary.chatSends));
  setText("avg-chats", formatNumber(summary.avgChatsPerVisitor));
  setText("avg-duration", formatDuration(summary.avgDurationSec));
  setText("duration-samples", `유효 세션 ${formatNumber(summary.durationSampleCount)}개`);
  setText("home-views", formatNumber(summary.homeViews));
  setText("door-enters", formatNumber(summary.doorEnters));
  setText("square-enters", formatNumber(summary.squareEnters));

  const generatedAt = new Date(data.generatedAt);
  elements.updatedAt.textContent = `마지막 갱신: ${Number.isNaN(generatedAt.getTime()) ? "—" : dateTimeFormatter.format(generatedAt)} KST`;

  destroyCharts();
  renderChart({ canvasId: "daily-visitors-chart", emptyId: "daily-visitors-empty", series: series.dailyVisitors, type: "line", label: "방문자" });
  renderChart({ canvasId: "daily-knocks-chart", emptyId: "daily-knocks-empty", series: series.dailyKnocks, type: "bar", label: "노크" });
  renderChart({ canvasId: "daily-chats-chart", emptyId: "daily-chats-empty", series: series.dailyChats, type: "bar", label: "채팅" });
  renderChart({ canvasId: "hourly-visitors-chart", emptyId: "hourly-visitors-empty", series: series.hourlyVisitors, type: "bar", label: "방문자" });
  renderChart({ canvasId: "weekday-visitors-chart", emptyId: "weekday-visitors-empty", series: series.weekdayVisitors, type: "bar", label: "방문자" });
}

async function loadMetrics() {
  requestController?.abort();
  const controller = new AbortController();
  requestController = controller;
  setLoading(true);

  try {
    const response = await fetch(`/api/admin-metrics?range=${encodeURIComponent(selectedRange)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("metrics-request-failed");
    const data = await response.json();
    renderMetrics(data);
    elements.statusPanel.hidden = true;
  } catch (error) {
    if (error.name !== "AbortError") showError();
  } finally {
    if (requestController === controller) setLoading(false);
  }
}

function countPresence(state) {
  const counts = { total: 0, hospital: 0, square: 0 };
  Object.values(state).forEach((presences) => {
    presences.forEach((presence) => {
      counts.total += 1;
      if (presence.page === "hospital") counts.hospital += 1;
      if (presence.page === "square") counts.square += 1;
    });
  });
  return counts;
}

function renderPresence(counts) {
  setText("live-total", formatNumber(counts.total));
  setText("live-hospital", formatNumber(counts.hospital));
  setText("live-square", formatNumber(counts.square));
}

function connectReadOnlyPresence() {
  const status = document.getElementById("presence-status");
  if (!isSupabaseConfigured) {
    status.textContent = "설정 확인 필요";
    status.classList.add("offline");
    renderPresence({ total: 0, hospital: 0, square: 0 });
    return;
  }

  const channel = supabase.channel(PRESENCE_CHANNEL);
  channel.on("presence", { event: "sync" }, () => {
    renderPresence(countPresence(channel.presenceState()));
  });
  channel.subscribe((subscriptionStatus) => {
    if (subscriptionStatus === "SUBSCRIBED") {
      status.textContent = "실시간 연결됨";
      status.classList.remove("offline");
      renderPresence(countPresence(channel.presenceState()));
    } else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(subscriptionStatus)) {
      status.textContent = "연결 끊김";
      status.classList.add("offline");
    }
  });

  window.addEventListener("pagehide", () => supabase.removeChannel(channel), { once: true });
}

document.querySelectorAll("[data-range]").forEach((button) => {
  button.addEventListener("click", () => {
    selectedRange = button.dataset.range;
    document.querySelectorAll("[data-range]").forEach((item) => item.classList.toggle("active", item === button));
    loadMetrics();
  });
});
elements.refreshButton.addEventListener("click", loadMetrics);
elements.retryButton.addEventListener("click", loadMetrics);

connectReadOnlyPresence();
loadMetrics();
