console.log("Course Helper background loaded (stable refresh version)");

// =======================================================
// 自动刷新状态（唯一可信来源，跨页面、跨 reload）
// =======================================================
let autoRefreshEnabled = false;
let autoRefreshIntervalMs = 500000;
let pluginInitiatedLogin = false;

// =======================================================
// 点击插件图标：直接访问选课入口
// =======================================================
chrome.action.onClicked.addListener(() => {
  console.log("Course Helper: icon clicked");
  pluginInitiatedLogin = true;
  chrome.tabs.create({
    url: "http://zhjwxk.cic.tsinghua.edu.cn/xklogin.do",
  });
});

// =======================================================
// 登录后跳转控制（一次性）
// =======================================================
let pendingRedirectTabId = null;


// =======================================================
// 统一消息入口
// =======================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ---------- 保存登录信息 ----------
  if (msg.type === "saveLoginProfile") {
    chrome.storage.local.set(
      { loginProfile: msg.data },
      () => {
        console.log("Course Helper: login profile saved");
        sendResponse({ ok: true });
      }
    );
    return true;
  }

  // ---------- 读取登录信息 ----------
  if (msg.type === "loadLoginProfile") {
    chrome.storage.local.get(["loginProfile"], (res) => {
      sendResponse({ data: res.loginProfile || null });
    });
    return true;
  }

  // ---------- 登录按钮已触发 ----------
  if (msg.type === "loginTriggered" && sender.tab) {
    if (!pluginInitiatedLogin) {
      console.log(
        "Course Helper: login triggered but NOT initiated by plugin, skip redirect"
      );
      return;
    }

    pendingRedirectTabId = sender.tab.id;
    console.log(
      "Course Helper: plugin-initiated login triggered in tab",
      pendingRedirectTabId
    );
    return;
  }


  // ---------- 开启自动刷新 ----------
  if (msg.type === "START_AUTO_REFRESH") {
    autoRefreshEnabled = true;
    autoRefreshIntervalMs = msg.intervalMs || 3000;

    console.log(
      "Course Helper: auto refresh enabled, interval =",
      autoRefreshIntervalMs
    );

    if (sender.tab && sender.tab.id) {
      chrome.tabs.sendMessage(sender.tab.id, {
        type: "TRIGGER_REFRESH_NOW",
      });
    }

    return;
  }

  // ---------- 关闭自动刷新 ----------
  if (msg.type === "STOP_AUTO_REFRESH") {
    autoRefreshEnabled = false;
    console.log("Course Helper: auto refresh disabled");
    return;
  }

  // ---------- content.js 查询刷新状态 ----------
  if (msg.type === "CHECK_AUTO_REFRESH") {
    sendResponse({
      enabled: autoRefreshEnabled,
      intervalMs: autoRefreshIntervalMs,
    });
    return true;
  }

  if (msg.type === "FETCH_TRAINING_PLAN_HTML") {
    fetchTrainingPlanHTML().then(sendResponse);
    return true;
  }
});

// =======================================================
// 监听页面加载完成，用于登录后跳一次选课入口
// =======================================================
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== pendingRedirectTabId) return;
  if (changeInfo.status !== "complete") return;

  console.log(
    "Course Helper: login completed, redirecting to course system"
  );

  chrome.tabs.update(tabId, {
    url: "http://zhjwxk.cic.tsinghua.edu.cn/xklogin.do",
  });

  pluginInitiatedLogin = false;
  pendingRedirectTabId = null;
});

// =======================================================
// 阶段1：获取【培养方案完成情况】HTML（工程版）
// =======================================================

