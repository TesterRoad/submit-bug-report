// background.js - Bug Report Generator

// ===== 暂存数据 =====
var pendingResponses = {};   // requestId -> { status, url, mimeType, headers }
var responseDataChunks = {};  // requestId -> { chunks: [], totalSize }
var attachedTabs = new Set();
var captureStates = {};       // tabId -> starting | ready | stopping
var captureGenerations = {};
var captureGenerationCounter = 0;
var pendingStartResponses = {}; // tabId -> sendResponse callbacks
var requestMeta = {};        // requestId -> { resourceType, method, url }
var requestStartTimes = {};  // requestId -> 单调时钟（秒）
var trackedRequests = new Set();
var logQueue = [];
var isSavingLogs = false;
var logRetryTimer = null;
var logStorageBlocked = false;
var logStorageHasLoss = false;
var logStorageStateGeneration = 0;
var logStorageStateQueue = [];
var logStorageStateBusy = false;
var logWriteGeneration = 0;
var logClearPending = false;
var logClearInProgress = false;
var logClearRetryCount = 0;
var logClearResponses = [];
var MAX_LOG_QUEUE_LENGTH = 500;
var MAX_LOG_QUEUE_BYTES = 5 * 1024 * 1024;
var MAX_LOG_WRITE_RETRIES = 5;
var logQueueBytes = 0;

var recordingStats = { steps: 0, logs: 0, screenshots: 0 };

chrome.storage.local.get(["recordingStats"], function (result) {
  if (result && result.recordingStats) {
    recordingStats = {
      steps: Number(result.recordingStats.steps) || 0,
      logs: Number(result.recordingStats.logs) || 0,
      screenshots: Number(result.recordingStats.screenshots) || 0
    };
  }
});

function bumpRecordingStats(key, delta) {
  recordingStats[key] = Math.max(0, (Number(recordingStats[key]) || 0) + (delta == null ? 1 : delta));
  chrome.storage.local.set({ recordingStats: recordingStats });
}

function resetRecordingStats() {
  recordingStats = { steps: 0, logs: 0, screenshots: 0 };
  chrome.storage.local.set({ recordingStats: recordingStats });
}

var BUSINESS_RESOURCE_TYPES = {
  xhr: true,
  fetch: true
};

function normalizeResourceType(value) {
  return String(value || "").toLowerCase();
}

function shouldTrackRequest(req, resourceType) {
  if (!req || !req.url) return false;

  var url = req.url;
  if (url.indexOf("chrome-extension://") === 0 ||
      url.indexOf("data:") === 0 ||
      url.indexOf("blob:") === 0 ||
      url.indexOf("about:") === 0 ||
      url.indexOf("chrome://") === 0) {
    return false;
  }

  if ((req.method || "").toUpperCase() === "OPTIONS") return false;

  return !!BUSINESS_RESOURCE_TYPES[normalizeResourceType(resourceType)];
}

function rememberRequest(requestId, req, resourceType) {
  requestMeta[requestId] = {
    resourceType: normalizeResourceType(resourceType),
    method: req.method || "",
    url: req.url || ""
  };
  trackedRequests.add(requestId);
}

function respondToPendingStarts(tabId, response) {
  var callbacks = pendingStartResponses[tabId] || [];
  delete pendingStartResponses[tabId];
  callbacks.forEach(function(callback) {
    try { callback(response); } catch (e) {}
  });
}

function clearCaptureState(tabId, response, generation) {
  if (generation !== undefined && captureGenerations[tabId] !== generation) return;
  attachedTabs.delete(tabId);
  delete captureStates[tabId];
  delete captureGenerations[tabId];
  if (response) respondToPendingStarts(tabId, response);
}

function detachCapture(tabId, response, generation) {
  if (!attachedTabs.has(tabId)) {
    clearCaptureState(tabId, response, generation);
    return;
  }

  attachedTabs.delete(tabId);
  chrome.debugger.detach({ tabId: tabId }, function() {
    if (chrome.runtime.lastError) {
      console.warn("[BugReport] Debugger detach 失败:", chrome.runtime.lastError.message);
    }
    clearCaptureState(tabId, response, generation);
  });
}

function stopCapture(tabId) {
  var state = captureStates[tabId];
  if (state === "stopping") return;
  var generation = captureGenerations[tabId];
  captureStates[tabId] = "stopping";
  if (attachedTabs.has(tabId)) {
    detachCapture(tabId, { success: false, error: "接口采集已停止" }, generation);
  } else if (state !== "starting") {
    clearCaptureState(tabId, { success: false, error: "接口采集已停止" }, generation);
  }
}

function stopAllCaptures() {
  var tabIds = new Set(attachedTabs);
  Object.keys(captureStates).forEach(function(tabId) {
    tabIds.add(Number(tabId));
  });
  tabIds.forEach(stopCapture);
}

