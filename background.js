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
// 点击插件图标：打开主界面 + 登录选课系统
// =======================================================
chrome.action.onClicked.addListener(async () => {
  console.log("Course Helper: icon clicked");
  
  // 1. 打开主界面
  chrome.tabs.create({
    url: chrome.runtime.getURL("dashboard.html")
  });
  
  // 2. 登录选课系统
  pluginInitiatedLogin = true;
  chrome.tabs.create({
    url: "http://zhjwxk.cic.tsinghua.edu.cn/xklogin.do",
  });
});

// =======================================================
// 登录后跳转控制
// =======================================================
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== pendingRedirectTabId) return;
  if (changeInfo.status !== "complete") return;

  console.log("Course Helper: login completed, redirecting to course system");

  chrome.tabs.update(tabId, {
    url: "http://zhjwxk.cic.tsinghua.edu.cn/xklogin.do",
  });

  pluginInitiatedLogin = false;
  pendingRedirectTabId = null;
});

// =======================================================
// 统一消息处理中心
// =======================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ---------- 保存登录信息 ----------
  if (msg.type === "saveLoginProfile") {
    chrome.storage.local.set({ loginProfile: msg.data }, () => {
      console.log("Course Helper: login profile saved");
      sendResponse({ ok: true });
    });
    return true;
  }

  // ---------- 读取登录信息 ----------
  if (msg.type === "loadLoginProfile") {
    chrome.storage.local.get(["loginProfile"], (res) => {
      sendResponse({ data: res.loginProfile || null });
    });
    return true;
  }

  // ---------- 登录触发 ----------
  if (msg.type === "loginTriggered" && sender.tab) {
    if (!pluginInitiatedLogin) {
      console.log("Course Helper: login triggered but NOT initiated by plugin");
      return;
    }
    pendingRedirectTabId = sender.tab.id;
    console.log("Course Helper: plugin-initiated login triggered");
    return;
  }

  // ---------- 自动刷新控制 ----------
  if (msg.type === "START_AUTO_REFRESH") {
    autoRefreshEnabled = true;
    autoRefreshIntervalMs = msg.intervalMs || 3000;
    console.log("Course Helper: auto refresh enabled, interval =", autoRefreshIntervalMs);
    if (sender.tab && sender.tab.id) {
      chrome.tabs.sendMessage(sender.tab.id, { type: "TRIGGER_REFRESH_NOW" });
    }
    return;
  }

  if (msg.type === "STOP_AUTO_REFRESH") {
    autoRefreshEnabled = false;
    console.log("Course Helper: auto refresh disabled");
    return;
  }

  if (msg.type === "CHECK_AUTO_REFRESH") {
    sendResponse({
      enabled: autoRefreshEnabled,
      intervalMs: autoRefreshIntervalMs,
    });
    return true;
  }

  // ---------- 获取培养方案 HTML ----------
  if (msg.type === "FETCH_TRAINING_PLAN_HTML") {
    fetchTrainingPlanHTML().then(sendResponse);
    return true;
  }

  // ---------- 保存/读取培养方案数据 ----------
  if (msg.type === "SAVE_TRAINING_PLAN") {
    chrome.storage.local.set({ trainingPlanData: msg.data }, () => {
      console.log("Training plan data saved");
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === "LOAD_TRAINING_PLAN") {
    chrome.storage.local.get(["trainingPlanData"], (res) => {
      sendResponse({ data: res.trainingPlanData || null });
    });
    return true;
  }

  // ---------- 保存/读取选课社区数据 ----------
  if (msg.type === "SAVE_COURSE_REVIEWS") {
    chrome.storage.local.set({ courseReviewsData: msg.data }, () => {
      console.log("Course reviews data saved");
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === "LOAD_COURSE_REVIEWS") {
    chrome.storage.local.get(["courseReviewsData"], (res) => {
      sendResponse({ data: res.courseReviewsData || null });
    });
    return true;
  }

  // ---------- 增量更新选课社区数据 ----------
  if (msg.type === "UPDATE_COURSE_REVIEWS") {
    chrome.storage.local.get(["courseReviewsData"], (res) => {
      const existing = res.courseReviewsData || { courses: [], lastUpdate: 0, totalCount: 0 };
      const newData = msg.data;
      
      // 合并数据
      const courseMap = new Map();
      existing.courses.forEach(c => courseMap.set(c.course_id, c));
      
      newData.courses.forEach(c => {
        if (courseMap.has(c.course_id)) {
          // 更新现有课程
          const old = courseMap.get(c.course_id);
          courseMap.set(c.course_id, {
            ...old,
            rating: c.rating,
            comments: [...old.comments, ...c.comments],
            comment_sum: old.comment_sum + c.comment_sum
          });
        } else {
          // 新增课程
          courseMap.set(c.course_id, c);
        }
      });
      
      const merged = {
        courses: Array.from(courseMap.values()),
        lastUpdate: Date.now(),
        totalCount: newData.totalCount || existing.totalCount
      };
      
      chrome.storage.local.set({ courseReviewsData: merged }, () => {
        console.log("Course reviews updated, total courses:", merged.courses.length);
        sendResponse({ success: true, data: merged });
      });
    });
    return true;
  }
});

// =======================================================
// 获取培养方案 HTML（自动关闭临时标签页）
// =======================================================
async function fetchTrainingPlanHTML() {
  console.log("=== Fetch Training Plan HTML ===");
  console.log("[TP] fetchTrainingPlanHTML called");

  return new Promise((resolve) => {
    // 1. 打开网络学堂登录页
    chrome.tabs.create({ url: "https://learn.tsinghua.edu.cn/f/login", active: false }, (learnTab) => {
      const learnTabId = learnTab.id;
      console.log("[TP] learn tab created:", learnTabId);

      const onLearnTabUpdated = (tabId, changeInfo) => {
        if (tabId !== learnTabId || changeInfo.status !== "complete") return;

        chrome.scripting.executeScript({
          target: { tabId: learnTabId },
          func: () => location.href,
        }).then(([res]) => {
          const url = res.result;
          console.log("[TP] current url:", url);

          // 在登录页面，点击登录按钮
          if (url.includes("/f/login")) {
            chrome.scripting.executeScript({
              target: { tabId: learnTabId },
              func: () => {
                return new Promise((resolve) => {
                  const timer = setInterval(() => {
                    const btn = document.getElementById("loginButtonId");
                    if (btn) {
                      clearInterval(timer);
                      btn.click();
                      resolve(true);
                    }
                  }, 300);
                  setTimeout(() => { clearInterval(timer); resolve(false); }, 10000);
                });
              },
            });
            return;
          }

          // 检查是否进入网络学堂主页
          if (!url.startsWith("https://learn.tsinghua.edu.cn/")) return;

          chrome.scripting.executeScript({
            target: { tabId: learnTabId },
            func: () => Array.from(document.querySelectorAll("a")).some(a => 
              a.getAttribute("onclick")?.includes("tiaozhuan")
            ),
          }).then(([check]) => {
            if (!check.result) return;

            console.log("[TP] learn main page ready");
            chrome.tabs.onUpdated.removeListener(onLearnTabUpdated);

            console.log("[TP] about to setup edu tab listener and click link");

            // 查找并点击培养方案入口
            chrome.scripting.executeScript({
              target: { tabId: learnTabId },
              func: () => {
                return new Promise((resolve) => {
                  const timer = setInterval(() => {
                    const links = Array.from(document.querySelectorAll("a")).filter(a =>
                      a.textContent.includes("培养方案完成情况") &&
                      a.getAttribute("onclick")?.includes("tiaozhuan")
                    );

                    if (links.length > 0) {
                      clearInterval(timer);
                      links[0].click();
                      resolve({ ok: true });
                    }
                  }, 300);
                  setTimeout(() => { clearInterval(timer); resolve({ ok: false }); }, 10000);
                });
              },
           }).then((results) => {
              if (!results[0].result?.ok) {
                chrome.tabs.remove(learnTabId);
                resolve({ success: false, error: "未找到培养方案入口" });
                return;
              }

              console.log("[TP] training plan link clicked, setting up tab listener");

              let eduTabId = null;
              let eduTabCaptured = false;
              console.log("[TP] registering onCreated listener");
              const onEduTabCreated = (tab) => {
                console.log("[TP] tab created:", tab.id, tab.url);

                // 不在 created 阶段判断 URL
                const candidateTabId = tab.id;

                const onEduTabUpdated = (tid, info, updatedTab) => {
                  if (!updatedTab.url?.includes("jhBks.by_fascjgmxb_gr.do")) {
                    return;
                  }

                  // 🚫 如果已经抓到一个了，直接关掉多余的
                  if (eduTabCaptured) {
                    console.log("[TP] extra edu tab detected, closing:", candidateTabId);
                    chrome.tabs.remove(candidateTabId);
                    return;
                  }

                  // ✅ 第一个命中的才算数
                  eduTabCaptured = true;

                  console.log("[TP] edu tab confirmed:", candidateTabId);


                  if (!updatedTab.url?.includes("jhBks.by_fascjgmxb_gr.do")) {
                    return; // 不是我们要的页面，继续等
                  }

                  // ✅ 找到了真正的教务页面
                  console.log("[TP] edu tab confirmed:", candidateTabId);

                  chrome.tabs.onUpdated.removeListener(onEduTabUpdated);
                  chrome.tabs.onCreated.removeListener(onEduTabCreated);

                  eduTabId = candidateTabId;

                  console.log("[TP] edu page loaded, extracting HTML");

                  chrome.scripting.executeScript({
                    target: { tabId: eduTabId },
                    func: () => ({
                      url: location.href,
                      html: document.documentElement.outerHTML,
                    }),
                  }).then((res) => {
                    const data = res[0].result;

                    // 关闭临时标签页
                    console.log("[TP] closing tabs", learnTabId, eduTabId);
                    chrome.tabs.remove(learnTabId);
                    chrome.tabs.remove(eduTabId);

                    resolve({
                      success: true,
                      url: data.url,
                      html: data.html,
                    });
                  });
                };

                chrome.tabs.onUpdated.addListener(onEduTabUpdated);
              };


              // ✅ 先监听
              chrome.tabs.onCreated.addListener(onEduTabCreated);

              // ✅ 再点击（重新触发一次）
              chrome.scripting.executeScript({
                target: { tabId: learnTabId },
                func: () => {
                  const links = Array.from(document.querySelectorAll("a")).filter(a =>
                    a.textContent.includes("培养方案完成情况") &&
                    a.getAttribute("onclick")?.includes("tiaozhuan")
                  );
                  if (links.length > 0) links[0].click();
                }
              });
            });

          });
        });
      };

      chrome.tabs.onUpdated.addListener(onLearnTabUpdated);
    });
  });
}