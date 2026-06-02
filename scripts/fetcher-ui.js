// ===== fetcher-ui.js =====
// 抓取按钮事件（保存到 chrome.storage 供选课规划器使用）

function showToast(title, text, percent) {
  const toast = document.getElementById("progressToast");
  document.getElementById("progressToastTitle").textContent = title;
  document.getElementById("progressToastText").textContent = text;
  document.getElementById("progressToastBar").style.width = percent + "%";
  toast.style.display = "block";
}
function hideToast() {
  document.getElementById("progressToast").style.display = "none";
}
function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}
function normalizeXnxq(value) {
  const match = String(value || "").match(/(20\d{2})-(20\d{2})-([1-3])/);
  if (!match) return "";
  const start = parseInt(match[1], 10);
  const end = parseInt(match[2], 10);
  if (end !== start + 1) return "";
  return `${match[1]}-${match[2]}-${match[3]}`;
}
function compareXnxq(a, b) {
  const left = normalizeXnxq(a).split("-").map(Number);
  const right = normalizeXnxq(b).split("-").map(Number);
  if (left.length !== 3 && right.length !== 3) return 0;
  if (left.length !== 3) return -1;
  if (right.length !== 3) return 1;
  if (left[0] !== right[0]) return left[0] - right[0];
  return left[2] - right[2];
}
function uniqueSortedXnxqs(values) {
  return Array.from(new Set((values || []).map(normalizeXnxq).filter(Boolean))).sort(compareXnxq);
}
function storageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}
function storageSet(data) {
  return new Promise(resolve => chrome.storage.local.set(data, resolve));
}
function maybeDownloadJSON(data, filename) {
  if (confirm(`是否下载 ${filename}？\n\n取消也会保留在插件本地数据中。`)) {
    downloadJSON(data, filename);
  }
}
function scheduleSample(data) {
  return (data?.data || []).slice(0, 5).map(c => ({
    courseId: c.courseId,
    courseSeq: c.courseSeq,
    courseName: c.courseName,
    teacher: c.teacher,
    schedule: c.schedule
  }));
}
async function debugScheduleState(label) {
  const state = await storageGet([
    "activeXnxq",
    "latestXnxq",
    "courseScheduleData",
    "courseScheduleDataByXnxq"
  ]);
  const selected = normalizeXnxq(document.getElementById("xnxqSelect")?.value);
  const buckets = state.courseScheduleDataByXnxq || {};
  console.log(`[CourseHelper][${label}]`, {
    selected,
    activeXnxq: state.activeXnxq,
    latestXnxq: state.latestXnxq,
    legacyXnxq: state.courseScheduleData?.xnxq,
    bucketKeys: Object.keys(buckets),
    legacySample: scheduleSample(state.courseScheduleData),
    selectedBucketSample: scheduleSample(buckets[selected]),
    activeBucketSample: scheduleSample(buckets[normalizeXnxq(state.activeXnxq)])
  });
}
function collectStoredXnxqs(state) {
  return uniqueSortedXnxqs([
    state.activeXnxq,
    state.latestXnxq,
    state.courseScheduleData?.xnxq,
    state.nextSemesterData?.xnxq,
    state.enrollmentStatsData?.xnxq,
    ...(state.availableXnxqs || []),
    ...Object.keys(state.courseScheduleDataByXnxq || {}),
    ...Object.keys(state.nextSemesterDataByXnxq || {}),
    ...Object.keys(state.enrollmentStatsDataByXnxq || {}),
    ...Object.keys(state.selectedCoursesByXnxq || {}),
    ...Object.keys(state.selectedPreferencePlanByXnxq || {})
  ]);
}
function pruneByLatestTwo(map, keepXnxqs) {
  const keep = new Set(uniqueSortedXnxqs(keepXnxqs).slice(-2));
  const result = {};
  Object.entries(map || {}).forEach(([xnxq, value]) => {
    const normalized = normalizeXnxq(xnxq);
    if (normalized && keep.has(normalized)) result[normalized] = value;
  });
  return result;
}
async function saveSemesterBucket(kind, xnxq, value) {
  const normalized = normalizeXnxq(xnxq || value?.xnxq);
  if (!normalized) throw new Error("缺少有效学年学期");
  if (kind === "schedule") {
    console.log("[CourseHelper][saveSemesterBucket:start]", {
      kind,
      normalized,
      valueXnxq: value?.xnxq,
      requestedXnxq: value?.requestedXnxq,
      sample: scheduleSample(value)
    });
  }
  const keys = [
    "availableXnxqs",
    "activeXnxq",
    "latestXnxq",
    "courseScheduleData",
    "nextSemesterData",
    "enrollmentStatsData",
    "courseScheduleDataByXnxq",
    "nextSemesterDataByXnxq",
    "enrollmentStatsDataByXnxq",
  ];
  const state = await storageGet(keys);
  const scheduleBy = { ...(state.courseScheduleDataByXnxq || {}) };
  const nextBy = { ...(state.nextSemesterDataByXnxq || {}) };
  const statsBy = { ...(state.enrollmentStatsDataByXnxq || {}) };
  if (state.courseScheduleData?.xnxq) scheduleBy[state.courseScheduleData.xnxq] = state.courseScheduleData;
  if (state.nextSemesterData?.xnxq) nextBy[state.nextSemesterData.xnxq] = state.nextSemesterData;
  if (state.enrollmentStatsData?.xnxq) statsBy[state.enrollmentStatsData.xnxq] = state.enrollmentStatsData;

  const nextState = { activeXnxq: normalized };
  if (kind === "schedule") {
    scheduleBy[normalized] = value;
    nextState.courseScheduleData = value;
  } else if (kind === "nextSemester") {
    nextBy[normalized] = value;
    nextState.nextSemesterData = value;
  } else if (kind === "enrollment") {
    statsBy[normalized] = value;
    nextState.enrollmentStatsData = value;
  }

  const availableXnxqs = collectStoredXnxqs({
    ...state,
    ...nextState,
    availableXnxqs: [...(state.availableXnxqs || []), normalized],
    courseScheduleDataByXnxq: scheduleBy,
    nextSemesterDataByXnxq: nextBy,
    enrollmentStatsDataByXnxq: statsBy,
  });
  const keepXnxqs = uniqueSortedXnxqs([...Object.keys(scheduleBy), normalized]).slice(-2);

  await storageSet({
    ...nextState,
    availableXnxqs,
    latestXnxq: availableXnxqs[availableXnxqs.length - 1] || normalized,
    courseScheduleDataByXnxq: pruneByLatestTwo(scheduleBy, keepXnxqs),
    nextSemesterDataByXnxq: pruneByLatestTwo(nextBy, keepXnxqs),
    enrollmentStatsDataByXnxq: pruneByLatestTwo(statsBy, keepXnxqs),
  });
  await syncActiveSemester(normalized);
  if (kind === "schedule") await debugScheduleState("saveSemesterBucket:after");
}
async function syncActiveSemester(xnxq) {
  const normalized = normalizeXnxq(xnxq);
  if (!normalized) return;
  const state = await storageGet([
    "courseScheduleDataByXnxq",
    "nextSemesterDataByXnxq",
    "enrollmentStatsDataByXnxq",
    "selectedCoursesByXnxq",
    "selectedPreferencePlanByXnxq",
    "selectedPreferenceOrderByXnxq"
  ]);
  const patch = { activeXnxq: normalized };
  if (state.courseScheduleDataByXnxq?.[normalized]) patch.courseScheduleData = state.courseScheduleDataByXnxq[normalized];
  else patch.courseScheduleData = null;
  if (state.nextSemesterDataByXnxq?.[normalized]) patch.nextSemesterData = state.nextSemesterDataByXnxq[normalized];
  else patch.nextSemesterData = null;
  if (state.enrollmentStatsDataByXnxq?.[normalized]) patch.enrollmentStatsData = state.enrollmentStatsDataByXnxq[normalized];
  else patch.enrollmentStatsData = null;
  patch.selectedCourses = state.selectedCoursesByXnxq?.[normalized] || [];
  patch.selectedPreferencePlan = state.selectedPreferencePlanByXnxq?.[normalized] || {};
  patch.selectedPreferenceOrder = state.selectedPreferenceOrderByXnxq?.[normalized] || undefined;
  await storageSet(patch);
}
async function getActiveXnxq() {
  const state = await storageGet([
    "activeXnxq",
    "latestXnxq",
    "availableXnxqs",
    "courseScheduleData",
    "nextSemesterData",
    "enrollmentStatsData",
    "courseScheduleDataByXnxq",
    "nextSemesterDataByXnxq",
    "enrollmentStatsDataByXnxq"
  ]);
  const active = normalizeXnxq(state.activeXnxq);
  if (active) return active;
  const all = collectStoredXnxqs(state);
  return all[all.length - 1] || "";
}
async function getSelectedOrActiveXnxq() {
  const selected = normalizeXnxq(document.getElementById("xnxqSelect")?.value);
  return selected || await getActiveXnxq();
}
async function refreshPlanner() {
  const dashboard = window.courseHelperDashboard || window.dashboard;
  if (dashboard?.schedulePlanner) {
    await dashboard.schedulePlanner.loadData();
    dashboard.schedulePlanner.render();
  }
}
async function refreshSemesterSelect() {
  const select = document.getElementById("xnxqSelect");
  if (!select) return;
  const state = await storageGet([
    "activeXnxq",
    "availableXnxqs",
    "courseScheduleData",
    "nextSemesterData",
    "enrollmentStatsData",
    "courseScheduleDataByXnxq",
    "nextSemesterDataByXnxq",
    "enrollmentStatsDataByXnxq",
    "selectedCoursesByXnxq",
    "selectedPreferencePlanByXnxq"
  ]);
  const xnxqs = collectStoredXnxqs(state);
  const active = normalizeXnxq(state.activeXnxq) || xnxqs[xnxqs.length - 1] || "";
  select.innerHTML = xnxqs.length
    ? xnxqs.map(x => `<option value="${x}" ${x === active ? "selected" : ""}>${x}</option>`).join("")
    : `<option value="">暂无学期</option>`;
  select.disabled = !xnxqs.length;
}
async function migrateLegacySemesterData() {
  const state = await storageGet([
    "activeXnxq",
    "courseScheduleData",
    "nextSemesterData",
    "enrollmentStatsData",
    "selectedCourses",
    "selectedPreferencePlan",
    "selectedPreferenceOrder",
    "courseScheduleDataByXnxq",
    "nextSemesterDataByXnxq",
    "enrollmentStatsDataByXnxq",
    "selectedCoursesByXnxq",
    "selectedPreferencePlanByXnxq",
    "selectedPreferenceOrderByXnxq",
    "availableXnxqs"
  ]);
  const scheduleBy = { ...(state.courseScheduleDataByXnxq || {}) };
  const nextBy = { ...(state.nextSemesterDataByXnxq || {}) };
  const statsBy = { ...(state.enrollmentStatsDataByXnxq || {}) };
  const selectedBy = { ...(state.selectedCoursesByXnxq || {}) };
  const prefBy = { ...(state.selectedPreferencePlanByXnxq || {}) };
  const prefOrderBy = { ...(state.selectedPreferenceOrderByXnxq || {}) };
  let changed = false;

  const scheduleXnxq = normalizeXnxq(state.courseScheduleData?.xnxq);
  if (scheduleXnxq && !scheduleBy[scheduleXnxq]) {
    scheduleBy[scheduleXnxq] = state.courseScheduleData;
    changed = true;
  }
  const nextXnxq = normalizeXnxq(state.nextSemesterData?.xnxq);
  if (nextXnxq && !nextBy[nextXnxq]) {
    nextBy[nextXnxq] = state.nextSemesterData;
    changed = true;
  }
  const statsXnxq = normalizeXnxq(state.enrollmentStatsData?.xnxq);
  if (statsXnxq && !statsBy[statsXnxq]) {
    statsBy[statsXnxq] = state.enrollmentStatsData;
    changed = true;
  }
  const active = normalizeXnxq(state.activeXnxq) || scheduleXnxq || nextXnxq || statsXnxq;
  if (active && Array.isArray(state.selectedCourses) && !selectedBy[active]) {
    selectedBy[active] = state.selectedCourses;
    changed = true;
  }
  if (active && state.selectedPreferencePlan && !prefBy[active]) {
    prefBy[active] = state.selectedPreferencePlan;
    changed = true;
  }
  if (active && state.selectedPreferenceOrder && !prefOrderBy[active]) {
    prefOrderBy[active] = state.selectedPreferenceOrder;
    changed = true;
  }

  const availableXnxqs = collectStoredXnxqs({
    ...state,
    activeXnxq: active,
    courseScheduleDataByXnxq: scheduleBy,
    nextSemesterDataByXnxq: nextBy,
    enrollmentStatsDataByXnxq: statsBy,
    selectedCoursesByXnxq: selectedBy,
    selectedPreferencePlanByXnxq: prefBy
  });
  if (!changed && availableXnxqs.join("|") === (state.availableXnxqs || []).join("|")) return;

  const keepXnxqs = uniqueSortedXnxqs([...Object.keys(scheduleBy), active]).slice(-2);
  await storageSet({
    activeXnxq: active || state.activeXnxq || "",
    availableXnxqs,
    courseScheduleDataByXnxq: pruneByLatestTwo(scheduleBy, keepXnxqs),
    nextSemesterDataByXnxq: pruneByLatestTwo(nextBy, keepXnxqs),
    enrollmentStatsDataByXnxq: pruneByLatestTwo(statsBy, keepXnxqs),
    selectedCoursesByXnxq: selectedBy,
    selectedPreferencePlanByXnxq: prefBy,
    selectedPreferenceOrderByXnxq: prefOrderBy,
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "COURSE_SCHEDULE_PROGRESS_UPDATE") {
    const { current, total, status } = msg.data;
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    if (status === "done") {
      showToast("✅ 开课信息抓取完成", "共 " + total + " 页，已全部完成", 100);
      setTimeout(hideToast, 3000);
    } else {
      showToast("🗓️ 正在抓取开课信息...", "第 " + current + " / " + total + " 页 (" + pct + "%)", pct);
    }
  }

  if (msg.type === "ENROLLMENT_STATS_PROGRESS_UPDATE") {
    const { source, current, total, rows, status, overallCurrent, overallTotal, error } = msg.data || {};
    const sourceName = source === "BR" ? "普通课" : source === "Ty" ? "体育课" : "选课人数";
    const pct = overallTotal > 0 ? Math.round((overallCurrent / overallTotal) * 100) : 8;
    if (status === "done" && source === "all") {
      showToast("✅ 选课人数刷新完成", "全部统计已更新", 100);
      return;
    }
    if (status === "error") {
      showToast("❌ 选课人数刷新失败", error || "未知错误", 0);
      return;
    }
    if (status === "init" || status === "start") {
      showToast("📈 正在刷新选课人数...", `正在准备读取${sourceName}统计`, Math.max(5, pct));
      return;
    }
    const pageText = total ? `第 ${current} / ${total} 页` : "正在读取分页";
    const rowsText = rows ? `，已解析 ${rows} 条` : "";
    const statusText = status === "done" ? "完成" : pageText;
    showToast("📈 正在刷新选课人数...", `${sourceName} ${statusText}${rowsText}`, Math.max(5, Math.min(98, pct)));
  }
});