async function fetchTrainingPlanHTML() {
  console.log("=== Stage1: Fetch Training Plan HTML ===");

  return new Promise((resolve) => {
    // 1. 打开网络学堂登录页（后台 tab）
    chrome.tabs.create(
      {
        url: "https://learn.tsinghua.edu.cn/f/login",
        active: false,
      },
      (learnTab) => {
        const learnTabId = learnTab.id;
        console.log("[TP] learn login tab =", learnTabId);

        // 2. 监听 learn tab 加载
        const onLearnTabUpdated = (tabId, changeInfo) => {
          if (tabId !== learnTabId) return;
          if (changeInfo.status !== "complete") return;

          console.log("[TP] learn tab loaded, check page state");

          // 3. 判断当前页面 URL
          chrome.scripting.executeScript({
            target: { tabId: learnTabId },
            func: () => location.href,
          }).then(([res]) => {
            const url = res.result;
            console.log("[TP] current url =", url);

            // =========================
            // A. 仍在登录页 → 点击登录按钮
            // =========================
            if (url.includes("/f/login")) {
              console.log("[TP] still on login page, click login button");

              chrome.scripting.executeScript({
                target: { tabId: learnTabId },
                func: () => {
                  return new Promise((resolve) => {
                    const start = Date.now();
                    const timer = setInterval(() => {
                      const btn = document.getElementById("loginButtonId");
                      if (btn) {
                        clearInterval(timer);
                        console.log("[TP][Injected] login button clicked");
                        btn.click();
                        resolve(true);
                      }
                      if (Date.now() - start > 10000) {
                        clearInterval(timer);
                        resolve(false);
                      }
                    }, 300);
                  });
                },
              });

              // 等下一次跳转完成，再进这个监听
              return;
            }

            // B. 判断是否真正进入网络学堂主页面
            // =========================
            if (!url.startsWith("https://learn.tsinghua.edu.cn/")) {
              console.log("[TP] still in SSO transition, wait...");
              return;
            }

            // 再进一步确认：页面中是否已出现 tiaozhuan 链接
            chrome.scripting.executeScript({
              target: { tabId: learnTabId },
              func: () => {
                return Array.from(document.querySelectorAll("a")).some((a) => {
                  const onclick = a.getAttribute("onclick");
                  return onclick && onclick.includes("tiaozhuan");
                });
              },
            }).then(([check]) => {
              if (!check.result) {
                console.log("[TP] learn main DOM not ready yet, wait...");
                return;
              }

              // ✅ 只有到这里，才算真正进入网络学堂主页
              console.log("[TP] learn main page ready, start finding training plan");

              chrome.tabs.onUpdated.removeListener(onLearnTabUpdated);

              // 👇👇👇 原来的「找培养方案入口」代码，从这里开始原封不动放下来
              console.log("[TP] entered learn main page, find training plan");

              chrome.tabs.onUpdated.removeListener(onLearnTabUpdated);

              chrome.scripting.executeScript({
                target: { tabId: learnTabId },
                func: () => {
                  return new Promise((resolve) => {
                    const start = Date.now();
                    const timer = setInterval(() => {
                      const links = Array.from(document.querySelectorAll("a"))
                        .filter((a) => {
                          const onclick = a.getAttribute("onclick");
                          return (
                            a.textContent.includes("培养方案完成情况") &&
                            onclick &&
                            onclick.includes("tiaozhuan")
                          );
                        });

                      if (links.length > 0) {
                        clearInterval(timer);
                        const link = links[0];

                        const originalOpen = window.open;
                        window.open = function (url, name, specs) {
                          resolve({ ok: true });
                          return originalOpen.call(window, url, name, specs);
                        };

                        console.log("[TP][Injected] click training plan link");
                        link.click();
                      }

                      if (Date.now() - start > 10000) {
                        clearInterval(timer);
                        resolve({ ok: false });
                      }
                    }, 300);
                  });
                },
              }).then((results) => {
                const r = results[0].result;
                if (!r || !r.ok) {
                  chrome.tabs.remove(learnTabId);
                  resolve({
                    success: false,
                    error: "未找到培养方案完成情况入口",
                  });
                  return;
                }

                console.log("[TP] training plan triggered, wait edu tab");

                // 4. 监听教务系统 tab 打开
                const onEduTabCreated = (tab) => {
                  if (!tab.url) return;
                  if (!tab.url.includes("zhjw.cic.tsinghua.edu.cn")) return;

                  chrome.tabs.onCreated.removeListener(onEduTabCreated);
                  const eduTabId = tab.id;
                  console.log("[TP] edu tab =", eduTabId);

                  // 5. 等教务页面加载完成
                  const onEduTabUpdated = (tid, info) => {
                    if (tid !== eduTabId) return;
                    if (info.status !== "complete") return;

                    chrome.tabs.onUpdated.removeListener(onEduTabUpdated);
                    console.log("[TP] edu page loaded, grab HTML");

                    chrome.scripting.executeScript({
                      target: { tabId: eduTabId },
                      func: () => ({
                        url: location.href,
                        html: document.documentElement.outerHTML,
                      }),
                    }).then((res) => {
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

                  chrome.tabs.onUpdated.addListener(onEduTabUpdated);
                };

                chrome.tabs.onCreated.addListener(onEduTabCreated);
              });
            });

            
          });
        };

        chrome.tabs.onUpdated.addListener(onLearnTabUpdated);
      }
    );
  });
}
