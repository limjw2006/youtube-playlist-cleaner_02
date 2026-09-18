"use strict";

// ⚠️ 배포 전 반드시 본인의 웹용 OAuth 클라이언트 ID로 교체하세요.
const CLIENT_ID = "여기에_발급받은_웹_클라이언트_ID.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/youtube.force-ssl";
const API_BASE = "https://www.googleapis.com/youtube/v3";

const UNAVAILABLE_TITLE_MARKERS = new Set([
  "Deleted video",
  "Private video",
  "삭제된 동영상",
  "비공개 동영상",
]);

const el = {
  account: document.getElementById("account"),

  viewSignedOut: document.getElementById("view-signedout"),
  btnConnect: document.getElementById("btn-connect"),
  signedOutError: document.getElementById("signedout-error"),

  appLayout: document.getElementById("app-layout"),

  btnRefresh: document.getElementById("btn-refresh"),
  btnToggleThumbs: document.getElementById("btn-toggle-thumbs"),
  playlistList: document.getElementById("playlist-list"),
  playlistsEmpty: document.getElementById("playlists-empty"),

  contentEmpty: document.getElementById("content-empty"),
  contentScanning: document.getElementById("content-scanning"),
  scanStatusText: document.getElementById("scan-status-text"),
  scanProgress: document.getElementById("scan-progress"),

  contentResults: document.getElementById("content-results"),
  resultsPlaylistTitle: document.getElementById("results-playlist-title"),
  resultsSummary: document.getElementById("results-summary"),
  resultsClean: document.getElementById("results-clean"),
  resultsList: document.getElementById("results-list"),
  resultsActions: document.getElementById("results-actions"),
  btnRescan: document.getElementById("btn-rescan"),
  btnSelectAll: document.getElementById("btn-select-all"),
  btnExport: document.getElementById("btn-export"),
  btnDelete: document.getElementById("btn-delete"),

  footerError: document.getElementById("footer-error"),

  quotaWidget: document.getElementById("quota-widget"),
  quotaSettingsBtn: document.getElementById("quota-settings-btn"),
  quotaBarFill: document.getElementById("quota-bar-fill"),
  quotaUsed: document.getElementById("quota-used"),
  quotaTotal: document.getElementById("quota-total"),
  quotaReadCount: document.getElementById("quota-read-count"),
  quotaReadUnits: document.getElementById("quota-read-units"),
  quotaDeleteCount: document.getElementById("quota-delete-count"),
  quotaDeleteUnits: document.getElementById("quota-delete-units"),
  quotaRemainingDeletes: document.getElementById("quota-remaining-deletes"),
  quotaSettings: document.getElementById("quota-settings"),
  quotaTotalInput: document.getElementById("quota-total-input"),
  quotaResetBtn: document.getElementById("quota-reset-btn"),
};

let state = {
  token: null,
  currentPlaylist: null,
  unavailable: [],
  scanCache: new Map(), // playlistId -> { totalCount, unavailable, scannedAt }
};

const CACHE_TTL_MS = 30 * 60 * 1000; // 같은 세션이라도 30분 지나면 캐시 무효화

let tokenClient = null;

// ---------------------------------------------------------------
// 썸네일 표시 여부 (선호도는 이 브라우저에 저장되어 다음 방문에도 유지)
// ---------------------------------------------------------------

const THUMBS_PREF_KEY = "ytpc-show-thumbs";

function loadThumbsPreference() {
  const saved = localStorage.getItem(THUMBS_PREF_KEY);
  const show = saved === null ? true : saved === "true";
  applyThumbsPreference(show);
}

function applyThumbsPreference(show) {
  el.playlistList.classList.toggle("thumbs-hidden", !show);
  el.btnToggleThumbs.setAttribute("aria-pressed", String(show));
}

function toggleThumbsPreference() {
  const currentlyShown = el.btnToggleThumbs.getAttribute("aria-pressed") === "true";
  const next = !currentlyShown;
  applyThumbsPreference(next);
  localStorage.setItem(THUMBS_PREF_KEY, String(next));
}

// ---------------------------------------------------------------
// 할당량 사용량 추적 (실제 구글 서버 값이 아니라, 우리가 보낸 호출을 세어
// 추정하는 값입니다. 조회 1유닛 / 삭제 50유닛 기준이며, 유튜브 API가
// 태평양 시간 자정에 초기화되는 것에 맞춰 날짜를 계산합니다.)
// ---------------------------------------------------------------