document.addEventListener("DOMContentLoaded", () => {
  migrateLegacySemesterData().then(refreshSemesterSelect);

  document.getElementById("actionMenu")?.querySelectorAll("button").forEach(button => {
    button.addEventListener("click", () => {
      setTimeout(() => {
        const menu = document.getElementById("actionMenu");
        if (menu) menu.open = false;
      }, 0);
    });
  });

  document.getElementById("xnxqSelect")?.addEventListener("change", async e => {
    const xnxq = normalizeXnxq(e.target.value);
    if (!xnxq) return;
    console.log("[CourseHelper][xnxqSelect:change]", { xnxq });
    await syncActiveSemester(xnxq);
    await debugScheduleState("xnxqSelect:after-sync");
    await refreshPlanner();
    showToast("已切换学期", xnxq, 100);
    setTimeout(hideToast, 1600);
  });

  document.getElementById("scanXnxq")?.addEventListener("click", async () => {
    const btn = document.getElementById("scanXnxq");
    btn.disabled = true;
    showToast("正在扫描学期", "正在探测选课平台可访问的学期...", 12);
    try {
      const result = await new Promise(resolve => {
        chrome.runtime.sendMessage({ type: "DISCOVER_AVAILABLE_XNXQS" }, resolve);
      });
      if (!result || !result.success) {
        await refreshSemesterSelect();
        showToast("扫描学期失败", result?.error || "未知错误", 0);
        setTimeout(hideToast, 4500);
        return;
      }
      await refreshSemesterSelect();
      showToast("扫描完成", `可选学期：${result.availableXnxqs.join("、") || "暂无"}`, 100);
      setTimeout(hideToast, 3000);
    } catch (e) {
      showToast("扫描出错", e.message, 0);
      setTimeout(hideToast, 4500);
    } finally {
      btn.disabled = false;
    }
  });

  // ----- 抓取当前学期推荐课单 -----
  document.getElementById("fetchNextSemester")?.addEventListener("click", async () => {
    const btn = document.getElementById("fetchNextSemester");
    btn.disabled = true;
    showToast("📋 正在抓取推荐课列表...", "请稍候，正在打开选课系统...", 10);
    try {
      const xnxq = await getSelectedOrActiveXnxq();
      if (!xnxq) throw new Error("Please scan or select a semester first.");
      const result = await new Promise(resolve => {
        chrome.runtime.sendMessage({ type: "FETCH_NEXT_SEMESTER_COURSES", xnxq }, resolve);
      });
      if (!result || !result.success) {
        showToast("❌ 抓取失败", (result && result.error) ? result.error : "未知错误", 0);
        setTimeout(hideToast, 4000); return;
      }
      showToast("✅ 推荐课列表已获取", "正在解析 HTML...", 80);
      const parser = new DOMParser();
      const doc = parser.parseFromString(result.html, "text/html");
      const rows = [];
      doc.querySelectorAll("table tr.trr2").forEach(tr => {
        const cells = tr.querySelectorAll("td");
        const getText = c => c ? c.textContent.trim().replace(/\s+/g, " ") : "";
        let offset;
        if (cells.length >= 7) offset = 2;
        else if (cells.length >= 5) offset = 0;
        else return;
        const courseId   = getText(cells[offset]);
        const courseName = getText(cells[offset + 1]);
        const type       = getText(cells[offset + 2]);
        const credits    = parseFloat(getText(cells[offset + 3])) || 0;
        const group      = getText(cells[offset + 4]);
        if (!courseId || !/^\d+$/.test(courseId)) return;
        rows.push({ courseId, courseName, type, credits, group });
      });
      const output = { xnxq: result.xnxq || "", fetchTime: new Date().toISOString(), total: rows.length, courses: rows };
      // 保存到 storage 供选课规划器使用
      await saveSemesterBucket("nextSemester", output.xnxq, output);
      await refreshSemesterSelect();
      await refreshPlanner();
      maybeDownloadJSON(output, "next_semester_recommended_" + output.xnxq + "_" + Date.now() + ".json");
      showToast("✅ 完成", "已下载 " + rows.length + " 门推荐课程", 100);
      setTimeout(hideToast, 3000);
    } catch (e) {
      showToast("❌ 出错", e.message, 0); setTimeout(hideToast, 4000);
    } finally { btn.disabled = false; }
  });

  // ----- 抓取全部开课信息 -----
  document.getElementById("fetchCourseSchedule")?.addEventListener("click", async () => {
    const btn = document.getElementById("fetchCourseSchedule");
    btn.disabled = true;
    showToast("🗓️ 开始抓取开课信息...", "正在登录选课系统，请稍候...", 2);
    try {
      const xnxq = await getSelectedOrActiveXnxq();
      if (!xnxq) throw new Error("Please scan or select a semester first.");
      await debugScheduleState("fetchCourseSchedule:before-send");
      console.log("[CourseHelper][fetchCourseSchedule:send]", { xnxq });
      const result = await new Promise(resolve => {
        chrome.runtime.sendMessage({ type: "FETCH_ALL_COURSE_SCHEDULE", xnxq }, resolve);
      });
      if (!result || !result.success) {
        showToast("❌ 抓取失败", (result && result.error) ? result.error : "未知错误", 0);
        setTimeout(hideToast, 4000); return;
      }
      result.requestedXnxq = xnxq;
      result.xnxq = normalizeXnxq(result.xnxq) || xnxq;
      console.log("[CourseHelper][fetchCourseSchedule:result]", {
        requestedXnxq: xnxq,
        resultXnxq: result.xnxq,
        total: result.total,
        sample: scheduleSample(result)
      });
      // 保存到 storage
      await saveSemesterBucket("schedule", xnxq, result);
      await refreshSemesterSelect();
      await refreshPlanner();
      await debugScheduleState("fetchCourseSchedule:after-refresh");
      maybeDownloadJSON(result, "course_schedule_" + result.xnxq + "_" + Date.now() + ".json");
      showToast("✅ 全部完成", "已下载 " + result.total + " 条开课记录", 100);
      setTimeout(hideToast, 4000);
    } catch (e) {
      showToast("❌ 出错", e.message, 0); setTimeout(hideToast, 4000);
    } finally { btn.disabled = false; }
  });

  // ----- 刷新选课人数/志愿统计 -----
  document.getElementById("fetchEnrollmentStats")?.addEventListener("click", async () => {
    const btn = document.getElementById("fetchEnrollmentStats");
    btn.disabled = true;
    showToast("📈 正在刷新选课人数...", "正在读取选课志愿统计，请稍候...", 8);
    try {
      const xnxq = await getSelectedOrActiveXnxq();
      if (!xnxq) throw new Error("Please scan or select a semester first.");
      const result = await new Promise(resolve => {
        chrome.runtime.sendMessage({ type: "FETCH_ENROLLMENT_STATS", xnxq }, resolve);
      });
      if (!result || !result.success) {
        showToast("❌ 刷新失败", (result && result.error) ? result.error : "未知错误", 0);
        setTimeout(hideToast, 5000);
        return;
      }

      const brCount = result.sources?.BR?.actualCount || result.sources?.BR?.rows?.length || 0;
      const tyCount = result.sources?.Ty?.actualCount || result.sources?.Ty?.rows?.length || 0;
      await saveSemesterBucket("enrollment", result.xnxq, result);
      await refreshSemesterSelect();
      showToast("✅ 选课人数已刷新", `普通课 ${brCount} 条，体育 ${tyCount} 条`, 100);

      const dashboard = window.courseHelperDashboard || window.dashboard;
      if (dashboard?.schedulePlanner) {
        await dashboard.schedulePlanner.loadData();
        dashboard.schedulePlanner.render();
      }
      setTimeout(hideToast, 3500);
    } catch (e) {
      showToast("❌ 出错", e.message, 0);
      setTimeout(hideToast, 5000);
    } finally {
      btn.disabled = false;
    }
  });

});
