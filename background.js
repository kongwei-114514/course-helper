console.log("Course Helper background loaded (refactored version)");

chrome.tabs.onCreated.addListener(tab => {
  console.log("[GLOBAL] tab created:", tab.id, tab.url);
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete") {
    console.log("[GLOBAL] tab updated:", tabId, tab.url);
  }
});

// =======================================================
// 全局状态管理
// =======================================================
let autoRefreshEnabled = false;
let autoRefreshIntervalMs = 500000;
let pluginInitiatedLogin = false;
let pendingRedirectTabId = null;

// =======================================================
// 点击插件图标
// =======================================================
chrome.action.onClicked.addListener(async () => {
  console.log("Course Helper: icon clicked");

  chrome.tabs.create({
    url: chrome.runtime.getURL("dashboard.html")
  });

  pluginInitiatedLogin = true;
  chrome.tabs.create({
    url: "http://zhjwxk.cic.tsinghua.edu.cn/xklogin.do",
  });
});

// =======================================================
// 登录跳转控制
// =======================================================
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== pendingRedirectTabId) return;
  if (changeInfo.status !== "complete") return;

  chrome.tabs.update(tabId, {
    url: "http://zhjwxk.cic.tsinghua.edu.cn/xklogin.do",
  });

  pluginInitiatedLogin = false;
  pendingRedirectTabId = null;
});

// =======================================================
// 消息中心
// =======================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === "FETCH_TRAINING_PLAN_HTML") {
    fetchTrainingPlanHTML().then(sendResponse);
    return true;
  }

  if (msg.type === "FETCH_NEXT_SEMESTER_COURSES") {
    fetchNextSemesterCourses(msg.xnxq).then(sendResponse);
    return true;
  }

  if (msg.type === "FETCH_ALL_COURSE_SCHEDULE") {
    fetchAllCourseSchedule(sender.tab?.id, msg.progressTabId, msg.xnxq).then(sendResponse);
    return true;
  }

  if (msg.type === "FETCH_ENROLLMENT_STATS") {
    fetchEnrollmentStats(sender.tab?.id, msg.xnxq).then(sendResponse);
    return true;
  }

  if (msg.type === "DISCOVER_AVAILABLE_XNXQS") {
    discoverAvailableXnxqs(sender.tab?.id).then(sendResponse);
    return true;
  }

  if (msg.type === "COURSE_SCHEDULE_PROGRESS") {
    // 转发进度给 dashboard
    chrome.runtime.sendMessage({ type: "COURSE_SCHEDULE_PROGRESS_UPDATE", data: msg.data });
    return false;
  }

  if (msg.type === "saveLoginProfile") {
    chrome.storage.local.set({ loginProfile: msg.data }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "loadLoginProfile") {
    chrome.storage.local.get(["loginProfile"], res => {
      sendResponse({ data: res.loginProfile || null });
    });
    return true;
  }
});

// =======================================================
// 点击「刷新培养方案完成情况」按钮
// =======================================================
async function clickRefreshButton(tabId) {
  console.log("[TP] trying to click refresh button");

  return chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      return new Promise(resolve => {
        const timer = setInterval(() => {
          const btn = Array.from(document.querySelectorAll('input[type="button"]'))
            .find(b => b.value.includes('刷新培养方案完成情况'));

          if (btn) {
            clearInterval(timer);
            btn.click();
            resolve(true);
          }
        }, 300);

        setTimeout(() => {
          clearInterval(timer);
          resolve(false);
        }, 10000);
      });
    }
  });
}

// =======================================================
// 等刷新完成 → 抓 HTML → 关 tab → resolve
// =======================================================
function extractHtmlAfterRefresh(eduTabId, learnTabId, resolve) {
  console.log("[TP] waiting for refresh completion");

  const onUpdated = (tid, info) => {
    if (tid !== eduTabId) return;
    if (info.status !== "complete") return;

    chrome.tabs.onUpdated.removeListener(onUpdated);

    console.log("[TP] refresh completed, extracting HTML");

    chrome.scripting.executeScript({
      target: { tabId: eduTabId },
      func: () => ({
        url: location.href,
        html: document.documentElement.outerHTML,
      }),
    }).then(res => {
      const data = res[0].result;

      chrome.tabs.remove(learnTabId);
      chrome.tabs.remove(eduTabId);

      resolve({
        success: true,
        url: data.url,
        html: data.html,
      });
    });
  };

  chrome.tabs.onUpdated.addListener(onUpdated);
}

// =======================================================
// 获取培养方案 HTML（完整流程）
// =======================================================
async function fetchTrainingPlanHTML() {
  console.log("=== Fetch Training Plan HTML ===");

  return new Promise(resolve => {

    chrome.tabs.create(
      { url: "https://learn.tsinghua.edu.cn/f/login", active: false },
      learnTab => {

        const learnTabId = learnTab.id;

        const onLearnUpdated = (tabId, info) => {
          if (tabId !== learnTabId || info.status !== "complete") return;

          chrome.scripting.executeScript({
            target: { tabId: learnTabId },
            func: () => location.href,
          }).then(([res]) => {

            const url = res.result;

            // 登录页
            if (url.includes("/f/login")) {
              chrome.scripting.executeScript({
                target: { tabId: learnTabId },
                func: () => {
                  const btn = document.getElementById("loginButtonId");
                  if (btn) btn.click();
                },
              });
              return;
            }

            if (!url.startsWith("https://learn.tsinghua.edu.cn/")) return;

            chrome.tabs.onUpdated.removeListener(onLearnUpdated);

            // 点击培养方案入口
            chrome.scripting.executeScript({
              target: { tabId: learnTabId },
              func: () => {
                const link = Array.from(document.querySelectorAll("a"))
                  .find(a =>
                    a.textContent.includes("培养方案完成情况") &&
                    a.getAttribute("onclick")?.includes("tiaozhuan")
                  );
                if (link) link.click();
              }
            });

            // 监听教务 tab
            const onEduCreated = tab => {

              const eduTabId = tab.id;

              const onEduUpdated = async (tid, info, updatedTab) => {
                if (tid !== eduTabId) return;
                if (!updatedTab.url?.includes("jhBks.by_fascjgmxb_gr.do")) return;
                if (info.status !== "complete") return;

                chrome.tabs.onUpdated.removeListener(onEduUpdated);
                chrome.tabs.onCreated.removeListener(onEduCreated);

                console.log("[TP] edu page loaded");

                // ① 先监听刷新完成
                extractHtmlAfterRefresh(eduTabId, learnTabId, resolve);

                // ② 再点击刷新按钮
                await clickRefreshButton(eduTabId);
              };

              chrome.tabs.onUpdated.addListener(onEduUpdated);
            };

            chrome.tabs.onCreated.addListener(onEduCreated);
          });
        };

        chrome.tabs.onUpdated.addListener(onLearnUpdated);
      }
    );
  });
}