// ===== 一次性迁移：清除已移除的“提交缺陷”功能残留的数据（含平台 Token）=====
chrome.storage.local.remove(["platformConfig", "autoSubmitRequested"]);

console.log("[BugReport] Background script 已加载");

// ===== Side Panel 初始化 =====
try {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(function(err) {
      console.warn("[BugReport] SidePanel setPanelBehavior 失败:", err && err.message);
    });
  } else {
    console.log("[BugReport] chrome.sidePanel 不可用");
  }
} catch (e) {
  console.warn("[BugReport] SidePanel 初始化异常:", e && e.message);
}

// ===== 消息处理 =====

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  console.log("[BugReport] 收到消息:", request.action);

  if (request.action === "captureTab") {
    captureVisibleTabCompressed(sendResponse);
    return true;

  } else if (request.action === "startLogCapture") {
    startLogCaptureForTab(request.tabId).then(function (response) {
      sendResponse(response);
    });
    return true;

  } else if (request.action === "stopLogCapture") {
    stopAllCaptures();
  } else if (request.action === "toggleRecording") {
    toggleRecording().then(sendResponse);
    return true;
  } else if (request.action === "stopRecordingRequest") {
    stopRecording().then(sendResponse);
    return true;
  } else if (request.action === "setRecordingPaused") {
    setRecordingPaused(!!request.paused).then(sendResponse);
    return true;
  } else if (request.action === "openSidePanel") {
    var panelTabId = request.tabId != null
      ? request.tabId
      : (sender && sender.tab ? sender.tab.id : null);
    openSidePanelForTab(panelTabId).then(sendResponse);
    return true;
  } else if (request.action === "recordedStep") {
    bumpRecordingStats("steps", 1);
    sendResponse({ ok: true });
  } else if (request.action === "setStepCount") {
    recordingStats.steps = Math.max(0, Number(request.steps) || 0);
    chrome.storage.local.set({ recordingStats: recordingStats });
    sendResponse({ ok: true });
  } else if (request.action === "clearLogStorageLoss") {
    clearQueuedLogs(sendResponse);
    logStorageHasLoss = false;
    logStorageBlocked = false;
    enqueueLogStorageStateOperation({ type: "remove", generation: logStorageStateGeneration });
    return true;
  }
});

// ===== 接口采集：启动（消息与快捷键共用）=====

function startLogCaptureForTab(tabId) {
  return new Promise(function (resolve) {
    var state = captureStates[tabId];
    if (state === "ready") {
      resolve({ success: true });
      return;
    }
    if (state === "starting") {
      pendingStartResponses[tabId] = pendingStartResponses[tabId] || [];
      pendingStartResponses[tabId].push(resolve);
      return;
    }
    if (state === "stopping") {
      resolve({ success: false, error: "接口采集正在停止，请稍后重试" });
      return;
    }

    var generation = ++captureGenerationCounter;
    captureGenerations[tabId] = generation;
    captureStates[tabId] = "starting";
    pendingStartResponses[tabId] = [resolve];
    chrome.debugger.attach({ tabId: tabId }, "1.3", function () {
      if (captureGenerations[tabId] !== generation) return;
      if (chrome.runtime.lastError) {
        var error = chrome.runtime.lastError.message;
        console.error("[BugReport] Debugger attach 失败:", error);
        clearCaptureState(tabId, { success: false, error: error }, generation);
        return;
      }

      attachedTabs.add(tabId);
      console.log("[BugReport] Debugger 已附加到 tab:", tabId);
      if (captureStates[tabId] !== "starting") {
        detachCapture(tabId, { success: false, error: "接口采集已在启动过程中停止" }, generation);
        return;
      }

      chrome.debugger.sendCommand({ tabId: tabId }, "Network.enable", null, function () {
        if (captureGenerations[tabId] !== generation) return;
        if (captureStates[tabId] !== "starting") return;
        if (chrome.runtime.lastError) {
          var enableError = chrome.runtime.lastError.message;
          console.error("[BugReport] Network.enable 失败:", enableError);
          captureStates[tabId] = "stopping";
          detachCapture(tabId, { success: false, error: enableError }, generation);
          return;
        }

        captureStates[tabId] = "ready";
        console.log("[BugReport] Network 已启用, 开始监听请求");
        respondToPendingStarts(tabId, { success: true });
      });
    });
  });
}

// ===== 录制控制（面板 / 快捷键 / 悬浮条共用）=====

function isRecordableUrl(url) {
  return /^https?:\/\//i.test(url || "");
}

function getActiveTab() {
  return chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(function (tabs) {
    return tabs && tabs[0] ? tabs[0] : null;
  });
}