const QUOTA_TOTAL_KEY = "ytpc-quota-total";
const QUOTA_DAY_PREFIX = "ytpc-quota-day-";
const DEFAULT_DAILY_QUOTA = 10000;

const quota = {
  date: null,
  totalBudget: DEFAULT_DAILY_QUOTA,
  readCount: 0,
  readUnits: 0,
  deleteCount: 0,
  deleteUnits: 0,
};

function pacificDateKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function loadQuota() {
  const savedTotal = localStorage.getItem(QUOTA_TOTAL_KEY);
  quota.totalBudget = savedTotal ? Number(savedTotal) || DEFAULT_DAILY_QUOTA : DEFAULT_DAILY_QUOTA;

  quota.date = pacificDateKey();
  try {
    const raw = localStorage.getItem(QUOTA_DAY_PREFIX + quota.date);
    const parsed = raw ? JSON.parse(raw) : null;
    quota.readCount = parsed?.readCount || 0;
    quota.readUnits = parsed?.readUnits || 0;
    quota.deleteCount = parsed?.deleteCount || 0;
    quota.deleteUnits = parsed?.deleteUnits || 0;
  } catch {
    quota.readCount = quota.readUnits = quota.deleteCount = quota.deleteUnits = 0;
  }
  renderQuotaWidget();
}

function saveQuotaCounts() {
  try {
    localStorage.setItem(
      QUOTA_DAY_PREFIX + quota.date,
      JSON.stringify({
        readCount: quota.readCount,
        readUnits: quota.readUnits,
        deleteCount: quota.deleteCount,
        deleteUnits: quota.deleteUnits,
      })
    );
  } catch {
    /* 저장 실패해도 화면 표시는 계속 동작 */
  }
}

function recordQuotaUsage(kind, units) {
  const todayKey = pacificDateKey();
  if (todayKey !== quota.date) {
    // 태평양 기준 날짜가 바뀌었으면 자동으로 오늘 사용량을 새로 시작
    quota.date = todayKey;
    quota.readCount = quota.readUnits = quota.deleteCount = quota.deleteUnits = 0;
  }
  if (kind === "delete") {
    quota.deleteCount += 1;
    quota.deleteUnits += units;
  } else {
    quota.readCount += 1;
    quota.readUnits += units;
  }
  saveQuotaCounts();
  renderQuotaWidget();
}

function renderQuotaWidget() {
  const used = quota.readUnits + quota.deleteUnits;
  const pct = Math.min(100, Math.round((used / quota.totalBudget) * 100));

  el.quotaUsed.textContent = used.toLocaleString("ko-KR");
  el.quotaTotal.textContent = quota.totalBudget.toLocaleString("ko-KR");
  el.quotaBarFill.style.width = `${pct}%`;
  el.quotaBarFill.classList.toggle("quota-bar-warn", pct >= 70 && pct < 90);
  el.quotaBarFill.classList.toggle("quota-bar-danger", pct >= 90);

  el.quotaReadCount.textContent = quota.readCount;
  el.quotaReadUnits.textContent = quota.readUnits.toLocaleString("ko-KR");
  el.quotaDeleteCount.textContent = quota.deleteCount;
  el.quotaDeleteUnits.textContent = quota.deleteUnits.toLocaleString("ko-KR");

  const remainingUnits = Math.max(0, quota.totalBudget - used);
  el.quotaRemainingDeletes.textContent = Math.floor(remainingUnits / 50);
  el.quotaTotalInput.value = quota.totalBudget;
}

// ---------------------------------------------------------------
// 콘텐츠 패널 전환 (오른쪽 영역만 바뀜, 사이드바는 항상 고정)
// ---------------------------------------------------------------

function showContent(name) {
  for (const v of [el.contentEmpty, el.contentScanning, el.contentResults]) {
    v.classList.add("hidden");
  }
  ({
    empty: el.contentEmpty,
    scanning: el.contentScanning,
    results: el.contentResults,
  }[name]).classList.remove("hidden");
}

function setActivePlaylistItem(playlistId) {
  el.playlistList.querySelectorAll(".playlist-item").forEach((li) => {
    li.classList.toggle("active", li.dataset.playlistId === playlistId);
  });
}

function showFooterError(message) {
  el.footerError.textContent = message;
  el.footerError.classList.remove("hidden");
}