// =======================================================
// 工具：在指定 tab 等待页面加载完成后执行脚本
// =======================================================
function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timeout);
      // 多等 300ms 让 JS 渲染完成
      setTimeout(resolve, 300);
    };
    const listener = (tid, info) => {
      if (tid !== tabId || info.status !== "complete") return;
      finish();
    };
    const timeout = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError) return;
      if (tab?.status === "complete") finish();
    });
  });
}


// =======================================================
// 工具：轮询等待页面上的当前页码变为目标页（用于 form.submit 翻页）
// =======================================================
function waitForPageNumber(tabId, targetPage, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();

    const poll = async () => {
      if (Date.now() - start > timeoutMs) {
        console.warn("[XK] waitForPageNumber timeout waiting for page " + targetPage);
        resolve(); // 超时不报错，直接继续
        return;
      }

      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const input = document.querySelector('input[name="goPageNumber"]');
            if (input) return parseInt(input.value) || 0;
            const text = document.querySelector("p.yeM") ? document.querySelector("p.yeM").textContent : "";
            const m = text.match(/第\s*(\d+)\s*页/);
            return m ? parseInt(m[1]) : 0;
          }
        });

        const currentPage = res[0] && res[0].result ? res[0].result : 0;
        if (currentPage === targetPage) {
          setTimeout(resolve, 200);
        } else {
          setTimeout(poll, 300);
        }
      } catch (e) {
        setTimeout(poll, 300);
      }
    };

    poll();
  });
}

// =======================================================
// 工具：确保选课系统已登录（打开选课登录页等待跳转）
// =======================================================
async function findExistingXkTab() {
  // 找已打开的、已登录的选课系统 tab（不是登录页）
  const tabs = await chrome.tabs.query({});
  const xkTab = tabs.find(t => {
    const url = t.url || "";
    return url.includes("zhjwxk.cic.tsinghua.edu.cn") && !url.includes("xklogin.do");
  });
  return xkTab ? xkTab.id : null;
}

function inferNextXnxqFromDate(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;

  if (month >= 2 && month <= 7) return `${year}-${year + 1}-1`;
  if (month >= 8) return `${year}-${year + 1}-2`;
  return `${year - 1}-${year}-2`;
}

function normalizeXnxq(value) {
  const match = String(value || "").match(/(20\d{2})-(20\d{2})-([1-3])/);
  if (!match) return "";

  const startYear = parseInt(match[1], 10);
  const endYear = parseInt(match[2], 10);
  if (endYear !== startYear + 1) return "";

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

function pickLatestXnxq(values) {
  return values
    .map(normalizeXnxq)
    .filter(Boolean)
    .sort(compareXnxq)
    .pop() || "";
}

function uniqueSortedXnxqs(values) {
  return Array.from(new Set(values.map(normalizeXnxq).filter(Boolean))).sort(compareXnxq);
}

function nextXnxq(xnxq) {
  const normalized = normalizeXnxq(xnxq);
  if (!normalized) return "";
  const [startText, endText, termText] = normalized.split("-");
  let start = parseInt(startText, 10);
  let end = parseInt(endText, 10);
  let term = parseInt(termText, 10);
  if (term < 3) return `${start}-${end}-${term + 1}`;
  start += 1;
  end += 1;
  return `${start}-${end}-1`;
}

function prevXnxq(xnxq) {
  const normalized = normalizeXnxq(xnxq);
  if (!normalized) return "";
  const [startText, endText, termText] = normalized.split("-");
  let start = parseInt(startText, 10);
  let end = parseInt(endText, 10);
  let term = parseInt(termText, 10);
  if (term > 1) return `${start}-${end}-${term - 1}`;
  start -= 1;
  end -= 1;
  return `${start}-${end}-3`;
}

function shiftXnxq(xnxq, steps) {
  let current = normalizeXnxq(xnxq);
  if (!current) return "";
  const move = steps >= 0 ? nextXnxq : prevXnxq;
  for (let i = 0; i < Math.abs(steps); i++) current = move(current);
  return current;
}

function inferProbeStartXnxq(date = new Date()) {
  return shiftXnxq(inferNextXnxqFromDate(date), -3);
}

function getXnxqFromUrl(url) {
  try {
    return normalizeXnxq(new URL(url).searchParams.get("p_xnxq"));
  } catch (e) {
    return "";
  }
}

function getStoredXnxq() {
  return new Promise(resolve => {
    chrome.storage.local.get([
      "latestXnxq",
      "activeXnxq",
      "availableXnxqs",
      "courseScheduleData",
      "nextSemesterData",
      "courseScheduleDataByXnxq",
      "nextSemesterDataByXnxq",
      "enrollmentStatsDataByXnxq"
    ], result => {
      resolve(pickLatestXnxq([
        result.latestXnxq,
        result.activeXnxq,
        result.courseScheduleData?.xnxq,
        result.nextSemesterData?.xnxq,
        ...(result.availableXnxqs || []),
        ...Object.keys(result.courseScheduleDataByXnxq || {}),
        ...Object.keys(result.nextSemesterDataByXnxq || {}),
        ...Object.keys(result.enrollmentStatsDataByXnxq || {}),
      ]));
    });
  });
}

function storeLatestXnxq(xnxq, source) {
  if (!normalizeXnxq(xnxq)) return Promise.resolve();

  return new Promise(resolve => {
    chrome.storage.local.set({
      latestXnxq: xnxq,
      latestXnxqSource: source || "unknown",
      latestXnxqUpdatedAt: new Date().toISOString(),
    }, resolve);
  });
}

function getActiveXnxq() {
  return new Promise(resolve => {
    chrome.storage.local.get(["activeXnxq"], result => resolve(normalizeXnxq(result.activeXnxq)));
  });
}

async function getLatestXnxq(preferredTabId) {
  const tabs = await chrome.tabs.query({});
  const xkTabs = tabs.filter(t => {
    const url = t.url || "";
    return url.includes("zhjwxk.cic.tsinghua.edu.cn") && !url.includes("xklogin.do");
  });
  const urlXnxqs = xkTabs.map(t => getXnxqFromUrl(t.url));
  const candidates = [...urlXnxqs, inferNextXnxqFromDate()];

  const targetTab = xkTabs.find(t => t.id === preferredTabId) || xkTabs[0];
  if (targetTab) {
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId: targetTab.id },
        func: () => {
          const values = [];
          const add = value => {
            const matches = String(value || "").match(/20\d{2}-20\d{2}-[1-3]/g);
            if (matches) values.push(...matches);
          };

          add(location.href);
          document.querySelectorAll("[href], [action], [value], [data-url], [onclick]").forEach(el => {
            add(el.getAttribute("href"));
            add(el.getAttribute("action"));
            add(el.getAttribute("value"));
            add(el.getAttribute("data-url"));
            add(el.getAttribute("onclick"));
          });
          document.querySelectorAll("input[name='p_xnxq'], select[name='p_xnxq'] option").forEach(el => {
            add(el.value);
            add(el.textContent);
          });

          return values;
        },
      });

      const latestFromPage = pickLatestXnxq(res[0]?.result || []);
      if (latestFromPage) {
        candidates.push(latestFromPage);
      }
    } catch (e) {
      console.warn("[XK] failed to scan xnxq from page:", e.message);
    }
  }

  const storedXnxq = await getStoredXnxq();
  const latestXnxq = pickLatestXnxq([...candidates, storedXnxq]);
  await storeLatestXnxq(latestXnxq, "latest-check");
  return latestXnxq;
}

