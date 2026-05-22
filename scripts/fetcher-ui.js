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

  // ----- 抓取下学期推荐课 -----
  document.getElementById("fetchNextSemester")?.addEventListener("click", async () => {
    const btn = document.getElementById("fetchNextSemester");
    btn.disabled = true;
    showToast("📋 正在抓取推荐课列表...", "请稍候，正在打开选课系统...", 10);
    try {
      const result = await new Promise(resolve => {
        chrome.runtime.sendMessage({ type: "FETCH_NEXT_SEMESTER_COURSES" }, resolve);
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
      chrome.storage.local.set({ nextSemesterData: output });
      downloadJSON(output, "next_semester_recommended_" + Date.now() + ".json");
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
      const result = await new Promise(resolve => {
        chrome.runtime.sendMessage({ type: "FETCH_ALL_COURSE_SCHEDULE" }, resolve);
      });
      if (!result || !result.success) {
        showToast("❌ 抓取失败", (result && result.error) ? result.error : "未知错误", 0);
        setTimeout(hideToast, 4000); return;
      }
      // 保存到 storage
      chrome.storage.local.set({ courseScheduleData: result });
      downloadJSON(result, "course_schedule_" + result.xnxq + "_" + Date.now() + ".json");
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
      const result = await new Promise(resolve => {
        chrome.runtime.sendMessage({ type: "FETCH_ENROLLMENT_STATS" }, resolve);
      });
      if (!result || !result.success) {
        showToast("❌ 刷新失败", (result && result.error) ? result.error : "未知错误", 0);
        setTimeout(hideToast, 5000);
        return;
      }

      const brCount = result.sources?.BR?.actualCount || result.sources?.BR?.rows?.length || 0;
      const tyCount = result.sources?.Ty?.actualCount || result.sources?.Ty?.rows?.length || 0;
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