function startRecording() {
  return getActiveTab().then(function (tab) {
    if (!tab) return Promise.resolve({ isRecording: false, error: "未找到活动标签页" });
    if (!isRecordableUrl(tab.url)) {
      return Promise.resolve({ isRecording: false, error: "当前页面不支持录制，请切换到普通网页" });
    }
    return new Promise(function (resolve) {
      chrome.storage.local.set({
        isRecording: true,
        recordingPaused: false,
        captureTabId: tab.id
      }, function () {
        resetRecordingStats();
        chrome.tabs.sendMessage(tab.id, { action: "startRecording" }).catch(function () {});
        startLogCaptureForTab(tab.id).then(function (response) {
          resolve({
            isRecording: true,
            tabId: tab.id,
            captureError: response && response.success ? "" : ((response && response.error) || "后台未能确认网络监听状态")
          });
        });
      });
    });
  });
}

function stopRecording() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(["captureTabId"], function (result) {
      var tabId = result.captureTabId;
      chrome.storage.local.set({ isRecording: false, recordingPaused: false, captureTabId: null }, function () {
        if (tabId != null) {
          chrome.tabs.sendMessage(tabId, { action: "stopRecording" }).catch(function () {});
        }
        stopAllCaptures();
        resolve({ isRecording: false });
      });
    });
  });
}

function toggleRecording() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(["isRecording"], function (result) {
      resolve(result.isRecording ? stopRecording() : startRecording());
    });
  });
}

function setRecordingPaused(paused) {
  return new Promise(function (resolve) {
    chrome.storage.local.get(["isRecording", "captureTabId"], function (result) {
      if (!result.isRecording) {
        resolve({ success: false, error: "当前未在录制" });
        return;
      }
      chrome.storage.local.set({ recordingPaused: paused }, function () {
        if (paused) {
          stopAllCaptures();
          resolve({ success: true, paused: true });
          return;
        }
        var tabId = result.captureTabId;
        if (tabId == null) {
          resolve({ success: false, error: "未找到录制标签页" });
          return;
        }
        startLogCaptureForTab(tabId).then(function (response) {
          resolve({
            success: !!(response && response.success),
            paused: false,
            error: response && response.success ? "" : ((response && response.error) || "")
          });
        });
      });
    });
  });
}

function openSidePanelForTab(tabId) {
  return new Promise(function (resolve) {
    if (!chrome.sidePanel || !chrome.sidePanel.open) {
      openPanelInTab(resolve);
      return;
    }
    var options = tabId == null ? {} : { tabId: tabId };
    try {
      var opening = chrome.sidePanel.open(options);
      if (opening && opening.then) {
        opening.then(function () { resolve({ success: true }); }).catch(function () {
          openPanelInTab(resolve);
        });
      } else {
        resolve({ success: true });
      }
    } catch (e) {
      openPanelInTab(resolve);
    }
  });
}

// 侧边栏需要用户手势；从网页点击进来时打不开就退化成标签页，保证点击有反馈
function openPanelInTab(resolve) {
  try {
    chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel.html") }, function () {
      resolve({ success: !chrome.runtime.lastError, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : "" });
    });
  } catch (e) {
    resolve({ success: false, error: e && e.message ? e.message : "无法打开扩展面板" });
  }
}

// ===== 快捷键 =====

chrome.commands.onCommand.addListener(function (command) {
  if (command === "toggle-recording") {
    toggleRecording().then(function (response) {
      if (response && response.error) flashActionBadge("!");
    });
  } else if (command === "capture-screenshot") {
    captureVisibleTabCompressed(function (response) {
      if (!response || !response.success) flashActionBadge("!");
    });
  } else if (command === "open-panel") {
    getActiveTab().then(function (tab) {
      openSidePanelForTab(tab ? tab.id : null).then(function (response) {
        if (!response || !response.success) flashActionBadge("!");
      });
    });
  }
});

function flashActionBadge(text) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
    chrome.action.setBadgeText({ text: text || "!" });
    setTimeout(function () { chrome.action.setBadgeText({ text: "" }); }, 2000);
  } catch (e) {}
}

chrome.debugger.onDetach.addListener(function(source, reason) {
  if (!source || source.tabId === undefined) return;
  var tabId = source.tabId;
  var previousState = captureStates[tabId];
  var generation = captureGenerations[tabId];
  var wasReady = previousState === "ready";
  if (!previousState || previousState === "stopping") return;
  if (previousState === "starting" && !attachedTabs.has(tabId)) return;

  var error = "浏览器已断开接口采集" + (reason ? "：" + reason : "");
  chrome.debugger.sendCommand({ tabId: tabId }, "Network.enable", null, function() {
    if (captureGenerations[tabId] !== generation || captureStates[tabId] === "stopping") return;
    if (!chrome.runtime.lastError) return;

    clearCaptureState(tabId, { success: false, error: error }, generation);
    if (wasReady) {
      chrome.runtime.sendMessage({ action: "debuggerDetached", tabId: tabId, error: error }).catch(function() {});
    }
  });
});