async function getXkTab(preferredTabId, preferredXnxq) {
  const tabs = await chrome.tabs.query({});
  const normalizedXnxq = normalizeXnxq(preferredXnxq);
  const isXkTab = t => (t.url || "").includes("zhjwxk.cic.tsinghua.edu.cn") && !(t.url || "").includes("xklogin.do");
  const matchesXnxq = t => normalizedXnxq && getXnxqFromUrl(t.url || "") === normalizedXnxq;
  return tabs.find(t => t.id === preferredTabId && isXkTab(t) && (!normalizedXnxq || matchesXnxq(t)))
    || tabs.find(t => isXkTab(t) && matchesXnxq(t))
    || tabs.find(t => t.id === preferredTabId && isXkTab(t))
    || tabs.find(t => (t.url || "").includes("zhjwxk.cic.tsinghua.edu.cn") && !(t.url || "").includes("xklogin.do"))
    || null;
}

async function ensureXkTabXnxq(tabId, xnxq) {
  const normalized = normalizeXnxq(xnxq);
  if (!tabId || !normalized) return { ok: false, error: "缺少选课系统标签页或学期" };

  const url = `http://zhjwxk.cic.tsinghua.edu.cn/xkBks.vxkBksXkbBs.do?m=main&p_xnxq=${encodeURIComponent(normalized)}`;
  console.log("[XK] 同步选课系统学期:", { tabId, xnxq: normalized, url });

  try {
    await chrome.tabs.update(tabId, { url, active: false });
    await waitForTabComplete(tabId);
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: (expectedXnxq) => {
        const pageXnxqs = [];
        const add = value => {
          const matches = String(value || "").match(/20\d{2}-20\d{2}-[1-3]/g);
          if (matches) pageXnxqs.push(...matches);
        };
        add(location.href);
        document.querySelectorAll("[href], [action], [value], [data-url], [onclick]").forEach(el => {
          add(el.getAttribute("href"));
          add(el.getAttribute("action"));
          add(el.getAttribute("value"));
          add(el.getAttribute("data-url"));
          add(el.getAttribute("onclick"));
        });
        return {
          ok: location.href.includes(`p_xnxq=${expectedXnxq}`) || pageXnxqs.includes(expectedXnxq),
          href: location.href,
          title: document.title || "",
          pageXnxqs: Array.from(new Set(pageXnxqs)).slice(0, 10),
          textSample: (document.body?.textContent || "").replace(/\s+/g, " ").slice(0, 180),
        };
      },
      args: [normalized]
    });
    const result = res[0]?.result || {};
    if (!result.ok) {
      console.warn("[XK] 学期同步后页面未确认目标学期:", result);
    }
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function buildCourseScheduleSearchUrl(xnxq, extraParams = {}) {
  const normalized = normalizeXnxq(xnxq);
  const params = new URLSearchParams({
    m: "kkxxSearch",
    p_xnxq: normalized,
    ...extraParams
  });
  return `http://zhjwxk.cic.tsinghua.edu.cn/xkBks.vxkBksJxjhBs.do?${params.toString()}`;
}

function createHiddenTab(url) {
  return new Promise(resolve => {
    chrome.tabs.create({ url, active: false }, resolve);
  });
}

function closeTabQuietly(tabId) {
  if (!tabId) return;
  chrome.tabs.remove(tabId).catch(() => {});
}

async function submitNativeCourseSearch(tabId, xnxq) {
  const normalized = normalizeXnxq(xnxq);
  if (!tabId || !normalized) return { ok: false, error: "缺少查询标签页或学期" };

  const res = await chrome.scripting.executeScript({
    target: { tabId },
    func: (targetXnxq) => {
      const form = document.forms.frm || document.querySelector("form");
      if (!form) {
        return {
          ok: false,
          error: "页面没有找到查询表单",
          href: location.href,
          title: document.title || "",
          textSample: (document.body?.textContent || "").replace(/\s+/g, " ").slice(0, 180)
        };
      }

      const setField = (name, value) => {
        let el = form.querySelector(`[name="${name}"]`);
        if (!el) {
          el = document.createElement("input");
          el.type = "hidden";
          el.name = name;
          form.appendChild(el);
        }
        el.value = value;
      };

      setField("m", "kkxxSearch");
      setField("page", "1");
      setField("goPageNumber", "1");
      setField("p_xnxq", targetXnxq);
      [
        "pathContent", "showtitle", "p_kch", "p_kcm", "p_zjjsxm", "p_kkdwnm",
        "p_kcflm", "p_skxq", "p_skjc", "p_xkwzsm", "p_rxklxm", "p_kctsm",
        "p_ssnj", "p_bkskyl_ig", "p_yjskyl_ig", "p_sort.p1", "p_sort.p2"
      ].forEach(name => setField(name, ""));
      setField("p_sort.asc1", "true");
      setField("p_sort.asc2", "true");

      const actionUrl = new URL(form.getAttribute("action") || "xkBks.vxkBksJxjhBs.do", location.href);
      actionUrl.searchParams.set("m", "kkxxSearch");
      actionUrl.searchParams.set("p_xnxq", targetXnxq);
      actionUrl.searchParams.set("_", String(Date.now()));
      form.action = actionUrl.href;
      form.method = "post";

      const before = {
        href: location.href,
        title: document.title || "",
        action: form.action,
        method: form.method,
        tokenPresent: !!form.querySelector('[name="token"]')?.value,
        pXnxq: form.querySelector('[name="p_xnxq"]')?.value || ""
      };

      setTimeout(() => {
        try {
          if (typeof window.doQuery === "function") {
            window.doQuery();
          } else if (typeof form.requestSubmit === "function") {
            form.requestSubmit();
          } else {
            form.submit();
          }
        } catch (e) {
          form.submit();
        }
      }, 0);

      return { ok: true, ...before };
    },
    args: [normalized]
  });

  const result = res[0]?.result || { ok: false, error: "没有返回查询表单提交结果" };
  console.log("[XK] 原生查询提交:", result);
  if (result.ok) await waitForTabComplete(tabId);
  return result;
}

