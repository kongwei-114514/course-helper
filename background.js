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