// ===== Debugger 事件处理 =====

chrome.debugger.onEvent.addListener(function(source, method, params) {
  if (!source || !params || !method) return;

  // --- 1. 请求发出：记录 cURL ---
  if (method === "Network.requestWillBeSent") {
    var req = params.request;
    if (!req || !req.url) return;
    var resourceType = normalizeResourceType(params.type);
    if (!shouldTrackRequest(req, resourceType)) return;

    rememberRequest(params.requestId, req, resourceType);
    requestStartTimes[params.requestId] = params.timestamp;

    var curl = generateCurl(req);
    var log = {
      type: "network",
      requestId: params.requestId,
      method: req.method,
      url: req.url,
      resourceType: resourceType,
      postData: req.postData || "",
      curl: curl,
      timestamp: new Date().toISOString()
    };

    console.log("[BugReport] [REQUEST]", req.method, req.url.substring(0, 80));
    saveLog(log);

    // 初始化此请求的数据收集
    responseDataChunks[params.requestId] = { chunks: [], encoded: false };
  }

  // --- 2. 收到响应头：暂存到内存 ---
  else if (method === "Network.responseReceived") {
    var resp = params.response;
    if (!resp || !resp.url) return;
    if (!trackedRequests.has(params.requestId)) return;

    pendingResponses[params.requestId] = {
      status: resp.status,
      statusText: resp.statusText || "",
      url: resp.url,
      mimeType: resp.mimeType || "",
      headers: resp.headers || {},
      resourceType: (requestMeta[params.requestId] && requestMeta[params.requestId].resourceType) || ""
    };
    console.log("[BugReport] [RESP HEAD]", resp.status, resp.url.substring(0, 80));

    // 尝试立即获取 body（某些情况下此时就能拿到）
    // 这不作为主要手段，只是提前尝试
  }

  // --- 3. 收集响应数据片段（兜底方案）---
  else if (method === "Network.dataReceived") {
    var reqId = params.requestId;
    if (!responseDataChunks[reqId]) {
      responseDataChunks[reqId] = { chunks: [], encoded: false };
    }

    // 记录是否是 base64 编码
    if (params.base64Encoded) {
      responseDataChunks[reqId].encoded = true;
    }

    // 存储数据片段
    if (params.data && params.data.length > 0) {
      responseDataChunks[reqId].chunks.push(params.data);
    }
  }

  // --- 4. 响应体传输完毕：获取完整 body ---
  else if (method === "Network.loadingFinished") {
    var requestId = params.requestId;
    var tabId = source.tabId;

    if (!attachedTabs.has(tabId) || !trackedRequests.has(requestId)) {
      cleanupRequestData(requestId);
      return;
    }

    // 先尝试用 getResponseBody 获取完整 body
    chrome.debugger.sendCommand(
      { tabId: tabId },
      "Network.getResponseBody",
      { requestId: requestId },
      function(response) {
        var body = "";
        var headerInfo = pendingResponses[requestId] || {};

        if (chrome.runtime.lastError) {
          console.warn("[BugReport] getResponseBody 失败:", chrome.runtime.lastError.message);
          // fallback: 使用 dataReceived 收集到的数据
          body = assembleChunks(requestId);
          console.log("[BugReport] fallback 用 dataReceived 拼接, 长度:", body.length);
        } else if (response && response.body !== undefined && response.body !== "") {
          body = response.body;
          if (response.base64Encoded) {
            body = "[Base64 数据, 长度:" + body.length + "]";
          } else {
            try {
              var json = JSON.parse(body);
              body = JSON.stringify(json, null, 2);
            } catch (e) {
              // 非 JSON 文本
            }
          }
          console.log("[BugReport] getResponseBody 成功, 长度:", body.length);
        } else {
          // getResponseBody 返回了空，用 dataReceived 兜底
          body = assembleChunks(requestId);
          console.log("[BugReport] getResponseBody 为空, fallback dataReceived, 长度:", body.length);
        }

        var startedAt = requestStartTimes[requestId];
        var log = {
          type: "response",
          requestId: requestId,
          status: headerInfo.status || 0,
          statusText: headerInfo.statusText || "",
          url: headerInfo.url || "",
          mimeType: headerInfo.mimeType || "",
          resourceType: headerInfo.resourceType || (requestMeta[requestId] && requestMeta[requestId].resourceType) || "",
          durationMs: (startedAt != null && params.timestamp != null)
            ? Math.max(0, Math.round((params.timestamp - startedAt) * 1000))
            : null,
          body: body,
          timestamp: new Date().toISOString()
        };

        cleanupRequestData(requestId);
        console.log("[BugReport] [RESP BODY]", log.status, "body长度=" + body.length, log.url.substring(0, 60));
        saveLog(log);

        // 自动截图检查
        checkAutoCapture(tabId, requestId, headerInfo, body);
      }
    );
  }

  // --- 5. 请求失败 ---
  else if (method === "Network.loadingFailed") {
    var requestId = params.requestId;
    var headerInfo = pendingResponses[requestId];

    if (!trackedRequests.has(requestId)) {
      cleanupRequestData(requestId);
      return;
    }

    if (headerInfo) {
      var log = {
        type: "response",
        requestId: requestId,
        status: headerInfo.status || 0,
        statusText: headerInfo.statusText || "",
        url: headerInfo.url || "",
        mimeType: headerInfo.mimeType || "",
        resourceType: headerInfo.resourceType || (requestMeta[requestId] && requestMeta[requestId].resourceType) || "",
        body: "(请求失败: " + (params.errorText || "unknown") + ")",
        timestamp: new Date().toISOString()
      };

      cleanupRequestData(requestId);
      saveLog(log);
      console.log("[BugReport] [FAILED]", log.status, params.errorText, log.url);
    } else {
      cleanupRequestData(requestId);
    }
  }
});