async function getStoredXnxqs() {
  return new Promise(resolve => {
    chrome.storage.local.get([
      "latestXnxq",
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
    ], result => {
      resolve(uniqueSortedXnxqs([
        result.latestXnxq,
        result.activeXnxq,
        result.courseScheduleData?.xnxq,
        result.nextSemesterData?.xnxq,
        result.enrollmentStatsData?.xnxq,
        ...(result.availableXnxqs || []),
        ...Object.keys(result.courseScheduleDataByXnxq || {}),
        ...Object.keys(result.nextSemesterDataByXnxq || {}),
        ...Object.keys(result.enrollmentStatsDataByXnxq || {}),
        ...Object.keys(result.selectedCoursesByXnxq || {}),
        ...Object.keys(result.selectedPreferencePlanByXnxq || {})
      ]));
    });
  });
}

async function probeCourseScheduleXnxq(tabId, xnxq) {
  const normalized = normalizeXnxq(xnxq);
  if (!normalized) return { xnxq, available: false, status: 0, error: "invalid xnxq" };

  const res = await chrome.scripting.executeScript({
    target: { tabId },
    func: (probeXnxq) => {
      return (async () => {
        const url = "http://zhjwxk.cic.tsinghua.edu.cn/xkBks.vxkBksJxjhBs.do";
        const body = new URLSearchParams({
          m: "kkxxSearch",
          page: "1",
          p_xnxq: probeXnxq,
          pathContent: "",
          showtitle: "",
          p_kch: "",
          p_kcm: "",
          p_zjjsxm: "",
          p_kkdwnm: "",
          p_kcflm: "",
          p_skxq: "",
          p_skjc: "",
          p_xkwzsm: "",
          p_rxklxm: "",
          p_kctsm: "",
          p_ssnj: "",
          p_bkskyl_ig: "",
          p_yjskyl_ig: "",
          goPageNumber: "1",
          "p_sort.p1": "",
          "p_sort.p2": "",
          "p_sort.asc1": "true",
          "p_sort.asc2": "true"
        }).toString();

        try {
          const response = await fetch(url, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body
          });
          const html = await response.text();
          const doc = new DOMParser().parseFromString(html, "text/html");
          const rowCount = doc.querySelectorAll("table tr.trr2").length;
          const text = doc.body ? doc.body.textContent.replace(/\s+/g, " ") : "";
          const countMatch = text.match(/共\s*([\d,]+)\s*条记录/) || text.match(/共\s*([\d,]+)\s*条/);
          const totalCount = countMatch ? parseInt(countMatch[1].replace(/,/g, ""), 10) : null;
          return {
            xnxq: probeXnxq,
            available: response.status === 200,
            status: response.status,
            ok: response.ok,
            rowCount,
            totalCount,
            title: doc.title || "",
          };
        } catch (e) {
          return { xnxq: probeXnxq, available: false, status: 0, error: e.message || String(e) };
        }
      })();
    },
    args: [normalized]
  });

  return res[0]?.result || { xnxq: normalized, available: false, status: 0, error: "no probe result" };
}

async function discoverAvailableXnxqs(preferredTabId) {
  const xkTab = await getXkTab(preferredTabId);
  if (!xkTab) {
    const localXnxqs = await getStoredXnxqs();
    return {
      success: false,
      error: "未找到已登录的选课系统标签页，请先打开并登录 zhjwxk.cic.tsinghua.edu.cn",
      availableXnxqs: localXnxqs,
      localXnxqs,
      probes: []
    };
  }

  const start = inferProbeStartXnxq();
  const probes = [];
  const available = [];
  let current = start;
  let consecutiveMissing = 0;
  const maxProbeCount = 18;

  for (let i = 0; i < maxProbeCount && consecutiveMissing < 3; i++) {
    const probe = await probeCourseScheduleXnxq(xkTab.id, current);
    probes.push(probe);
    if (probe.available) {
      available.push(current);
      consecutiveMissing = 0;
    } else {
      consecutiveMissing += 1;
    }
    current = nextXnxq(current);
  }

  const localXnxqs = await getStoredXnxqs();
  const availableXnxqs = uniqueSortedXnxqs([...available, ...localXnxqs]);
  const latestXnxq = pickLatestXnxq(availableXnxqs);
  const currentActiveXnxq = await new Promise(resolve => {
    chrome.storage.local.get(["activeXnxq"], result => resolve(normalizeXnxq(result.activeXnxq)));
  });
  const nextActiveXnxq = currentActiveXnxq || latestXnxq || localXnxqs[localXnxqs.length - 1] || "";
  await new Promise(resolve => {
    chrome.storage.local.set({
      availableXnxqs,
      availableXnxqProbeResults: probes,
      availableXnxqCheckedAt: new Date().toISOString(),
      latestXnxq,
      latestXnxqSource: "probe",
      latestXnxqUpdatedAt: new Date().toISOString(),
      activeXnxq: nextActiveXnxq
    }, resolve);
  });

  return {
    success: true,
    start,
    availableXnxqs,
    probedAvailableXnxqs: uniqueSortedXnxqs(available),
    localXnxqs,
    activeXnxq: nextActiveXnxq,
    probes
  };
}

// =======================================================
// 抓取下学期培养方案推荐课程列表
// =======================================================
async function fetchNextSemesterCourses(requestedXnxq) {
  console.log("=== Fetch Next Semester Courses ===");

  const xnxq = normalizeXnxq(requestedXnxq) || await getActiveXnxq() || await getLatestXnxq();
  const url = `http://zhjwxk.cic.tsinghua.edu.cn/jhBks.vjhBksPyfakcbBs.do?m=showBksZxZdxjxjhXmxqkclist&p_xnxq=${xnxq}`;

  // 新开 tab 访问目标页面
  return new Promise(resolve => {
    chrome.tabs.create({ url, active: false }, async newTab => {
      const newTabId = newTab.id;
      await waitForTabComplete(newTabId);

      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: newTabId },
          func: () => ({
            url: location.href,
            html: document.documentElement.outerHTML,
          }),
        });

        const data = res[0].result;
        const actualXnxq = getXnxqFromUrl(data.url) || xnxq;
        await storeLatestXnxq(actualXnxq, "fetch-result");
        chrome.tabs.remove(newTabId);

        resolve({
          success: true,
          url: data.url,
          html: data.html,
          xnxq: actualXnxq,
        });
      } catch (e) {
        chrome.tabs.remove(newTabId).catch(() => {});
        resolve({ success: false, error: e.message });
      }
    });
  });
}

