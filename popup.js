// popup.js - Bug Report Generator

document.addEventListener("DOMContentLoaded", function() {
  // MV3 扩展页禁止内联脚本，side panel 行为在这里统一设置
  try {
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(function() {});
    }
  } catch (e) {}

  var toggleBtn = document.getElementById("toggleRecord");
  var captureBtn = document.getElementById("captureScreenshot");
  var generateBtn = document.getElementById("generateReport");
  var copyBtn = document.getElementById("copyReport");
  var clearBtn = document.getElementById("clearData");
  var openSettingsBtn = document.getElementById("openSettings");
  var statusDiv = document.getElementById("status");
  var previewDiv = document.getElementById("reportPreview");
  var screenshotList = document.getElementById("screenshotList");
  var bugTitleInput = document.getElementById("bugTitle");
  var interfaceList = document.getElementById("interfaceList");
  var generateTitleBtn = document.getElementById("generateTitle");
  var copyTitleBtn = document.getElementById("copyTitle");
  var filterModeButtons = Array.prototype.slice.call(document.querySelectorAll(".filter-mode"));
  var filterSearch = document.getElementById("filterSearch");
  var filterSelectAll = document.getElementById("filterSelectAll");
  var filterInvert = document.getElementById("filterInvert");
  var filterOnlyFailed = document.getElementById("filterOnlyFailed");

  var isRecording = false;
  var captureError = "";
  var storageError = "";
  var storageLossPersistent = false;
  var captureTabId = null;
  var filterState = { mode: "all", search: "", excludedGroups: [] };
  var previewEditing = false;
  var pendingStepEdits = {};
  var SLOW_REQUEST_MS = 1000;

  // ===== 初始化 =====
  chrome.storage.local.get(["isRecording", "captureTabId", "steps", "logs", "bugTitle", "excludedUrls", "interfaceFilter"], function(result) {
    isRecording = !!result.isRecording;
    captureTabId = result.captureTabId == null ? null : result.captureTabId;
    if (result.bugTitle) bugTitleInput.value = result.bugTitle;

    console.log("[BugReport Popup] 初始化, isRecording =", isRecording,
      ", steps =", (result.steps || []).length,
      ", logs =", (result.logs || []).length);

    filterState = normalizeFilter(result.interfaceFilter);
    syncFilterControls();
    renderInterfaceFilter(result);

    if ((result.steps && result.steps.length > 0) ||
        (result.logs && result.logs.length > 0)) {
      previewDiv.innerHTML = formatReport(result);
    }

    updateUI();
    (chrome.storage.session || chrome.storage.local).get(["logStorageLoss"], function(storageState) {
      storageError = storageState.logStorageLoss || "";
      storageLossPersistent = !!storageError;
      if (storageLossPersistent) updateUI();
    });

    // 延迟加载截图数据（非关键路径）
    setTimeout(function() {
      chrome.storage.local.get(["screenshots"], function(screenshotResult) {
        if (screenshotResult.screenshots && screenshotResult.screenshots.length > 0) {
          var currentData = result;
          currentData.screenshots = screenshotResult.screenshots;
          previewDiv.innerHTML = formatReport(currentData);
        }
      });
    }, 100);

  });

  // ===== 监听来自 content script 的停止录制请求（点击页面指示器时）=====
  chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message.action === "stopRecordingFromPage") {
      isRecording = false;
      captureError = "";
      captureTabId = null;
      chrome.storage.local.set({ isRecording: false, captureTabId: null });
      var tabId = sender.tab ? sender.tab.id : null;
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { action: "stopRecording" }).catch(function() {});
        chrome.runtime.sendMessage({ action: "stopLogCapture", tabId: tabId }).catch(function() {});
      }
      updateUI();
    } else if (message.action === "debuggerDetached" && isRecording &&
               (captureTabId == null || message.tabId === captureTabId)) {
      captureError = message.error || "浏览器已断开接口采集";
      updateUI();
    } else if (message.action === "logStorageError") {
      storageError = message.error || "存储不可用";
      if (message.permanent) storageLossPersistent = true;
      updateUI();
    } else if (message.action === "logStorageRecovered") {
      if (!storageLossPersistent) {
        storageError = "";
        updateUI();
      }
    }
    sendResponse({ ok: true });
  });

  // ===== 标题输入与复制 =====
  bugTitleInput.addEventListener("input", function() {
    chrome.storage.local.set({ bugTitle: bugTitleInput.value });
  });

  if (copyTitleBtn) {
    copyTitleBtn.addEventListener("click", function() {
      var titleText = (bugTitleInput.value || "").trim();
      if (!titleText) {
        statusDiv.innerText = "请先输入或生成 Bug 标题";
        setTimeout(updateUI, 2000);
        return;
      }
      navigator.clipboard.writeText(titleText).then(function() {
        copyTitleBtn.classList.add("copied");
        statusDiv.innerText = "标题已复制到剪贴板 ✓";
        setTimeout(function() {
          copyTitleBtn.classList.remove("copied");
          updateUI();
        }, 2000);
      }).catch(function(err) {
        statusDiv.innerText = "复制失败: " + err.message;
        setTimeout(updateUI, 2000);
      });
    });
  }

  // ===== 开始/停止录制（统一由 background 处理，面板/快捷键/悬浮条共用）=====
  toggleBtn.addEventListener("click", function() {
    if (toggleBtn.disabled) return;
    toggleBtn.disabled = true;
    chrome.runtime.sendMessage({ action: "toggleRecording" }).then(function(response) {
      toggleBtn.disabled = false;
      if (!response) {
        statusDiv.innerText = "无法连接后台服务，请刷新页面后重试";
        setTimeout(updateUI, 3000);
        return;
      }
      isRecording = !!response.isRecording;
      captureTabId = response.tabId == null ? null : response.tabId;
      captureError = response.captureError || "";
      if (!isRecording) {
        captureTabId = null;
        captureError = "";
      }
      if (response.error && !isRecording) {
        statusDiv.innerText = response.error;
        setTimeout(updateUI, 3000);
        return;
      }
      updateUI();
    }).catch(function(err) {
      toggleBtn.disabled = false;
      statusDiv.innerText = "切换录制失败: " + (err && err.message ? err.message : "未知错误");
      setTimeout(updateUI, 3000);
    });
  });

  // ===== 截图 =====
  captureBtn.addEventListener("click", function() {
    statusDiv.innerText = "正在截图...";
    chrome.runtime.sendMessage({ action: "captureTab" }, function(response) {
      if (response && response.success) {
        statusDiv.innerText = "截图已保存";
        refreshPreview();
      } else {
        statusDiv.innerText = "截图失败: " + (response && response.error ? response.error : "未知错误");
      }
      setTimeout(updateUI, 2000);
    });
  });

  // ===== 接口筛选 =====

  function normalizeFilter(value) {
    value = value || {};
    var mode = value.mode === "failed" || value.mode === "slow" ? value.mode : "all";
    return {
      mode: mode,
      search: typeof value.search === "string" ? value.search : "",
      excludedGroups: Array.isArray(value.excludedGroups) ? value.excludedGroups.slice(0) : []
    };
  }

  // 用 JSON 作为分组键，避免控制字符被 HTML 属性归一化后匹配不上
  function interfaceGroupKey(log) {
    return JSON.stringify([log.method || "", log.url || "", log.postData || ""]);
  }

  function isBusinessError(bodyText) {
    if (!bodyText) return false;
    var body;
    try { body = JSON.parse(bodyText); } catch (e) { return false; }
    if (!body || typeof body !== "object") return false;
    if (body.error_code != null && Number(body.error_code) !== 0) return true;
    if (body.code != null) {
      var code = Number(body.code);
      if (!isNaN(code) && code !== 0 && code !== 200) return true;
    }
    return false;
  }

  function isFailedResponse(log) {
    if (!log) return false;
    if (!log.status) return true;  // 连接失败 / 无响应
    if (Number(log.status) >= 400) return true;
    return isBusinessError(log.body);
  }

  // 相同 method + URL + payload 的轮询合并成一组，只保留最后一次响应
  function buildInterfaceGroups(logs) {
    var groups = [];
    var byKey = {};
    var byRequestId = {};

    for (var i = 0; i < logs.length; i++) {
      var log = logs[i];
      if (!log || !log.url || log.url.indexOf("chrome-extension") === 0) continue;
      if (log.type !== "network" && log.type !== "response") continue;
      if (log.resourceType && log.resourceType !== "xhr" && log.resourceType !== "fetch") continue;

      if (log.type === "network") {
        var key = interfaceGroupKey(log);
        var group = byKey[key];
        if (!group) {
          group = {
            key: key,
            method: log.method || "",
            url: log.url || "",
            postData: log.postData || "",
            firstRequest: log,
            count: 0,
            status: 0,
            lastResponse: null,
            failed: false,
            slow: false
          };
          byKey[key] = group;
          groups.push(group);
        }
        group.count++;
        if (log.requestId) byRequestId[log.requestId] = group;
      } else {
        var respGroup = byRequestId[log.requestId];
        if (!respGroup) {
          var respKey = interfaceGroupKey(log);
          respGroup = byKey[respKey];
          if (!respGroup) {
            respGroup = {
              key: respKey,
              method: log.method || "",
              url: log.url || "",
              postData: "",
              firstRequest: null,
              count: 1,
              status: 0,
              lastResponse: null,
              failed: false,
              slow: false
            };
            byKey[respKey] = respGroup;
            groups.push(respGroup);
          }
        }
        if (!respGroup.count) respGroup.count = 1;
        respGroup.lastResponse = log;
        respGroup.status = log.status || respGroup.status;
        if (isFailedResponse(log)) respGroup.failed = true;
        if (typeof log.durationMs === "number" && log.durationMs > SLOW_REQUEST_MS) respGroup.slow = true;
      }
    }

    return groups;
  }

  // includeExcluded: 面板列表要显示未勾选的接口，报告渲染时才排除
  function filterGroups(groups, filter, legacyExcludedUrls, includeExcluded) {
    var excludedGroups = {};
    filter.excludedGroups.forEach(function(key) { excludedGroups[key] = true; });
    var legacyExcluded = {};
    (legacyExcludedUrls || []).forEach(function(url) { legacyExcluded[url] = true; });
    var search = (filter.search || "").toLowerCase();

    return groups.filter(function(group) {
      if (!includeExcluded && (excludedGroups[group.key] || legacyExcluded[group.url])) return false;
      if (filter.mode === "failed" && !group.failed) return false;
      if (filter.mode === "slow" && !group.slow) return false;
      if (search && group.url.toLowerCase().indexOf(search) === -1) return false;
      return true;
    });
  }

  function syncFilterControls() {
    filterModeButtons.forEach(function(btn) {
      btn.classList.toggle("active", (btn.getAttribute("data-mode") || "all") === filterState.mode);
    });
    if (filterSearch && document.activeElement !== filterSearch) {
      filterSearch.value = filterState.search || "";
    }
  }

  function updateFilter(patch) {
    chrome.storage.local.get(["interfaceFilter"], function(result) {
      var next = normalizeFilter(result.interfaceFilter);
      Object.keys(patch).forEach(function(key) { next[key] = patch[key]; });
      chrome.storage.local.set({ interfaceFilter: next }, function() {
        filterState = next;
        refreshPreview(true);
      });
    });
  }

  interfaceList.addEventListener("change", function(e) {
    var checkbox = e.target;
    if (!checkbox || checkbox.type !== "checkbox") return;
    var key = checkbox.getAttribute("data-key");
    var url = checkbox.getAttribute("data-url");
    if (!key) return;

    chrome.storage.local.get(["interfaceFilter", "excludedUrls"], function(result) {
      var next = normalizeFilter(result.interfaceFilter);
      var legacy = result.excludedUrls || [];
      var idx = next.excludedGroups.indexOf(key);
      if (!checkbox.checked && idx === -1) next.excludedGroups.push(key);
      if (checkbox.checked && idx !== -1) next.excludedGroups.splice(idx, 1);
      if (checkbox.checked && url) {
        var legacyIdx = legacy.indexOf(url);
        if (legacyIdx !== -1) legacy.splice(legacyIdx, 1);
      }
      chrome.storage.local.set({ interfaceFilter: next, excludedUrls: legacy }, function() {
        filterState = next;
        refreshPreview(true);
      });
    });
  });

  filterModeButtons.forEach(function(btn) {
    btn.addEventListener("click", function() {
      updateFilter({ mode: btn.getAttribute("data-mode") || "all" });
    });
  });

  if (filterSearch) {
    var filterSearchTimer = null;
    filterSearch.addEventListener("input", function() {
      clearTimeout(filterSearchTimer);
      filterSearchTimer = setTimeout(function() {
        updateFilter({ search: filterSearch.value.trim() });
      }, 250);
    });
  }

  function setGroupSelection(target) {
    chrome.storage.local.get(["logs", "excludedUrls", "interfaceFilter"], function(data) {
      var filter = normalizeFilter(data.interfaceFilter);
      var groups = filterGroups(buildInterfaceGroups(data.logs || []), filter, data.excludedUrls || [], true);
      var keys = groups.map(function(group) { return group.key; });

      function isExcluded(key) { return filter.excludedGroups.indexOf(key) !== -1; }
      function exclude(key) { if (!isExcluded(key)) filter.excludedGroups.push(key); }
      function include(key) {
        var idx = filter.excludedGroups.indexOf(key);
        if (idx !== -1) filter.excludedGroups.splice(idx, 1);
      }

      if (target === "all") {
        keys.forEach(include);
      } else if (target === "none") {
        keys.forEach(exclude);
      } else if (target === "invert") {
        keys.forEach(function(key) { if (isExcluded(key)) include(key); else exclude(key); });
      } else if (target === "failed") {
        keys.forEach(include);
        groups.forEach(function(group) { if (!group.failed) exclude(group.key); });
      }

      var payload = { interfaceFilter: filter };
      if (target === "all") payload.excludedUrls = [];
      chrome.storage.local.set(payload, function() {
        filterState = filter;
        refreshPreview(true);
      });
    });
  }

  if (filterSelectAll) filterSelectAll.addEventListener("click", function() { setGroupSelection("all"); });
  if (filterInvert) filterInvert.addEventListener("click", function() { setGroupSelection("invert"); });
  if (filterOnlyFailed) filterOnlyFailed.addEventListener("click", function() { setGroupSelection("failed"); });

  function renderInterfaceFilter(data) {
    var filter = normalizeFilter(data.interfaceFilter || filterState);
    filterState = filter;
    var groups = buildInterfaceGroups(data.logs || []);
    var visible = filterGroups(groups, filter, data.excludedUrls || [], true);
    var excluded = {};
    filter.excludedGroups.forEach(function(key) { excluded[key] = true; });
    var legacyExcluded = {};
    (data.excludedUrls || []).forEach(function(url) { legacyExcluded[url] = true; });

    if (visible.length === 0) {
      interfaceList.innerHTML = groups.length === 0
        ? '<p class="report-empty" style="color:#999; margin:4px 0;">暂无接口</p>'
        : '<p class="report-empty" style="color:#999; margin:4px 0;">没有符合筛选条件的接口</p>';
    } else {
      var h = "";
      for (var j = 0; j < visible.length; j++) {
        var group = visible[j];
        var checked = !(excluded[group.key] || legacyExcluded[group.url]);
        h += '<label class="interface-item" title="' + esc(group.url) + '">' +
             '<input type="checkbox" data-key="' + esc(group.key) + '" data-url="' + esc(group.url) + '"' + (checked ? " checked" : "") + '>' +
             '<span class="method">' + esc(group.method) + '</span>' +
             '<span class="url">' + breakableUrl(group.url) + '</span>' +
             '<span class="iface-meta">' +
               '<span class="' + (group.failed ? "iface-status bad" : "iface-status ok") + '">' +
               esc(group.status ? String(group.status) : "—") + '</span>' +
               (group.count > 1 ? '<span class="iface-count">&times;' + group.count + '</span>' : "") +
               (group.slow ? '<span class="iface-slow">慢</span>' : "") +
             '</span>' +
             '</label>';
      }
      interfaceList.innerHTML = h;
    }

    var selectedCount = 0;
    for (var k = 0; k < visible.length; k++) {
      if (!(excluded[visible[k].key] || legacyExcluded[visible[k].url])) selectedCount++;
    }
    var summary = document.getElementById("filterSummary");
    if (summary) {
      summary.textContent = groups.length === 0
        ? ""
        : (selectedCount + "/" + visible.length + (visible.length === groups.length ? "" : "（共 " + groups.length + "）"));
    }
    syncFilterControls();
  }

  // ===== 更新预览 =====
  generateBtn.addEventListener("click", function() {
    refreshPreview();
    statusDiv.innerText = "预览已更新";
    setTimeout(updateUI, 2000);
  });

  function refreshPreview(force) {
    if (previewEditing && !force) return;
    chrome.storage.local.get(["steps", "logs", "screenshots", "bugTitle", "excludedUrls", "interfaceFilter"], function(data) {
      previewDiv.innerHTML = formatReport(data);
      renderInterfaceFilter(data);
    });
  }

  // Keep the open side panel in sync with data collected by content/background scripts.
  var previewRefreshTimer = null;
  chrome.storage.onChanged.addListener(function(changes, areaName) {
    if (areaName !== "local") return;

    if (changes.isRecording) {
      isRecording = !!changes.isRecording.newValue;
      updateUI();
    }
    if (changes.captureTabId) {
      captureTabId = changes.captureTabId.newValue == null ? null : changes.captureTabId.newValue;
    }

    var hasNewRecords = ["steps", "logs", "screenshots"].some(function(key) {
      var change = changes[key];
      return change && Array.isArray(change.newValue) && change.newValue.length > 0;
    });
    if (!hasNewRecords && !changes.interfaceFilter) return;

    clearTimeout(previewRefreshTimer);
    previewRefreshTimer = setTimeout(function() {
      previewRefreshTimer = null;
      refreshPreview();
    }, 250);
  });

  // ===== 复制报告 =====
  copyBtn.addEventListener("click", function() {
    var htmlContent = previewDiv.innerHTML;
    var textContent = previewDiv.innerText;

    if (!htmlContent || textContent === "等待生成...") {
      statusDiv.innerText = "请先生成预览";
      setTimeout(updateUI, 2000);
      return;
    }

    var blob = new Blob([htmlContent], { type: "text/html" });
    var textBlob = new Blob([textContent], { type: "text/plain" });

    navigator.clipboard.write([new ClipboardItem({ "text/html": blob, "text/plain": textBlob })])
      .then(function() { statusDiv.innerText = "报告已复制！"; setTimeout(updateUI, 2000); })
      .catch(function(err) { statusDiv.innerText = "复制失败，请重试"; setTimeout(updateUI, 2000); });
  });

  // ===== 清除数据 =====
  clearBtn.addEventListener("click", function() {
    if (!confirm("确定要清除所有已记录的数据吗？")) return;
    statusDiv.innerText = "正在清除...";
    chrome.storage.local.set({
      steps: [],
      logs: [],
      screenshots: [],
      bugTitle: "",
      excludedUrls: [],
      interfaceFilter: { mode: "all", search: "", excludedGroups: [] },
      recordingStats: { steps: 0, logs: 0, screenshots: 0 }
    }, function() {
      var dataClearError = chrome.runtime.lastError ? chrome.runtime.lastError.message : "";
      if (dataClearError) {
        chrome.runtime.sendMessage({ action: "clearLogStorageLoss" }).then(function(response) {
          storageError = "本地数据清除失败：" + dataClearError;
          if (!response || !response.success) {
            storageError += "；接口日志清除失败：" + ((response && response.error) || "后台未确认");
          }
          statusDiv.innerText = storageError;
          refreshPreview();
          updateUI();
        }).catch(function(err) {
          storageError = "本地数据清除失败：" + dataClearError + "；后台日志清除未确认";
          statusDiv.innerText = storageError + (err && err.message ? "：" + err.message : "");
          refreshPreview();
          updateUI();
        });
        return;
      }

      storageError = "";
      storageLossPersistent = false;
      previewDiv.innerHTML = '<div class="preview-empty">等待生成...</div>';
      bugTitleInput.value = "";
      screenshotList.innerHTML = "";
      filterState = { mode: "all", search: "", excludedGroups: [] };
      renderInterfaceFilter({ logs: [], excludedUrls: [], interfaceFilter: filterState });
      chrome.runtime.sendMessage({ action: "clearLogStorageLoss" }).then(function(response) {
        if (response && response.success) {
          statusDiv.innerText = "数据已清除";
        } else {
          storageError = response && response.error ? response.error : "后台日志清理未完成";
          storageLossPersistent = true;
          statusDiv.innerText = "清除失败：" + storageError;
        }
        updateUI();
        setTimeout(updateUI, 3000);
      }).catch(function(err) {
        storageError = err && err.message ? err.message : "无法确认后台日志清理结果";
        statusDiv.innerText = "清除失败：" + storageError;
        updateUI();
      });
    });
  });

  // ===== UI 状态 =====
  function updateUI() {
    var label = toggleBtn.querySelector(".btn-label");
    if (isRecording) {
      if (label) label.textContent = "停止记录步骤";
      else toggleBtn.innerText = "停止记录步骤";
      toggleBtn.className = "btn danger";
      var warning = captureError || (storageError ? "接口日志保存失败：" + storageError : "");
      statusDiv.innerText = warning ? "操作步骤仍在记录；采集异常：" + warning : "🔴 正在记录中...";
    } else {
      if (label) label.textContent = "开始记录步骤";
      else toggleBtn.innerText = "开始记录步骤";
      toggleBtn.className = "btn primary";
      statusDiv.innerText = storageError ? "接口日志存储异常：" + storageError : "就绪";
    }
  }

  // ===== 格式化报告 =====
  function describeStep(step) {
    if (!step) return "";
    if (step.type === "click") {
      var skipLabel = ["DIV","SPAN","SECTION","HEADER","FOOTER","NAV","MAIN","ASIDE","ARTICLE","P","FIGURE","FIGCAPTION","DL","DT","DD","OL","UL","LI"];
      var label = step.fieldLabel || step.tagNameCn || step.tagName || "";
      var value = step.fieldValue || step.text || "";
      var desc = step.text ? String(step.text) : "";
      var isActionTag = step.tagName === "BUTTON" || step.tagName === "A" || step.tagName === "SVG";
      var prefix = skipLabel.indexOf(step.tagName) !== -1 || isActionTag ? "点击" : "点击" + label;
      if (value) {
        return isActionTag ? ("点击 " + String(value)) : (prefix + "：" + String(value));
      }
      return prefix + (desc ? "\"" + desc + "\"" : "");
    }
    if (step.type === "input") {
      return "输入 " + (step.fieldLabel || step.tagNameCn || step.tagName || "") +
        "：" + String(step.fieldValue || step.value || "");
    }
    if (step.type === "select") {
      return "选择 " + (step.fieldLabel || step.tagNameCn || "下拉框") +
        "：" + String(step.fieldValue || step.value || "");
    }
    if (step.type === "toggle") {
      return "选择 " + (step.fieldLabel || step.tagNameCn || "复选框") +
        "：" + String(step.fieldValue || step.value || "");
    }
    return "";
  }

  function formatReport(data) {
    var steps = data.steps || [];
    var logs = data.logs || [];
    var screenshots = data.screenshots || [];

    var h = "";

    // ----- 1. 操作步骤（文本可原地编辑，× 删除）-----
    h += "<p><strong>1. 操作步骤</strong></p>";
    if (steps.length === 0) {
      h += '<p class="report-empty" style="color:#999;">无记录步骤</p>';
    } else {
      for (var i = 0; i < steps.length; i++) {
        var step = steps[i];
        var stepText = step.displayText != null && step.displayText !== ""
          ? String(step.displayText)
          : describeStep(step);
        h += '<p class="report-step" data-step-index="' + i + '" contenteditable="true" spellcheck="false" title="点击直接编辑，右侧 × 删除">' +
             (i + 1) + ". " + esc(stepText) +
             '<span class="step-del" contenteditable="false" title="删除该步骤"></span></p>';
      }
    }

    // ----- 2. 接口日志（cURL + 响应体；同 method + URL + payload 合并）-----
    h += "<p><strong>2. 接口日志</strong></p>";

    var filter = normalizeFilter(data.interfaceFilter);
    var allGroups = buildInterfaceGroups(logs);
    var groups = filterGroups(allGroups, filter, data.excludedUrls || []);

    if (groups.length === 0) {
      h += '<p class="report-empty" style="color:#999;">无接口日志</p>';
    } else {
      for (var oi = 0; oi < groups.length; oi++) {
        var group = groups[oi];
        var req = group.firstRequest;
        var resp = group.lastResponse;

        h += '<div class="report-endpoint" style="border:1px solid #ddd; border-radius:4px; margin-bottom:10px; padding:8px; background:#fafafa;">';

        h += "<p class='report-endpoint-title' style='margin:0 0 5px; font-weight:bold; word-break:break-all;'>" +
            (oi + 1) + ". " + esc(group.method) + " " + esc(group.url) +
            (group.count > 1 ? " <span class='report-count' style='color:#666; font-weight:normal;'>&times;" + group.count + "</span>" : "") +
            "</p>";

        // cURL 块（合并组展示首个请求）
        if (req && req.curl) {
          h += "<p class='report-label' style='margin:5px 0 2px; color:#666; font-weight:bold;'>cURL:</p>";
          h += "<pre class='curl-block'>" + esc(req.curl) + "</pre>";
        }

        // 响应块（合并组展示最后一次响应）
        if (resp) {
          var sc = resp.status < 400 ? "#28a745" : "#dc3545";
          var scClass = resp.status < 400 ? "report-status-ok" : "report-status-bad";
          var respClass = resp.status < 400 ? "resp-block success-resp" : "resp-block error-resp";
          var st = resp.statusText ? " " + esc(resp.statusText) : "";
          var duration = typeof resp.durationMs === "number" ? " · " + resp.durationMs + "ms" : "";
          h += "<p class='report-label' style='margin:5px 0 2px; color:#666; font-weight:bold;'>响应结果 (" +
              "<span class='" + scClass + "' style='color:" + sc + "; font-weight:bold;'>" + resp.status + st + "</span>" + duration + "):</p>";

          if (resp.body && String(resp.body).trim()) {
            h += "<pre class='" + respClass + "' style='border-left-color:" + sc + ";'>" + esc(resp.body) + "</pre>";
          } else {
            h += "<p class='report-warn' style='color:#e74c3c;'>(响应体为空 — 可能该请求无返回内容或数据已被浏览器释放)</p>";
          }
        } else {
          h += "<p class='report-empty' style='color:#999;'>(暂无响应数据)</p>";
        }

        h += "</div>";
      }
    }

    // ----- 3. 截图 -----
    h += "<p><strong>3. 截图</strong></p>";
    if (screenshots.length === 0) {
      h += '<p class="report-empty" style="color:#999;">无截图</p>';
    } else {
      for (var si = 0; si < screenshots.length; si++) {
        h += '<img class="report-shot" src="' + esc(screenshots[si].url) + '" alt="截图' + (si + 1) +
            '" style="max-width:100%; margin:5px 0; border:1px solid #eee; border-radius:4px;" />';
      }
    }

    return h;
  }

  // ===== 预览步骤：原地编辑 / 删除 =====
  previewDiv.addEventListener("focusin", function(e) {
    if (e.target && e.target.classList && e.target.classList.contains("report-step")) {
      previewEditing = true;
    }
  });

  previewDiv.addEventListener("focusout", function(e) {
    var el = e.target;
    if (!el || !el.classList || !el.classList.contains("report-step")) return;
    saveStepText(parseInt(el.getAttribute("data-step-index"), 10), el.innerText);
    setTimeout(function() {
      previewEditing = !!(document.activeElement &&
        previewDiv.contains(document.activeElement) &&
        document.activeElement.classList &&
        document.activeElement.classList.contains("report-step"));
    }, 0);
  });

  previewDiv.addEventListener("click", function(e) {
    var del = e.target && e.target.closest ? e.target.closest(".step-del") : null;
    if (!del) return;
    e.preventDefault();
    e.stopPropagation();
    var row = del.closest(".report-step");
    if (!row) return;
    removeStep(parseInt(row.getAttribute("data-step-index"), 10));
  });

  function applyPendingStepEdits(steps) {
    (steps || []).forEach(function(step, index) {
      if (pendingStepEdits[index] != null) step.displayText = pendingStepEdits[index];
    });
  }

  function saveStepText(index, text) {
    if (isNaN(index)) return;
    var clean = String(text || "").replace(/\s+/g, " ").trim().replace(/^\d+[.、)]\s*/, "");
    if (!clean) return;  // 空内容不覆盖，避免误清空
    pendingStepEdits[index] = clean;
    chrome.storage.local.get(["steps"], function(result) {
      var steps = result.steps || [];
      if (!steps[index]) { delete pendingStepEdits[index]; return; }
      if (steps[index].displayText !== clean) {
        steps[index].displayText = clean;
        chrome.storage.local.set({ steps: steps }, function() {
          if (pendingStepEdits[index] === clean) delete pendingStepEdits[index];
        });
      } else {
        delete pendingStepEdits[index];
      }
    });
  }

  function removeStep(index) {
    if (isNaN(index)) return;
    previewEditing = false;
    pendingStepEdits = {};
    chrome.storage.local.get(["steps"], function(result) {
      var steps = result.steps || [];
      if (!steps[index]) return;
      steps.splice(index, 1);
      chrome.storage.local.set({ steps: steps }, function() {
        chrome.runtime.sendMessage({ action: "setStepCount", steps: steps.length }).catch(function() {});
        refreshPreview(true);
      });
    });
  }

  // HTML 转义
  function esc(text) {
    if (!text) return "";
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // 仅用于界面展示的 URL：在 / ? & = 之后插入零宽空格，
  // 让长 URL 折行时优先断在分隔符处，而不是把参数名劈成两截。
  // 注意：data-url / data-key 等业务属性必须继续用 esc()，不能走这里。
  function breakableUrl(url) {
    if (!url) return "";
    return esc(String(url).replace(/([/?&=])/g, "$1\u200B"));
  }

  // ===== Lightbox · 点击截图查看大图 =====
  // 使用事件委托（因为截图是 formatReport() 动态注入 innerHTML 的）
  // 每次重建 innerHTML 都无需重新绑定，天然生效。
  var lightboxOverlay = document.getElementById("lightboxOverlay");
  var lightboxImage = document.getElementById("lightboxImage");
  var lightboxClose = lightboxOverlay
    ? lightboxOverlay.querySelector(".lightbox-close")
    : null;

  // ===== （保留 · 不再触发）popup 内嵌 Lightbox =====
  // 原内嵌 Lightbox 逻辑不删以支持随时切回，但默认走独立大窗口方案
  function openLightbox(src) {
    if (!lightboxOverlay || !lightboxImage || !src) return;
    lightboxImage.src = src;
    lightboxOverlay.classList.add("open");
    lightboxOverlay.setAttribute("aria-hidden", "false");
  }
  function closeLightbox() {
    if (!lightboxOverlay || !lightboxImage) return;
    lightboxOverlay.classList.remove("open");
    lightboxOverlay.setAttribute("aria-hidden", "true");
    setTimeout(function() {
      if (!lightboxOverlay.classList.contains("open")) {
        lightboxImage.removeAttribute("src");
      }
    }, 220);
  }
  // 内嵌 Lightbox 的关闭交互保留（一旦通过 console/openLightbox() 手动打开仍可关闭）
  document.addEventListener("click", function(e) {
    var target = e.target;
    if (!target) return;
    if (lightboxClose && lightboxClose.contains(target)) {
      closeLightbox();
      return;
    }
    if (
      lightboxOverlay &&
      lightboxOverlay.classList.contains("open") &&
      target === lightboxOverlay
    ) {
      closeLightbox();
      return;
    }
    if (
      lightboxOverlay &&
      lightboxOverlay.classList.contains("open") &&
      target.classList &&
      target.classList.contains("lightbox-viewport")
    ) {
      closeLightbox();
    }
  });
  document.addEventListener("keydown", function(e) {
    if (!lightboxOverlay) return;
    if (!lightboxOverlay.classList.contains("open")) return;
    if (e.keyCode === 27) closeLightbox();
  });
  if (lightboxImage) {
    lightboxImage.addEventListener("dragstart", function(e) {
      e.preventDefault();
    });
  }

  // ===== 方案 A · 独立大图窗口（chrome.windows.create · type=popup）=====
  // base64 截图通常 1~6MB，无法通过 URL 参数传 → 先写 chrome.storage.local 临时占位
  var VIEWER_TMP_KEY = "_viewerImg";
  var viewerUrl = chrome && chrome.runtime
    ? chrome.runtime.getURL("viewer.html")
    : "viewer.html";

  function openExternalViewer(src) {
    if (!src) return;
    var payload = {};
    payload[VIEWER_TMP_KEY] = src;
    try {
      chrome.storage.local.set(payload, function () {
        if (chrome.runtime.lastError) {
          // 写 storage 失败（通常是超出 10MB 配额），回退到 popup 内 Lightbox
          openLightbox(src);
          return;
        }
        // 尺寸：屏幕可用区 85%，屏幕居中
        var aw = (typeof screen !== "undefined" && screen.availWidth)  || 1280;
        var ah = (typeof screen !== "undefined" && screen.availHeight) || 800;
        var sw = (typeof screen !== "undefined" && screen.width)       || 1280;
        var sh = (typeof screen !== "undefined" && screen.height)      || 800;
        var w = Math.round(aw * 0.85);
        var h = Math.round(ah * 0.85);
        var l = Math.max(0, Math.round((sw - w) / 2));
        var t = Math.max(0, Math.round((sh - h) / 2));
        var wOpts = {
          url: viewerUrl,
          type: "popup",
          width: w,
          height: h,
          left: l,
          top: t,
          focused: true,
        };
        try {
          chrome.windows.create(wOpts, function (win) {
            if (chrome.runtime.lastError || !win) {
              // 弹窗失败（策略拦截）回退到 popup 内嵌 Lightbox
              chrome.storage.local.remove([VIEWER_TMP_KEY]);
              openLightbox(src);
            }
          });
        } catch (e) {
          chrome.storage.local.remove([VIEWER_TMP_KEY]);
          openLightbox(src);
        }
      });
    } catch (e) {
      openLightbox(src);
    }
  }

  // 事件委托：点击报告里的截图缩略图 → 开独立大窗口
  document.addEventListener("click", function(e) {
    var target = e.target;
    if (!target) return;
    if (
      target.tagName &&
      target.tagName.toLowerCase() === "img" &&
      target.hasAttribute("style") &&
      target.getAttribute("style").indexOf("max-width:100%") !== -1 &&
      target.closest(".report-content")
    ) {
      e.preventDefault();
      openExternalViewer(target.getAttribute("src"));
    }
  });

  // ===== 齿轮按钮 - 打开设置页 =====
  if (openSettingsBtn) {
    openSettingsBtn.addEventListener("click", function() {
      var settingsUrl = chrome && chrome.runtime
        ? chrome.runtime.getURL("settings.html")
        : "settings.html";
      chrome.tabs.create({ url: settingsUrl });
    });
  }

  // ===== AI 生成标题 =====
  function runTitleGeneration(callback) {
    if (!generateTitleBtn) {
      if (callback) callback({ error: "AI 生成不可用" });
      return;
    }

    generateTitleBtn.classList.add("loading");
    generateTitleBtn.disabled = true;

    chrome.storage.local.get(["steps", "logs", "screenshots", "llmConfig"], function(data) {
      applyPendingStepEdits(data.steps);
      var llmConfig = data.llmConfig || {};

      function fail(message) {
        statusDiv.innerText = message;
        resetGenerateBtn();
        if (callback) callback({ error: message });
      }

      // 校验基础配置
      if (!llmConfig.apiUrl || !llmConfig.apiKey || !llmConfig.model) {
        fail("请先在设置中填写 API 地址、Key 和模型");
        return;
      }

      // 检查开关
      if (!llmConfig.enabled) {
        fail("请在设置中勾选【启用智能标题生成】并保存");
        return;
      }

      var steps = data.steps || [];
      var logs = data.logs || [];
      var screenshots = data.screenshots || [];

      if (steps.length === 0 && logs.length === 0) {
        fail("暂无操作记录或接口日志");
        return;
      }

      statusDiv.innerText = "正在分析并生成标题...";

      var content = buildAnalysisContent(steps, logs);

      callLLMApi(llmConfig, content, screenshots, function(err, title) {
        if (err) {
          statusDiv.innerText = "生成失败: " + err.message;
          resetGenerateBtn();
          if (callback) callback({ error: err.message });
        } else if (title) {
          bugTitleInput.value = title;
          chrome.storage.local.set({ bugTitle: title });
          navigator.clipboard.writeText(title).catch(function() {});
          if (copyTitleBtn) copyTitleBtn.classList.add("copied");
          statusDiv.innerText = "标题已生成并自动复制 ✓";
          setTimeout(function() {
            if (copyTitleBtn) copyTitleBtn.classList.remove("copied");
          }, 2000);
          resetGenerateBtn();
          if (callback) callback({ title: title });
        } else {
          statusDiv.innerText = "生成失败：模型未返回有效文本";
          resetGenerateBtn();
          if (callback) callback({ error: "模型未返回有效文本" });
        }
      });
    });
  }

  function resetGenerateBtn() {
    if (!generateTitleBtn) return;
    generateTitleBtn.classList.remove("loading");
    generateTitleBtn.disabled = false;
    setTimeout(updateUI, 3500);
  }

  if (generateTitleBtn) {
    generateTitleBtn.addEventListener("click", function() {
      runTitleGeneration(null);
    });
  }

  // ===== 构造 LLM 分析内容 =====
  function buildAnalysisContent(steps, logs) {
    var parts = [];

    // 页面信息（定位模块/页面，取第一条 step 中记录的上下文）
    var pageUrl = "";
    var pageTitle = "";
    if (steps.length > 0) {
      pageUrl = steps[0].pageUrl || "";
      pageTitle = steps[0].pageTitle || "";
    }
    if (pageTitle || pageUrl) {
      parts.push("【页面信息】");
      if (pageTitle) parts.push("页面标题：" + pageTitle);
      if (pageUrl) parts.push("页面地址：" + pageUrl);
    }

    // 操作步骤
    if (steps.length > 0) {
      parts.push("【操作步骤】");
      for (var i = 0; i < steps.length; i++) {
        var step = steps[i];
        var desc = "";
        if (step.displayText) {
          desc = step.displayText;
        } else if (step.type === "click") {
          desc = "点击 " + (step.fieldLabel || step.tagName || "") + (step.text ? " \"" + step.text + "\"" : "");
        } else if (step.type === "input") {
          desc = "输入 " + (step.fieldLabel || step.tagName || "") + "：" + (step.fieldValue || step.value || "");
        } else if (step.type === "select") {
          desc = "选择 " + (step.fieldLabel || "下拉框") + "：" + (step.fieldValue || step.value || "");
        } else {
          desc = step.type + " " + (step.text || "");
        }
        parts.push((i + 1) + ". " + desc);
      }
    }

    // 接口日志（只取前10条，避免太长）
    if (logs.length > 0) {
      parts.push("\n【接口日志】（共 " + logs.length + " 条，展示前10条）");
      var displayLogs = logs.slice(0, 10);
      for (var j = 0; j < displayLogs.length; j++) {
        var log = displayLogs[j];
        if (log.type === "network") {
          parts.push("- " + log.method + " " + log.url);
        } else if (log.type === "response") {
          var statusInfo = "状态码: " + log.status;
          if (log.body) {
            var bodyPreview = log.body.substring(0, 200);
            if (log.body.length > 200) bodyPreview += "...";
            statusInfo += ", 响应: " + bodyPreview;
          }
          parts.push("  " + statusInfo);
        }
      }
    }

    return parts.join("\n");
  }

  // ===== URL 自动规范化（适配 new-api 中转站） =====
  function normalizeApiUrl(rawUrl) {
    if (!rawUrl) return "";
    var url = rawUrl.trim().replace(/\/+$/, "");
    if (!url) return "";
    if (/\/chat\/completions$/i.test(url)) {
      return url;
    }
    if (/\/v1$/i.test(url)) {
      return url + "/chat/completions";
    }
    return url + "/v1/chat/completions";
  }

  // ===== 调用 LLM API =====
  function callLLMApi(config, content, screenshots, callback) {
    var apiUrl = normalizeApiUrl(config.apiUrl);
    var apiKey = config.apiKey;
    var model = config.model;

    var template = (config.prompt && config.prompt.trim()) ? config.prompt : DEFAULT_TITLE_PROMPT;
    var promptText;
    if (template.indexOf("{content}") !== -1) {
      promptText = template.replace("{content}", content);
    } else {
      promptText = template + "\n\n【待分析数据】\n" + content;
    }
    var textOnlyPrompt = promptText;

    function request(messages, retryTextOnly) {
      var requestBody = {
        model: model,
        messages: [{ role: "user", content: messages }],
        max_tokens: 60,
        temperature: 0.1
      };

      fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + apiKey
        },
        body: JSON.stringify(requestBody)
      })
      .then(function(response) {
        if (!response.ok) {
          return response.text().then(function(errText) {
            var msg = "HTTP " + response.status;
            try {
              var errJson = JSON.parse(errText);
              if (errJson.error && errJson.error.message) {
                msg += " (" + errJson.error.message + ")";
              }
            } catch (e) {}
            throw new Error(msg);
          });
        }
        return response.json();
      })
      .then(function(data) {
      var rawTitle = "";
      if (data.choices && data.choices[0]) {
        var choice = data.choices[0];
        if (choice.message) {
          rawTitle = choice.message.content || choice.message.reasoning_content || "";
        } else if (choice.text) {
          rawTitle = choice.text;
        }
      }

      var cleanedTitle = cleanAndValidateTitle(rawTitle);

      // 如果模型返回的仍然是复述废话或无效文本，触发智能本地合成兜底
      if (!cleanedTitle) {
        cleanedTitle = generateFallbackTitle(content);
      }

      callback(null, cleanedTitle);
      })
      .catch(function(err) {
        if (!retryTextOnly) {
          console.warn("[BugReport] 多模态标题请求失败，降级为纯文本请求:", err.message);
          request(textOnlyPrompt, true);
          return;
        }

        console.error("[BugReport] LLM API 调用失败:", err);
        var fallback = generateFallbackTitle(content);
        if (fallback) {
          callback(null, fallback);
        } else {
          callback(err, null);
        }
      });
    }

    var messageContent = [{ type: "text", text: promptText }];
    var imageCount = 0;
    (screenshots || []).forEach(function(screenshot) {
      if (screenshot && screenshot.url && /^data:image\//i.test(screenshot.url)) {
        messageContent.push({
          type: "image_url",
          image_url: { url: screenshot.url }
        });
        imageCount++;
      }
    });

    if (imageCount === 0) {
      request(textOnlyPrompt, true);
    } else {
      request(messageContent, false);
    }
  }

  // ===== 标题数据清洗与兜底（prompt 已规范化，这里仅做最小必要清洗） =====
  function cleanAndValidateTitle(raw) {
    if (!raw) return "";
    var title = String(raw).trim();

    // 移除 Markdown 代码块标记
    title = title.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();

    // 按行取第一条非空内容
    var lines = title.split("\n").map(function(l) { return l.trim(); }).filter(Boolean);
    var candidate = lines[0] || "";

    // 去除包裹引号
    candidate = candidate.replace(/^["'“‘]+|["'”’]+$/g, "").trim();

    // 去除“标题：”/“Bug 标题：”等前缀
    candidate = candidate.replace(/^(Bug\s*)?(标题|Title)\s*[：:]\s*/i, "").trim();

    // 去除尾部残留标点
    candidate = candidate.replace(/[，,。；;：:\s]+$/, "").trim();

    if (Array.from(candidate).length > 20) return "";
    return candidate;
  }

  // ===== 智能本地保底标题合成算法 =====
  function generateFallbackTitle(content) {
    if (!content) return "未检测到明确异常";

    var statusMatch = content.match(/状态码:\s*(\d+)/);
    var statusCode = statusMatch ? statusMatch[1] : "";
    if (statusCode && /^[45]\d\d$/.test(statusCode)) {
      return "接口响应 " + statusCode + " 异常";
    }
    return "未检测到明确异常";
  }
});