// ===== 辅助函数：清理请求数据 =====

function cleanupRequestData(requestId) {
  delete pendingResponses[requestId];
  delete responseDataChunks[requestId];
  delete requestMeta[requestId];
  delete requestStartTimes[requestId];
  trackedRequests.delete(requestId);
}

// ===== 辅助函数：拼接 dataReceived 收集的数据片段 =====

function assembleChunks(requestId) {
  var chunkData = responseDataChunks[requestId];
  if (!chunkData || !chunkData.chunks || chunkData.chunks.length === 0) {
    return "(响应体为空)";
  }

  if (chunkData.encoded) {
    return "[二进制数据, 共收集 " + chunkData.chunks.length + " 个片段]";
  }

  try {
    // 尝试将各段解码为文本并合并
    var combined = "";
    for (var i = 0; i < chunkData.chunks.length; i++) {
      combined += chunkData.chunks[i];
    }

    // 如果看起来像 JSON，格式化它
    try {
      var json = JSON.parse(combined);
      combined = JSON.stringify(json, null, 2);
    } catch (e) {}

    return combined;
  } catch (e) {
    return "[数据拼接失败, 共 " + chunkData.chunks.length + " 个片段]";
  }
}

// ===== 生成 cURL 命令 =====

function generateCurl(request) {
  var parts = [];
  parts.push("curl");
  parts.push("'" + request.url + "'");
  parts.push("-X " + request.method);

  // 跳过浏览器自动管理的无意义头
  if (request.headers) {
    var skipHeaders = ["host", "connection", "content-length", "accept-encoding",
                       ":authority", ":scheme", ":method", ":path"];
    var keys = Object.keys(request.headers);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (skipHeaders.indexOf(key.toLowerCase()) !== -1) continue;
      var value = request.headers[key];
      parts.push("-H '" + key + ": " + value.replace(/'/g, "'\\''") + "'");
    }
  }

  if (request.postData) {
    parts.push("--data-raw '" + request.postData.replace(/'/g, "'\\''") + "'");
  }

  return parts.join(" \\\n  ");
}

// ===== 保存日志 =====

function saveLog(log) {
  var sizeBytes;
  try {
    sizeBytes = JSON.stringify(log).length * 2;
  } catch (e) {
    reportLogStorageError("接口日志无法序列化，未能保存", true);
    return;
  }
  var pendingCount = logQueue.length + (isSavingLogs ? 1 : 0);
  if (pendingCount >= MAX_LOG_QUEUE_LENGTH || sizeBytes > MAX_LOG_QUEUE_BYTES - logQueueBytes) {
    reportLogStorageError("日志缓存已满，最新一条接口日志未能排队", true);
    return;
  }
  logQueueBytes += sizeBytes;
  logQueue.push({ log: log, retries: 0, sizeBytes: sizeBytes });
  writeNextLog();
}

function reportLogStorageError(error, permanent) {
  logStorageBlocked = true;
  var stateGeneration = logStorageStateGeneration;
  if (permanent) {
    logStorageHasLoss = true;
    enqueueLogStorageStateOperation({ type: "set", generation: stateGeneration, error: error });
    return;
  }
  chrome.runtime.sendMessage({ action: "logStorageError", error: error, permanent: false }).catch(function() {});
}

function enqueueLogStorageStateOperation(operation) {
  logStorageStateQueue.push(operation);
  processLogStorageStateQueue();
}

function processLogStorageStateQueue() {
  if (logStorageStateBusy || logStorageStateQueue.length === 0) return;
  var operation = logStorageStateQueue.shift();
  if (operation.type === "set" && operation.generation !== logStorageStateGeneration) {
    processLogStorageStateQueue();
    return;
  }

  logStorageStateBusy = true;
  var stateStorage = chrome.storage.session || chrome.storage.local;
  var complete = function() {
    var storageError = chrome.runtime.lastError;
    logStorageStateBusy = false;
    if (operation.type === "set" && operation.generation === logStorageStateGeneration) {
      chrome.runtime.sendMessage({
        action: "logStorageError",
        error: operation.error,
        permanent: true,
        persistenceError: storageError ? storageError.message : ""
      }).catch(function() {});
    }
    processLogStorageStateQueue();
  };

  if (operation.type === "set") {
    var value = { logStorageLoss: operation.error };
    stateStorage.set(value, complete);
  } else {
    stateStorage.remove(["logStorageLoss"], complete);
  }
}

function clearQueuedLogs(sendResponse) {
  if (sendResponse) logClearResponses.push(sendResponse);
  logStorageStateGeneration++;
  logWriteGeneration++;
  logQueue = [];
  logQueueBytes = 0;
  if (logRetryTimer) {
    clearTimeout(logRetryTimer);
    logRetryTimer = null;
  }
  logClearPending = true;
  logClearRetryCount = 0;
  if (!isSavingLogs) finishLogClear();
}

function finishLogClear() {
  if (logClearInProgress || !logClearPending || isSavingLogs) return;
  logClearInProgress = true;
  chrome.storage.local.set({ logs: [] }, function() {
    if (chrome.runtime.lastError) {
      var error = chrome.runtime.lastError.message;
      logClearInProgress = false;
      reportLogStorageError("清空接口日志失败：" + error, logClearRetryCount >= MAX_LOG_WRITE_RETRIES);
      if (logClearRetryCount >= MAX_LOG_WRITE_RETRIES) {
        respondToLogClear({ success: false, error: error });
        return;
      }
      var delay = Math.min(1000 * Math.pow(2, logClearRetryCount), 16000);
      logClearRetryCount++;
      logRetryTimer = setTimeout(function() {
        logRetryTimer = null;
        finishLogClear();
      }, delay);
      return;
    }
    logClearInProgress = false;
    logClearPending = false;
    logClearRetryCount = 0;
    respondToLogClear({ success: true });
    if (logStorageBlocked && !logStorageHasLoss) {
      logStorageBlocked = false;
      chrome.runtime.sendMessage({ action: "logStorageRecovered" }).catch(function() {});
    }
    writeNextLog();
  });
}

function respondToLogClear(response) {
  var callbacks = logClearResponses.splice(0);
  callbacks.forEach(function(callback) {
    try { callback(response); } catch (e) {}
  });
}

function notifyLogStorageRecovered() {
  var stateStorage = chrome.storage.session || chrome.storage.local;
  stateStorage.get(["logStorageLoss"], function(result) {
    if (chrome.runtime.lastError) return;
    if (logStorageHasLoss || (result && result.logStorageLoss)) {
      logStorageHasLoss = true;
      return;
    }
    chrome.runtime.sendMessage({ action: "logStorageRecovered" }).catch(function() {});
  });
}

function retryLogWrite(entry, error) {
  isSavingLogs = false;
  logStorageBlocked = true;
  console.error("[BugReport] 日志暂存失败，将重试:", error);
  if (entry.retries >= MAX_LOG_WRITE_RETRIES) {
    logQueueBytes -= entry.sizeBytes;
    reportLogStorageError("一条接口日志连续写入失败，已跳过。原因：" + error, true);
    writeNextLog();
    return;
  }
  entry.retries++;
  logQueue.unshift(entry);
  reportLogStorageError(error);
  var delay = Math.min(1000 * Math.pow(2, entry.retries - 1), 16000);
  logRetryTimer = setTimeout(function() {
    logRetryTimer = null;
    writeNextLog();
  }, delay);
}

function writeNextLog() {
  if (isSavingLogs || logRetryTimer || logClearPending || logQueue.length === 0) return;
  isSavingLogs = true;
  var entry = logQueue.shift();
  var generation = logWriteGeneration;

  chrome.storage.local.get(["logs"], function(result) {
    if (generation !== logWriteGeneration) {
      isSavingLogs = false;
      finishLogClear();
      return;
    }
    if (chrome.runtime.lastError) {
      retryLogWrite(entry, chrome.runtime.lastError.message);
      return;
    }
    var logs = result.logs || [];
    logs.push(entry.log);
    if (logs.length > 200) logs.splice(0, logs.length - 200);
    chrome.storage.local.set({ logs }, function() {
      if (generation !== logWriteGeneration) {
        isSavingLogs = false;
        finishLogClear();
        return;
      }
      if (chrome.runtime.lastError) {
        retryLogWrite(entry, chrome.runtime.lastError.message);
        return;
      }
      isSavingLogs = false;
      logQueueBytes -= entry.sizeBytes;
      bumpRecordingStats("logs", 1);
      if (logStorageBlocked) {
        logStorageBlocked = false;
        notifyLogStorageRecovered();
      }
      writeNextLog();
    });
  });
}

// ===== 自动截图检查 =====

function checkAutoCapture(tabId, requestId, headerInfo, bodyText) {
  chrome.storage.local.get(["autoCapture"], function(result) {
    var config = result.autoCapture || {};
    if (!config.enabled || !config.rules || config.rules.length === 0) {
      return;
    }

    var delay = config.delay || 500;
    var rules = config.rules;

    // 解析 body 为 JSON（如果可能）
    var body = null;
    try {
      body = JSON.parse(bodyText);
    } catch (e) {
      // 非 JSON，body 保持 null
    }

    // 从 requestMeta 获取 method（headerInfo 中没有）
    var reqMeta = requestMeta[requestId] || {};

    // 构造断言上下文
    var context = {
      status: headerInfo.status || 0,
      statusText: headerInfo.statusText || "",
      url: headerInfo.url || "",
      method: reqMeta.method || "",
      body: body,
      bodyText: bodyText || "",
      resourceType: headerInfo.resourceType || ""
    };

    // 检查是否命中任一规则
    var matched = false;
    var matchedRuleName = "";
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (!rule.enabled || !rule.expression) continue;

      try {
        var result = evaluateExpression(rule.expression, context);
        if (result) {
          matched = true;
          matchedRuleName = rule.name || "规则" + (i + 1);
          break;
        }
      } catch (e) {
        console.warn("[BugReport] 断言表达式执行失败:", rule.expression, e.message);
      }
    }

    if (matched) {
      console.log("[BugReport] 自动截图触发，规则:", matchedRuleName, ", 延迟:", delay, "ms");
      setTimeout(function() {
        captureTabAuto(tabId, matchedRuleName);
      }, delay);
    }
  });
}

// ===== 执行断言表达式（安全解析，不依赖 eval） =====

function evaluateExpression(expression, context) {
  try {
    // 支持的变量名
    var vars = {
      status: context.status,
      statusText: context.statusText,
      url: context.url,
      method: context.method,
      body: context.body,
      bodyText: context.bodyText,
      resourceType: context.resourceType
    };

    // 简单的表达式解析器：支持 &&、||、括号、比较、属性访问
    return parseExpression(expression, vars);
  } catch (e) {
    console.warn("[BugReport] 表达式解析错误:", e.message);
    return false;
  }
}

function parseExpression(expr, vars) {
  expr = expr.trim();

  // 处理 || 逻辑或（优先级最低）
  var orParts = splitByOperator(expr, '||');
  if (orParts.length > 1) {
    for (var i = 0; i < orParts.length; i++) {
      if (parseExpression(orParts[i], vars)) return true;
    }
    return false;
  }

  // 处理 && 逻辑与
  var andParts = splitByOperator(expr, '&&');
  if (andParts.length > 1) {
    for (var j = 0; j < andParts.length; j++) {
      if (!parseExpression(andParts[j], vars)) return false;
    }
    return true;
  }

  // 处理括号
  if (expr.startsWith('(') && expr.endsWith(')')) {
    return parseExpression(expr.slice(1, -1), vars);
  }

  // 处理比较运算
  var compareOps = ['!==', '===', '!=', '==', '>=', '<=', '>', '<'];
  for (var k = 0; k < compareOps.length; k++) {
    var op = compareOps[k];
    var parts = splitByOperator(expr, op);
    if (parts.length === 2) {
      var left = resolveValue(parts[0].trim(), vars);
      var right = resolveValue(parts[1].trim(), vars);
      return compareValues(left, op, right);
    }
  }

  // 处理 .includes()
  var incMatch = expr.match(/^(.+?)\.includes\((.+?)\)$/);
  if (incMatch) {
    var obj = resolveValue(incMatch[1].trim(), vars);
    var arg = resolveValue(incMatch[2].trim(), vars);
    if (typeof obj === 'string') return obj.includes(String(arg));
    if (Array.isArray(obj)) return obj.includes(arg);
    return false;
  }

  // 处理 .length（直接访问）
  if (expr.endsWith('.length')) {
    var target = resolveValue(expr.slice(0, -7), vars);
    return typeof target === 'string' || Array.isArray(target) ? target.length : 0;
  }

  // 单个变量/属性，转为布尔
  var val = resolveValue(expr, vars);
  return !!val;
}

function splitByOperator(expr, op) {
  var parts = [];
  var depth = 0;
  var current = '';
  var i = 0;
  while (i < expr.length) {
    if (expr[i] === '(') depth++;
    if (expr[i] === ')') depth--;
    if (depth === 0 && expr.substr(i, op.length) === op) {
      parts.push(current);
      current = '';
      i += op.length;
    } else {
      current += expr[i];
      i++;
    }
  }
  parts.push(current);
  return parts;
}

function resolveValue(str, vars) {
  str = str.trim();

  // 字符串字面量
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    return str.slice(1, -1);
  }

  // 数字
  if (/^-?\d+(\.\d+)?$/.test(str)) {
    return parseFloat(str);
  }

  // 属性链访问 body.data.list.length
  if (str.includes('.')) {
    var parts = str.split('.');
    var obj = vars[parts[0]];
    for (var i = 1; i < parts.length; i++) {
      if (obj === null || obj === undefined) return undefined;
      obj = obj[parts[i]];
    }
    return obj;
  }

  // 直接变量名
  if (vars.hasOwnProperty(str)) {
    return vars[str];
  }

  return str;
}

function compareValues(left, op, right) {
  switch (op) {
    case '===': return left === right;
    case '!==': return left !== right;
    case '==':  return left == right;
    case '!=':  return left != right;
    case '>':   return left > right;
    case '<':   return left < right;
    case '>=':  return left >= right;
    case '<=':  return left <= right;
    default:    return false;
  }
}

// ===== 截图采集（可选 JPEG 压缩，降低存储占用）=====

function captureVisibleTabCompressed(callback) {
  chrome.tabs.captureVisibleTab(null, { format: "png" }, function (dataUrl) {
    if (chrome.runtime.lastError) {
      callback({ success: false, error: chrome.runtime.lastError.message });
      return;
    }
    if (!dataUrl) {
      callback({ success: false, error: "截图数据为空" });
      return;
    }
    compressScreenshot(dataUrl, function (finalUrl) {
      chrome.storage.local.get(["screenshots"], function (result) {
        var screenshots = result.screenshots || [];
        screenshots.push({ url: finalUrl, timestamp: new Date().toISOString() });
        chrome.storage.local.set({ screenshots }, function () {
          if (chrome.runtime.lastError) {
            callback({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          bumpRecordingStats("screenshots", 1);
          callback({ success: true });
        });
      });
    });
  });
}

function compressScreenshot(dataUrl, callback) {
  chrome.storage.local.get(["screenshotConfig"], function (result) {
    var config = result.screenshotConfig || {};
    if (config.compress === false || !dataUrl || dataUrl.indexOf("data:image/") !== 0) {
      callback(dataUrl);
      return;
    }
    var quality = typeof config.quality === "number" ? config.quality : 0.75;
    compressDataUrl(dataUrl, quality).then(callback).catch(function (err) {
      console.warn("[BugReport] 截图压缩失败，使用原图:", err && err.message);
      callback(dataUrl);
    });
  });
}

function compressDataUrl(dataUrl, quality) {
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") {
    return Promise.reject(new Error("当前浏览器不支持 OffscreenCanvas"));
  }
  return fetch(dataUrl).then(function (response) {
    return response.blob();
  }).then(function (blob) {
    return createImageBitmap(blob);
  }).then(function (bitmap) {
    var maxWidth = 1400;
    var scale = Math.min(1, maxWidth / bitmap.width);
    var canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale))
    );
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (bitmap.close) bitmap.close();
    return canvas.convertToBlob({ type: "image/jpeg", quality: quality });
  }).then(blobToDataUrl);
}

function blobToDataUrl(blob) {
  return blob.arrayBuffer().then(function (buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = "";
    var chunkSize = 0x8000;
    for (var i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return "data:" + (blob.type || "image/jpeg") + ";base64," + btoa(binary);
  });
}

// ===== 自动截图 =====

function captureTabAuto(tabId, ruleName) {
  chrome.tabs.captureVisibleTab(null, { format: "png" }, function (dataUrl) {
    if (chrome.runtime.lastError) {
      console.error("[BugReport] 自动截图失败:", chrome.runtime.lastError.message);
      return;
    }
    if (!dataUrl) {
      console.error("[BugReport] 自动截图失败: 无数据");
      return;
    }

    compressScreenshot(dataUrl, function (finalUrl) {
      chrome.storage.local.get(["screenshots"], function (result) {
        var screenshots = result.screenshots || [];
        screenshots.push({
          url: finalUrl,
          timestamp: new Date().toISOString(),
          autoCaptured: true,
          ruleName: ruleName
        });
        chrome.storage.local.set({ screenshots }, function () {
          bumpRecordingStats("screenshots", 1);
          console.log("[BugReport] 自动截图已保存, 规则:", ruleName);
        });
      });
    });
  });
}