// =======================================================
// 抓取所有开课信息（多页）
// =======================================================
async function fetchAllCourseSchedule(fromTabId, progressTabId, requestedXnxq) {
  console.log("=== Fetch All Course Schedule ===");

  const xnxq = normalizeXnxq(requestedXnxq) || await getActiveXnxq() || await getLatestXnxq(fromTabId);
  const postUrl = "http://zhjwxk.cic.tsinghua.edu.cn/xkBks.vxkBksJxjhBs.do";

  // 发送进度更新给 dashboard
  function sendProgress(current, total, status) {
    chrome.runtime.sendMessage({
      type: "COURSE_SCHEDULE_PROGRESS_UPDATE",
      data: { current, total, status }
    }).catch(() => {}); // dashboard 可能已关闭，忽略错误
  }

  const xkTab = await getXkTab(fromTabId, xnxq);
  if (!xkTab) {
    return { success: false, error: "未找到已登录的选课系统，请先手动打开并登录 zhjwxk.cic.tsinghua.edu.cn" };
  }
  console.log("[XK] 已登录 tab:", xkTab.id, xkTab.url);

  const mainUrl = `http://zhjwxk.cic.tsinghua.edu.cn/xkBks.vxkBksXkbBs.do?m=main&p_xnxq=${encodeURIComponent(xnxq)}&_=${Date.now()}`;
  const entryUrl = buildCourseScheduleSearchUrl(xnxq, { page: "1", _: String(Date.now()) });
  const workerTab = await createHiddenTab(mainUrl);
  const workerTabId = workerTab.id;
  console.log("[XK] 使用临时查询 tab:", workerTabId, { mainUrl, entryUrl });
  await waitForTabComplete(workerTabId);
  await chrome.tabs.update(workerTabId, { url: entryUrl, active: false });
  await waitForTabComplete(workerTabId);

  // 在新 tab 里用同步 XHR 发 POST
  // 第一页：获取 HTML、token、总页数
  let firstPageRes;
  try {
    firstPageRes = await chrome.scripting.executeScript({
      target: { tabId: workerTabId },
      func: (url, xnxq) => {
      try {
        // 这里不要再额外 POST 第一页。平台会把上一次 kkxxSearch 查询状态缓存到 session，
        // 直接 POST 即使带 p_xnxq 也可能返回旧学期。先进入目标学期页面，再解析当前 DOM。
        const html = document.documentElement.outerHTML || "";
        const status = 200;
        const finalUrl = location.href;
        const currentHtml = html;
        const initialTokenMatch = currentHtml.match(/name="token"[^>]*value="([^"]+)"/);
        const initialToken = initialTokenMatch ? initialTokenMatch[1] : "";
        const tokenMatch = html.match(/name="token"[^>]*value="([^"]+)"/);
        const token = tokenMatch ? tokenMatch[1] : "";
        // 在 tab 里直接解析 HTML（background service worker 没有 DOMParser）
        const doc = new DOMParser().parseFromString(html, "text/html");
        const pageText = doc.body ? doc.body.textContent.replace(/\s+/g, " ") : "";
        const countMatch = pageText.match(/共\s*([\d,]+)\s*条记录/) || pageText.match(/共\s*([\d,]+)\s*条/);
        const totalCount = countMatch ? parseInt(countMatch[1].replace(/,/g, ""), 10) : null;
        const title = doc.title || "";
        const rows = [];
        doc.querySelectorAll("table tr.trr2").forEach(tr => {
          const cells = tr.querySelectorAll("td");
          if (cells.length < 11) return;
          const g = c => c ? c.textContent.trim().replace(/\s+/g, " ") : "";
          const features = [];
          (cells[12] ? cells[12].textContent : "").split(";").forEach(f => { f = f.trim(); if (f) features.push(f); });
          rows.push({
            department: g(cells[0]), courseId: g(cells[1]), courseSeq: g(cells[2]),
            courseName: g(cells[3]), credits: parseFloat(g(cells[4])) || 0,
            teacher: g(cells[5]), bkCapacity: parseInt(g(cells[6])) || 0,
            bkRemaining: parseInt(g(cells[7])) || 0, yjsCapacity: parseInt(g(cells[8])) || 0,
            yjsRemaining: parseInt(g(cells[9])) || 0, schedule: g(cells[10]),
            notes: g(cells[11]), features: features, grade: g(cells[13]),
            isSecondLevel: g(cells[14]), repeatFillsCapacity: g(cells[16]),
            hasTimeLimit: g(cells[17]), generalGroup: g(cells[18]),
          });
        });
        const endpageEl = doc.querySelector("#endpage");
        const endpageText = [
          endpageEl?.getAttribute("href"),
          endpageEl?.getAttribute("onclick"),
          endpageEl?.textContent
        ].filter(Boolean).join(" ");
        const paginationText = [endpageText, html, pageText].filter(Boolean).join(" ");
        const turnPages = Array.from(paginationText.matchAll(/turn\s*\(\s*(\d+)\s*\)/g))
          .map(m => parseInt(m[1], 10))
          .filter(n => Number.isFinite(n) && n > 0);
        const endpageMatch = endpageText.match(/turn\s*\(\s*(\d+)\s*\)/);
        const textPageMatch = pageText.match(/第\s*\d+\s*页\s*[\/／]\s*共\s*(\d+)\s*页/)
          || pageText.match(/共\s*(\d+)\s*页/);
        let totalPages = endpageMatch ? parseInt(endpageMatch[1], 10) : null;
        if (!totalPages && textPageMatch) totalPages = parseInt(textPageMatch[1], 10);
        if (!totalPages && turnPages.length) totalPages = Math.max(...turnPages);
        if (!totalPages && totalCount && rows.length) totalPages = Math.ceil(totalCount / rows.length);
        if (!totalPages && totalCount === 0) totalPages = 1;
        if (!totalPages && rows.length) totalPages = 1;
        const sampleRows = rows.slice(0, 5).map(r => ({
          courseId: r.courseId,
          courseSeq: r.courseSeq,
          courseName: r.courseName,
          teacher: r.teacher,
          schedule: r.schedule
        }));
        const htmlSample = pageText.slice(0, 220);
        return {
          ok: status >= 200 && status < 300,
          status,
          finalUrl,
          locationHref: location.href,
          bodyXnxq: xnxq,
          initialTokenPresent: !!initialToken,
          source: "initial-dom",
          rows,
          sampleRows,
          token,
          totalPages,
          totalCount,
          title,
          htmlSample,
          htmlLength: html.length
        };
      } catch (e) {
        return { ok: false, error: e.message };
      }
      },
      args: [buildCourseScheduleSearchUrl(xnxq, { _: String(Date.now()) }), xnxq]
    });

    const firstPage = firstPageRes[0] && firstPageRes[0].result;
    console.log("[XK] first page parsed:", {
      xnxq,
      bodyXnxq: firstPage?.bodyXnxq,
      status: firstPage?.status,
      totalPages: firstPage?.totalPages,
      totalCount: firstPage?.totalCount,
      rows: firstPage?.rows?.length,
      title: firstPage?.title,
      source: firstPage?.source,
      initialTokenPresent: firstPage?.initialTokenPresent,
      locationHref: firstPage?.locationHref,
      finalUrl: firstPage?.finalUrl,
      sampleRows: firstPage?.sampleRows,
      htmlSample: firstPage?.htmlSample
    });
    if (!firstPage || !firstPage.ok) {
      const details = firstPage?.htmlSample ? `，摘要：${firstPage.htmlSample}` : "";
      return { success: false, error: (firstPage && firstPage.error) || `第一页请求失败：${xnxq}，HTTP ${firstPage?.status || "unknown"}${details}` };
    }
    if (!firstPage.totalPages) {
      return {
        success: false,
        error: `无法获取总页数：${xnxq}。HTTP ${firstPage.status || "unknown"}，标题：${firstPage.title || "无"}，第一页课程 ${firstPage.rows?.length || 0} 条，HTML ${firstPage.htmlLength || 0} 字符，摘要：${firstPage.htmlSample || ""}`
      };
    }

    const totalPages = firstPage.totalPages;
    const totalCount = firstPage.totalCount;
    let currentToken = firstPage.token;
    console.log("[XK] 共 " + totalPages + " 页，" + totalCount + " 条记录");
    sendProgress(1, totalPages, "running");

    const allRows = [];
    allRows.push(...firstPage.rows);

    // 逐页同步 XHR，每页从响应里取新 token
    for (let page = 2; page <= totalPages; page++) {
      sendProgress(page, totalPages, "running");

      const pageRes = await chrome.scripting.executeScript({
        target: { tabId: workerTabId },
        func: (url, xnxq, page, token) => {
        try {
          const body = "m=kkxxSearch&page=" + page + "&token=" + token +
            "&p_xnxq=" + xnxq +
            "&pathContent=&showtitle=&p_kch=&p_kcm=&p_zjjsxm=&p_kkdwnm=" +
            "&p_kcflm=&p_skxq=&p_skjc=&p_xkwzsm=&p_rxklxm=&p_kctsm=&p_ssnj=" +
            "&p_bkskyl_ig=&p_yjskyl_ig=&goPageNumber=" + page +
            "&p_sort.p1=&p_sort.p2=&p_sort.asc1=true&p_sort.asc2=true";
          const xhr = new XMLHttpRequest();
          xhr.open("POST", url, false);
          xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
          xhr.withCredentials = true;
          xhr.send(body);
          const html = xhr.responseText;
          const tokenMatch = html.match(/name="token"[^>]*value="([^"]+)"/);
          const nextToken = tokenMatch ? tokenMatch[1] : token;
          // 在 tab 里直接解析
          const doc = new DOMParser().parseFromString(html, "text/html");
          const rows = [];
          doc.querySelectorAll("table tr.trr2").forEach(tr => {
            const cells = tr.querySelectorAll("td");
            if (cells.length < 11) return;
            const g = c => c ? c.textContent.trim().replace(/\s+/g, " ") : "";
            const features = [];
            (cells[12] ? cells[12].textContent : "").split(";").forEach(f => { f = f.trim(); if (f) features.push(f); });
            rows.push({
              department: g(cells[0]), courseId: g(cells[1]), courseSeq: g(cells[2]),
              courseName: g(cells[3]), credits: parseFloat(g(cells[4])) || 0,
              teacher: g(cells[5]), bkCapacity: parseInt(g(cells[6])) || 0,
              bkRemaining: parseInt(g(cells[7])) || 0, yjsCapacity: parseInt(g(cells[8])) || 0,
              yjsRemaining: parseInt(g(cells[9])) || 0, schedule: g(cells[10]),
              notes: g(cells[11]), features: features, grade: g(cells[13]),
              isSecondLevel: g(cells[14]), repeatFillsCapacity: g(cells[16]),
              hasTimeLimit: g(cells[17]), generalGroup: g(cells[18]),
            });
          });
          return { ok: true, rows, nextToken };
        } catch (e) {
          return { ok: false, error: e.message };
        }
        },
        args: [buildCourseScheduleSearchUrl(xnxq, { page: String(page), _: String(Date.now()) }), xnxq, page, currentToken]
      });

      const pageResult = pageRes[0] && pageRes[0].result;
      if (!pageResult || !pageResult.ok) {
        console.warn("[XK] 第 " + page + " 页失败，跳过");
        continue;
      }

      currentToken = pageResult.nextToken;
      allRows.push(...pageResult.rows);
      console.log("[XK] 第 " + page + "/" + totalPages + " 页，本页 " + pageResult.rows.length + " 条");
    }

    sendProgress(totalPages, totalPages, "done");
    console.log("[XK] 全部完成，共 " + allRows.length + " 条", {
      xnxq,
      sampleRows: allRows.slice(0, 5).map(r => ({
        courseId: r.courseId,
        courseSeq: r.courseSeq,
        courseName: r.courseName,
        teacher: r.teacher,
        schedule: r.schedule
      }))
    });

    return {
      success: true,
      total: allRows.length,
      data: allRows,
      xnxq,
      fetchTime: new Date().toISOString()
    };
  } finally {
    closeTabQuietly(workerTabId);
  }
}