function clearFooterError() {
  el.footerError.classList.add("hidden");
}

// ---------------------------------------------------------------
// 인증 (Google Identity Services)
// ---------------------------------------------------------------

function initTokenClient() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: "",
  });
}

function requestAccessToken({ silent } = { silent: false }) {
  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      reject(new Error("아직 초기화되지 않았습니다. 잠시 후 다시 시도해주세요."));
      return;
    }
    tokenClient.callback = (resp) => {
      if (resp.error) {
        reject(new Error(resp.error_description || resp.error));
        return;
      }
      resolve(resp.access_token);
    };
    tokenClient.requestAccessToken({ prompt: silent ? "none" : "consent" });
  });
}

// ---------------------------------------------------------------
// API 호출 (401이면 재로그인 요청 후 1회 재시도)
// ---------------------------------------------------------------

async function apiFetch(url, options = {}, meta = { units: 1, kind: "read" }) {
  const doFetch = async (token) =>
    fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    });

  let res = await doFetch(state.token);

  if (res.status === 401) {
    state.token = await requestAccessToken({ silent: false });
    res = await doFetch(state.token);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API 오류 (${res.status}): ${body.slice(0, 200)}`);
  }

  recordQuotaUsage(meta.kind, meta.units);

  if (options.method === "DELETE") return null;
  return res.json();
}

// ---------------------------------------------------------------
// 재생목록 목록 (사이드바)
// ---------------------------------------------------------------

async function fetchMyPlaylists() {
  const playlists = [];
  let pageToken = "";
  do {
    const url = new URL(`${API_BASE}/playlists`);
    url.searchParams.set("part", "snippet,contentDetails");
    url.searchParams.set("mine", "true");
    url.searchParams.set("maxResults", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const data = await apiFetch(url.toString());
    playlists.push(...(data.items || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return playlists;
}

function renderPlaylists(playlists) {
  el.playlistList.innerHTML = "";
  el.playlistsEmpty.classList.toggle("hidden", playlists.length > 0);

  for (const pl of playlists) {
    const thumb =
      pl.snippet.thumbnails?.medium?.url ||
      pl.snippet.thumbnails?.default?.url ||
      "";

    const li = document.createElement("li");
    li.className = "playlist-item";
    li.dataset.playlistId = pl.id;
    li.innerHTML = `
      <div class="pl-text">
        <span class="pl-title"></span>
        <span class="pl-count"></span>
      </div>
      <div class="pl-thumb-wrap">
        ${thumb ? `<img class="pl-thumb" src="${thumb}" alt="" loading="lazy" />` : `<div class="pl-thumb pl-thumb-empty"></div>`}
      </div>
    `;
    li.querySelector(".pl-title").textContent = pl.snippet.title;
    li.querySelector(".pl-count").textContent = `${pl.contentDetails.itemCount}개`;
    li.addEventListener("click", () => scanPlaylist(pl.id, pl.snippet.title));
    el.playlistList.appendChild(li);
  }
}

// ---------------------------------------------------------------
// 재생목록 항목 + 이용 불가 탐지
// ---------------------------------------------------------------

async function fetchPlaylistItems(playlistId, onProgress) {
  const items = [];
  let pageToken = "";
  do {
    const url = new URL(`${API_BASE}/playlistItems`);
    url.searchParams.set("part", "snippet,contentDetails,status");
    url.searchParams.set("playlistId", playlistId);
    url.searchParams.set("maxResults", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const data = await apiFetch(url.toString());
    items.push(...(data.items || []));
    pageToken = data.nextPageToken || "";
    onProgress?.(items.length);
  } while (pageToken);
  return items;
}

async function fetchExistingVideoIds(videoIds) {
  const existing = new Set();
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const url = new URL(`${API_BASE}/videos`);
    url.searchParams.set("part", "status");
    url.searchParams.set("id", batch.join(","));
    const data = await apiFetch(url.toString());
    for (const item of data.items || []) existing.add(item.id);
  }
  return existing;
}

function detectUnavailable(items, existingIds) {
  const unavailable = [];
  for (const it of items) {
    const videoId = it.contentDetails.videoId;
    const title = it.snippet?.title || "";
    const position = it.snippet?.position;
    const playlistItemId = it.id;

    let reason = null;
    if (UNAVAILABLE_TITLE_MARKERS.has(title)) {
      reason = `제목이 "${title}"(으)로 표시됨`;
    } else if (!existingIds.has(videoId)) {
      reason = "완전히 삭제된 영상";
    }

    if (reason) {
      unavailable.push({ playlistItemId, videoId, title, position, reason });
    }
  }
  return unavailable;
}

async function scanPlaylist(playlistId, playlistTitle, { forceRescan = false } = {}) {
  state.currentPlaylist = { id: playlistId, title: playlistTitle };
  setActivePlaylistItem(playlistId);
  clearFooterError();

  // 캐시가 있고 아직 유효하면 API를 호출하지 않고 바로 보여준다 (할당량 절약)
  const cached = state.scanCache.get(playlistId);
  if (!forceRescan && cached && Date.now() - cached.scannedAt < CACHE_TTL_MS) {
    renderResults(playlistTitle, cached.totalCount, cached.unavailable, cached.scannedAt);
    state.unavailable = cached.unavailable;
    showContent("results");
    return;
  }

  showContent("scanning");
  el.scanStatusText.textContent = "영상 목록 불러오는 중…";
  el.scanProgress.textContent = "";

  try {
    const items = await fetchPlaylistItems(playlistId, (count) => {
      el.scanProgress.textContent = `${count}개 확인함`;
    });

    el.scanStatusText.textContent = "삭제/비공개 여부 확인 중…";
    const videoIds = items.map((it) => it.contentDetails.videoId);
    const existingIds = await fetchExistingVideoIds(videoIds);

    const unavailable = detectUnavailable(items, existingIds);
    state.unavailable = unavailable;
    state.scanCache.set(playlistId, {
      totalCount: items.length,
      unavailable,
      scannedAt: Date.now(),
    });

    renderResults(playlistTitle, items.length, unavailable, Date.now());
    showContent("results");
  } catch (err) {
    showContent("empty");
    showFooterError(err.message);
  }
}

// ---------------------------------------------------------------
// 결과 패널 (오른쪽)
// ---------------------------------------------------------------

function renderResults(playlistTitle, totalCount, unavailable, scannedAt) {
  el.resultsPlaylistTitle.textContent = playlistTitle;

  const scannedNote = scannedAt
    ? ` (확인 시각 ${new Date(scannedAt).toLocaleTimeString("ko-KR")})`
    : "";
  el.resultsSummary.textContent =
    (Number.isNaN(totalCount)
      ? `이용 불가 영상 ${unavailable.length}개가 남아있습니다.`
      : `전체 ${totalCount}개 중 이용 불가 영상 ${unavailable.length}개를 찾았습니다.`) +
    scannedNote;

  el.resultsClean.classList.toggle("hidden", unavailable.length !== 0);
  el.resultsList.classList.toggle("hidden", unavailable.length === 0);
  el.resultsActions.classList.toggle("hidden", unavailable.length === 0);

  el.resultsList.innerHTML = "";
  for (const item of unavailable) {
    const li = document.createElement("li");
    li.className = "result-item";
    li.innerHTML = `
      <input type="checkbox" checked data-item-id="${item.playlistItemId}" />
      <div class="result-body">
        <div class="result-title"></div>
        <div class="result-reason"></div>
      </div>
    `;
    li.querySelector(".result-title").textContent =
      item.title && item.title.trim() ? item.title : `(제목 없음) ${item.videoId}`;
    li.querySelector(".result-reason").textContent = item.reason;
    el.resultsList.appendChild(li);
  }
}

function getSelectedItemIds() {
  return Array.from(
    el.resultsList.querySelectorAll('input[type="checkbox"]:checked')
  ).map((cb) => cb.dataset.itemId);
}

async function deleteSelected() {
  const selectedIds = getSelectedItemIds();
  if (selectedIds.length === 0) return;

  const confirmed = confirm(
    `선택한 ${selectedIds.length}개 영상을 재생목록에서 삭제할까요? 되돌릴 수 없습니다.`
  );
  if (!confirmed) return;

  el.btnDelete.disabled = true;
  clearFooterError();

  const failed = [];
  for (const itemId of selectedIds) {
    try {
      const url = new URL(`${API_BASE}/playlistItems`);
      url.searchParams.set("id", itemId);
      await apiFetch(url.toString(), { method: "DELETE" }, { units: 50, kind: "delete" });
    } catch {
      failed.push(itemId);
    }
  }

  state.unavailable = state.unavailable.filter(
    (item) => !selectedIds.includes(item.playlistItemId) || failed.includes(item.playlistItemId)
  );

  // 캐시도 같이 갱신해서, 나중에 다시 클릭했을 때 이미 지운 영상이 또 보이지 않게 한다
  const cached = state.scanCache.get(state.currentPlaylist.id);
  if (cached) {
    cached.unavailable = state.unavailable;
    cached.scannedAt = Date.now();
  }

  renderResults(state.currentPlaylist.title, Number.NaN, state.unavailable, Date.now());
  el.resultsSummary.textContent = `삭제 완료: ${selectedIds.length - failed.length}개. 남은 이용 불가 영상: ${state.unavailable.length}개.`;
  if (failed.length > 0) {
    showFooterError(`${failed.length}개 항목은 삭제에 실패했습니다. 다시 시도해주세요.`);
  }
  el.btnDelete.disabled = false;
}

function exportCsv() {
  const rows = [["position", "video_id", "title", "reason", "playlist_item_id"]];
  for (const item of state.unavailable) {
    rows.push([item.position, item.videoId, item.title, item.reason, item.playlistItemId]);
  }
  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");

  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `unavailable_videos_${state.currentPlaylist.id}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------
// 초기화 및 이벤트 바인딩
// ---------------------------------------------------------------

async function loadPlaylists() {
  el.playlistList.innerHTML = "";
  clearFooterError();
  try {
    const playlists = await fetchMyPlaylists();
    renderPlaylists(playlists);
  } catch (err) {
    showFooterError(err.message);
  }
}

async function connect() {
  el.btnConnect.disabled = true;
  el.signedOutError.classList.add("hidden");
  try {
    state.token = await requestAccessToken({ silent: false });
    const info = await apiFetch(`${API_BASE}/channels?part=snippet&mine=true`);
    const channelTitle = info.items?.[0]?.snippet?.title;
    if (channelTitle) {
      el.account.textContent = channelTitle;
      el.account.classList.remove("hidden");
    }

    el.viewSignedOut.classList.add("hidden");
    el.appLayout.classList.remove("hidden");
    el.quotaWidget.classList.remove("hidden");
    loadQuota();
    showContent("empty");
    await loadPlaylists();
  } catch (err) {
    el.signedOutError.textContent = err.message;
    el.signedOutError.classList.remove("hidden");
  } finally {
    el.btnConnect.disabled = false;
  }
}

el.btnConnect.addEventListener("click", connect);
el.btnRefresh.addEventListener("click", loadPlaylists);
el.btnToggleThumbs.addEventListener("click", toggleThumbsPreference);
el.btnExport.addEventListener("click", exportCsv);
el.btnRescan.addEventListener("click", () => {
  if (!state.currentPlaylist) return;
  scanPlaylist(state.currentPlaylist.id, state.currentPlaylist.title, {
    forceRescan: true,
  });
});
el.btnDelete.addEventListener("click", deleteSelected);
el.btnSelectAll.addEventListener("click", () => {
  const boxes = el.resultsList.querySelectorAll('input[type="checkbox"]');
  const allChecked = Array.from(boxes).every((cb) => cb.checked);
  boxes.forEach((cb) => (cb.checked = !allChecked));
});

el.quotaSettingsBtn.addEventListener("click", () => {
  el.quotaSettings.classList.toggle("hidden");
});

el.quotaTotalInput.addEventListener("change", () => {
  const value = Number(el.quotaTotalInput.value);
  if (!value || value <= 0) return;
  quota.totalBudget = value;
  localStorage.setItem(QUOTA_TOTAL_KEY, String(value));
  renderQuotaWidget();
});

el.quotaResetBtn.addEventListener("click", () => {
  const confirmed = confirm("오늘 사용량 기록을 0으로 초기화할까요? (실제 구글 할당량이 아니라 이 화면에 표시되는 기록만 초기화됩니다)");
  if (!confirmed) return;
  quota.readCount = quota.readUnits = quota.deleteCount = quota.deleteUnits = 0;
  saveQuotaCounts();
  renderQuotaWidget();
});

// Google Identity Services 스크립트가 로드된 뒤 토큰 클라이언트 초기화
window.addEventListener("load", () => {
  loadThumbsPreference();
  if (typeof google === "undefined" || !google.accounts) {
    showFooterError("구글 로그인 스크립트를 불러오지 못했습니다. 새로고침해보세요.");
    return;
  }
  initTokenClient();
});
