console.log("Course Helper background loaded (stable refresh version)");

// =======================================================
// 自动刷新状态（唯一可信来源，跨页面、跨 reload）
// =======================================================
let autoRefreshEnabled = true;
let autoRefreshIntervalMs = 10000;

// =======================================================
// 点击插件图标：直接访问选课入口（你已验证可用）
// =======================================================
chrome.action.onClicked.addListener(() => {
  console.log("Course Helper: icon clicked");

  chrome.tabs.create({
    url: "http://zhjwxk.cic.tsinghua.edu.cn/xklogin.do",
  });
});

// =======================================================
// 登录后跳转控制（一次性）
// =======================================================
let pendingRedirectTabId = null;

// =======================================================
// 统一消息入口（非常重要：只保留这一个）
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
    pendingRedirectTabId = sender.tab.id;
    console.log(
      "Course Helper: login triggered in tab",
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

    // 立刻让当前 tab 进入刷新循环
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

  // 只跳一次
  pendingRedirectTabId = null;
});