// =======================================================
// 抓取选课志愿人数统计（BR + 体育）
// =======================================================
async function fetchEnrollmentStats(fromTabId, requestedXnxq) {
  console.log("=== Fetch Enrollment Stats ===");

  try {
    sendEnrollmentProgress({ source: "BR", current: 0, total: 0, overallCurrent: 0, overallTotal: 0, status: "start" });
    const xnxq = normalizeXnxq(requestedXnxq) || await getActiveXnxq() || await getLatestXnxq(fromTabId);
    const xkTab = await getXkTab(fromTabId, xnxq);
    if (!xkTab) {
      return { success: false, error: "未找到已登录的选课系统，请先手动打开并登录 zhjwxk.cic.tsinghua.edu.cn" };
    }
    const syncResult = await ensureXkTabXnxq(xkTab.id, xnxq);
    if (!syncResult.ok) {
      return { success: false, error: `无法切换选课系统到 ${xnxq}：${syncResult.error || "未知错误"}` };
    }

    let knownTotalPages = 0;
    let completedPages = 0;
    const onSourceProgress = info => {
      if (info.status === "init") {
        sendEnrollmentProgress({
          ...info,
          overallCurrent: completedPages,
          overallTotal: knownTotalPages,
        });
        return;
      }
      if (info.status === "started") {
        knownTotalPages += info.total || 0;
      }
      sendEnrollmentProgress({
        ...info,
        overallCurrent: completedPages + (info.current || 0),
        overallTotal: knownTotalPages,
      });
      if (info.status === "done") {
        completedPages += info.total || 0;
      }
    };

    const stats = {
      BR: await fetchEnrollmentSource(xkTab.id, xnxq, "BR", onSourceProgress),
      Ty: await fetchEnrollmentSource(xkTab.id, xnxq, "Ty", onSourceProgress)
    };

    const scheduleData = await getCourseScheduleData(xnxq);
    const brJoined = joinEnrollmentRows(stats.BR.rows, scheduleData);
    const tyJoined = joinEnrollmentRows(stats.Ty.rows, scheduleData);

    const result = {
      success: true,
      xnxq,
      fetchTime: new Date().toISOString(),
      sources: {
        BR: {
          totalPages: stats.BR.totalPages,
          expectedCount: stats.BR.expectedCount,
          actualCount: stats.BR.actualCount,
          matched: brJoined.matched,
          unmatched: stats.BR.actualCount - brJoined.matched,
          rows: brJoined.rows
        },
        Ty: {
          totalPages: stats.Ty.totalPages,
          expectedCount: stats.Ty.expectedCount,
          actualCount: stats.Ty.actualCount,
          matched: tyJoined.matched,
          unmatched: stats.Ty.actualCount - tyJoined.matched,
          rows: tyJoined.rows
        }
      }
    };

    await saveEnrollmentStatsForXnxq(result);
    sendEnrollmentProgress({
      source: "all",
      current: knownTotalPages,
      total: knownTotalPages,
      overallCurrent: knownTotalPages,
      overallTotal: knownTotalPages,
      status: "done",
    });
    console.log("[EnrollmentStats] done:", {
      xnxq,
      BR: {
        expectedCount: result.sources.BR.expectedCount,
        actualCount: result.sources.BR.actualCount,
        matched: result.sources.BR.matched,
        unmatched: result.sources.BR.unmatched
      },
      Ty: {
        expectedCount: result.sources.Ty.expectedCount,
        actualCount: result.sources.Ty.actualCount,
        matched: result.sources.Ty.matched,
        unmatched: result.sources.Ty.unmatched
      }
    });

    return result;
  } catch (e) {
    console.error("[EnrollmentStats] failed:", e);
    sendEnrollmentProgress({ source: "all", current: 0, total: 0, overallCurrent: 0, overallTotal: 0, status: "error", error: e.message || String(e) });
    return { success: false, error: e.message || String(e) };
  }
}

function sendEnrollmentProgress(data) {
  chrome.runtime.sendMessage({ type: "ENROLLMENT_STATS_PROGRESS_UPDATE", data }).catch(() => {});
}

async function fetchEnrollmentSource(tabId, xnxq, source, onProgress) {
  onProgress?.({ source, current: 0, total: 0, rows: 0, status: "init" });
  const firstPage = await fetchEnrollmentPage(tabId, xnxq, source, 1);
  if (!firstPage.ok) throw new Error(firstPage.error || source + " 第 1 页抓取失败");

  const totalPages = firstPage.totalPages || 1;
  const rows = [...firstPage.rows];
  console.log(`[EnrollmentStats] ${source} page 1/${totalPages}, rows=${rows.length}`);
  onProgress?.({ source, current: 1, total: totalPages, rows: rows.length, status: "started" });

  for (let page = 2; page <= totalPages; page++) {
    const parsed = await fetchEnrollmentPage(tabId, xnxq, source, page);
    if (!parsed.ok) throw new Error(parsed.error || `${source} 第 ${page} 页抓取失败`);

    rows.push(...parsed.rows);
    if (page % 10 === 0 || page === totalPages) {
      console.log(`[EnrollmentStats] ${source} page ${page}/${totalPages}, rows=${rows.length}`);
    }
    onProgress?.({ source, current: page, total: totalPages, rows: rows.length, status: page === totalPages ? "done" : "running" });
    await new Promise(resolve => setTimeout(resolve, 80));
  }

  if (totalPages === 1) {
    onProgress?.({ source, current: 1, total: 1, rows: rows.length, status: "done" });
  }

  return {
    source,
    totalPages,
    expectedCount: firstPage.totalCount,
    actualCount: rows.length,
    rows
  };
}

async function fetchEnrollmentPage(tabId, xnxq, source, page) {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    func: (xnxq, source, page) => {
      const base = "http://zhjwxk.cic.tsinghua.edu.cn/xkBks.xkBksZytjb.do";

      function xhrText(url) {
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("GET", url, true);
          xhr.withCredentials = true;
          xhr.onreadystatechange = () => {
            if (xhr.readyState !== 4) return;
            if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
            else reject(new Error("HTTP " + xhr.status + ": " + url));
          };
          xhr.onerror = () => reject(new Error("Network error: " + url));
          xhr.send();
        });
      }

      function getText(cell) {
        const span = cell ? cell.querySelector(".trunk") : null;
        return (span?.getAttribute("title") || cell?.textContent || "")
          .trim()
          .replace(/\s+/g, " ");
      }

      function parseTuple(raw) {
        const value = String(raw || "");
        const prefixMatch = value.match(/^\(([^)]+)\)/);
        const body = value.replace(/^\([^)]+\)/, "").trim();
        const nums = body.split(",").map(x => parseInt(x.trim(), 10) || 0);
        return {
          raw: value,
          prefix: prefixMatch ? prefixMatch[1] : "",
          first: nums[0] || 0,
          second: nums[1] || 0,
          third: nums[2] || 0,
          total: (nums[0] || 0) + (nums[1] || 0) + (nums[2] || 0)
        };
      }

      function parsePage(html, source) {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const pageText = doc.querySelector(".yeM")?.textContent?.replace(/\s+/g, " ").trim() || "";
        const pageMatch = pageText.match(/第\s*(\d+)\s*页\s*\/\s*共\s*(\d+)\s*页/);
        const countMatch = pageText.match(/共\s*([\d,]+)\s*条记录/);
        const rows = [];

        doc.querySelectorAll("tr.trr2").forEach(tr => {
          const cells = Array.from(tr.querySelectorAll("td"));
          if (source === "BR") {
            if (cells.length < 9) return;
            rows.push({
              source,
              courseId: getText(cells[0]),
              courseSeq: getText(cells[1]),
              courseName: getText(cells[2]),
              department: getText(cells[3]),
              capacity: parseInt(getText(cells[4]), 10) || 0,
              totalApplicants: parseInt(getText(cells[5]), 10) || 0,
              requiredPrefs: parseTuple(getText(cells[6])),
              limitedPrefs: parseTuple(getText(cells[7])),
              electivePrefs: parseTuple(getText(cells[8]))
            });
            return;
          }

          if (cells.length < 6) return;
          rows.push({
            source,
            courseId: getText(cells[0]),
            courseSeq: getText(cells[1]),
            courseName: getText(cells[2]),
            capacity: parseInt(getText(cells[3]), 10) || 0,
            totalApplicants: parseInt(getText(cells[4]), 10) || 0,
            sportsPrefs: parseTuple(getText(cells[5]))
          });
        });

        return {
          ok: true,
          source,
          currentPage: pageMatch ? parseInt(pageMatch[1], 10) : null,
          totalPages: pageMatch ? parseInt(pageMatch[2], 10) : null,
          totalCount: countMatch ? parseInt(countMatch[1].replace(/,/g, ""), 10) : null,
          rows
        };
      }

      return (async () => {
        try {
          const method = source === "BR" ? "tbzySearchBR" : "tbzySearchTy";
          const url = `${base}?m=${method}&p_xnxq=${encodeURIComponent(xnxq)}&page=${page}`;
          const html = await xhrText(url);
          return parsePage(html, source);
        } catch (e) {
          return { ok: false, error: e.message || String(e), source, page };
        }
      })();
    },
    args: [xnxq, source, page]
  });

  return res[0]?.result || { ok: false, error: `${source} 第 ${page} 页没有返回结果` };
}

function getCourseScheduleData(xnxq) {
  return new Promise(resolve => {
    chrome.storage.local.get(["courseScheduleData", "courseScheduleDataByXnxq"], result => {
      const normalized = normalizeXnxq(xnxq);
      if (normalized && result.courseScheduleDataByXnxq?.[normalized]) {
        resolve(result.courseScheduleDataByXnxq[normalized]);
        return;
      }
      const legacy = result.courseScheduleData || null;
      resolve(!normalized || legacy?.xnxq === normalized ? legacy : null);
    });
  });
}

function setLocalStorage(data) {
  return new Promise(resolve => {
    chrome.storage.local.set(data, resolve);
  });
}

function saveEnrollmentStatsForXnxq(result) {
  const xnxq = normalizeXnxq(result?.xnxq);
  if (!xnxq) return setLocalStorage({ enrollmentStatsData: result });
  return new Promise(resolve => {
    chrome.storage.local.get(["enrollmentStatsDataByXnxq", "availableXnxqs"], state => {
      const byXnxq = {
        ...(state.enrollmentStatsDataByXnxq || {}),
        [xnxq]: result
      };
      const keep = new Set(uniqueSortedXnxqs(Object.keys(byXnxq)).slice(-2));
      const pruned = {};
      Object.entries(byXnxq).forEach(([key, value]) => {
        if (keep.has(normalizeXnxq(key))) pruned[normalizeXnxq(key)] = value;
      });
      chrome.storage.local.set({
        activeXnxq: xnxq,
        enrollmentStatsData: result,
        enrollmentStatsDataByXnxq: pruned,
        availableXnxqs: uniqueSortedXnxqs([...(state.availableXnxqs || []), xnxq])
      }, resolve);
    });
  });
}

function joinEnrollmentRows(rows, scheduleData) {
  const scheduleRows = scheduleData?.data || [];
  const byKey = new Map();

  for (const course of scheduleRows) {
    const key = `${course.courseId}::${course.courseSeq}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(course);
  }

  let matched = 0;
  const joinedRows = rows.map(row => {
    const key = `${row.courseId}::${row.courseSeq}`;
    const matches = byKey.get(key) || [];
    if (matches.length) matched++;
    const matchedCourses = matches.map(course => ({
      courseId: course.courseId,
      courseSeq: course.courseSeq,
      courseName: course.courseName,
      teacher: course.teacher,
      schedule: course.schedule,
      credits: course.credits,
      bkCapacity: course.bkCapacity,
      bkRemaining: course.bkRemaining,
      notes: course.notes,
      features: course.features,
      grade: course.grade,
      generalGroup: course.generalGroup
    }));

    return {
      ...row,
      matchCount: matches.length,
      teachers: Array.from(new Set(matchedCourses.map(c => c.teacher).filter(Boolean))),
      schedules: Array.from(new Set(matchedCourses.map(c => c.schedule).filter(Boolean))),
      matchedCourses
    };
  });

  return { rows: joinedRows, matched };
}


// =======================================================
// 从 HTML 字符串解析开课数据行（在 background service worker 里运行）
// =======================================================
function parseScheduleHTML(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const rows = [];

  doc.querySelectorAll("table tr.trr2").forEach(tr => {
    const cells = tr.querySelectorAll("td");
    if (cells.length < 11) return;

    const getText = (cell) => cell ? cell.textContent.trim().replace(/\s+/g, " ") : "";

    const features = [];
    const featureCell = cells[12];
    if (featureCell) {
      featureCell.textContent.split(";").forEach(f => {
        const t = f.trim();
        if (t) features.push(t);
      });
    }

    rows.push({
      department:          getText(cells[0]),
      courseId:            getText(cells[1]),
      courseSeq:           getText(cells[2]),
      courseName:          getText(cells[3]),
      credits:             parseFloat(getText(cells[4])) || 0,
      teacher:             getText(cells[5]),
      bkCapacity:          parseInt(getText(cells[6])) || 0,
      bkRemaining:         parseInt(getText(cells[7])) || 0,
      yjsCapacity:         parseInt(getText(cells[8])) || 0,
      yjsRemaining:        parseInt(getText(cells[9])) || 0,
      schedule:            getText(cells[10]),
      notes:               getText(cells[11]),
      features:            features,
      grade:               getText(cells[13]),
      isSecondLevel:       getText(cells[14]),
      repeatFillsCapacity: getText(cells[16]),
      hasTimeLimit:        getText(cells[17]),
      generalGroup:        getText(cells[18]),
    });
  });

  return rows;
}
