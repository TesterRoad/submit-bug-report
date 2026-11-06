// content.js - Bug Report Generator
// ============================================================
// 核心原则：录制状态必须绝对可靠，宁可多查不能漏记
// 所有 chrome.* API 调用都有容错，防止 Extension context invalidated 崩溃
// ============================================================

console.log("[BugReport] ========== Content Script 已加载 ==========");
console.log("[BugReport] 页面:", window.location.href);
console.log("[BugReport] 时间:", new Date().toISOString());

// ===== 全局标记：扩展是否已失效 =====
var _contextInvalid = false;

function checkContextError() {
  if (chrome.runtime.lastError) {
    var msg = chrome.runtime.lastError.message || "";
    if (msg.indexOf("invalidated") !== -1 || msg.indexOf("context") !== -1) {
      _contextInvalid = true;
      console.warn("[BugReport] ⚠️ 扩展上下文已失效，停止录制");
      _isRecording = false;
      hideRecordingIndicator();
      if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
      return true;
    }
  }
  return false;
}

// ===== 标签名 -> 中文映射 =====
var TAG_NAMES = {
  A:"链接", BUTTON:"按钮", INPUT:"输入框", TEXTAREA:"文本框",
  SELECT:"下拉框", OPTION:"选项", IMG:"图片", SPAN:"文本",
  DIV:"容器", P:"段落", H1:"标题1", H2:"标题2", H3:"标题3",
  H4:"标题4", H5:"标题5", H6:"标题6", TABLE:"表格", TR:"行",
  TD:"单元格", TH:"表头", FORM:"表单", LABEL:"标签",
  UL:"列表", OL:"有序列表", LI:"列表项", NAV:"导航栏",
  HEADER:"头部", FOOTER:"底部", SECTION:"区块",
  CANVAS:"画布", VIDEO:"视频", AUDIO:"音频",
  IFRAME:"内嵌页面", SVG:"图标"
};

function getTagNameCn(tagName) {
  return TAG_NAMES[tagName] || tagName;
}

function getInputLabel(element) {
  if (element.tagName !== "INPUT") return getTagNameCn(element.tagName);
  var type = (element.type || "text").toLowerCase();
  var typeMap = {
    text:"文本输入框", password:"密码框", number:"数字框",
    email:"邮箱框", tel:"电话框", url:"网址框",
    search:"搜索框", checkbox:"复选框", radio:"单选框",
    file:"文件选择", date:"日期选择", time:"时间选择",
    color:"颜色选择", range:"滑块", hidden:"隐藏域",
    submit:"提交按钮", reset:"重置按钮", button:"按钮",
    image:"图片按钮"
  };
  return typeMap[type] || "输入框";
}

// ===== 录制状态管理 =====
var _isRecording = false;
var _isPaused = false;
var _stats = { steps: 0, logs: 0, screenshots: 0 };

function normalizeStats(value) {
  value = value || {};
  return {
    steps: Number(value.steps) || 0,
    logs: Number(value.logs) || 0,
    screenshots: Number(value.screenshots) || 0
  };
}

// 安全调用 storage.get
function safeStorageGet(keys, callback) {
  if (_contextInvalid) return;
  try {
    chrome.storage.local.get(keys, function(result) {
      if (checkContextError()) return;
      callback(result);
    });
  } catch(e) {
    if (e.message && e.message.indexOf("invalidated") !== -1) {
      _contextInvalid = true;
      return;
    }
    // 其他错误也尝试回调空结果
    try { callback({}); } catch(e2) {}
  }
}

// 安全调用 storage.set
function safeStorageSet(data, callback) {
  if (_contextInvalid) return;
  try {
    chrome.storage.local.set(data, function() {
      checkContextError();
      if (callback && typeof callback === "function") callback();
    });
  } catch(e) {
    if (e.message && e.message.indexOf("invalidated") !== -1) {
      _contextInvalid = true;
    }
  }
}

// ===== 保障1: 从 storage 初始化 =====
safeStorageGet(["isRecording", "recordingPaused", "recordingStats"], function(result) {
  _isRecording = !!result.isRecording;
  _isPaused = !!result.recordingPaused;
  _stats = normalizeStats(result.recordingStats);
  console.log("[BugReport] ✅ 保障1-初始化: isRecording =", _isRecording, ", paused =", _isPaused);
  if (_isRecording) showRecordingIndicator();
});

// ===== 保障2: 监听 storage 变化 =====
try {
  chrome.storage.onChanged.addListener(function(changes, area) {
    if (_contextInvalid) return;
    if (checkContextError()) return;
    if (area === "local" && changes.isRecording !== undefined) {
      var oldVal = _isRecording;
      _isRecording = !!changes.isRecording.newValue;
      console.log("[BugReport] ✅ 保障2-onChanged:", oldVal, "->", _isRecording);
      if (_isRecording) showRecordingIndicator(); else hideRecordingIndicator();
    }
    if (area === "local" && changes.recordingPaused !== undefined) {
      _isPaused = !!changes.recordingPaused.newValue;
      if (_isRecording) renderRecordingIndicator();
    }
    if (area === "local" && changes.recordingStats !== undefined) {
      _stats = normalizeStats(changes.recordingStats.newValue);
      updateRecordingIndicatorCounts();
    }
  });
} catch(e) {
  console.warn("[BugReport] ⚠️ onChanged 注册失败:", e.message);
}

// ===== 保障3: 定期轮询（300ms 兜底）=====
var _pollInterval = null;
function startPolling() {
  if (_pollInterval) return;
  _pollInterval = setInterval(function() {
    if (_contextInvalid) return; // 扩展已失效则跳过
    safeStorageGet(["isRecording", "recordingPaused", "recordingStats"], function(result) {
      if (_contextInvalid) return;
      var storageVal = !!result.isRecording;
      var pausedVal = !!result.recordingPaused;
      var statsVal = normalizeStats(result.recordingStats);
      var countsChanged = statsVal.steps !== _stats.steps ||
        statsVal.logs !== _stats.logs ||
        statsVal.screenshots !== _stats.screenshots;

      if (storageVal !== _isRecording) {
        var prev = _isRecording;
        _isRecording = storageVal;
        console.log("[BugReport] ✅ 保障3-轮询修正:", prev, "!=", _isRecording);
        if (_isRecording) showRecordingIndicator(); else hideRecordingIndicator();
      }
      if (pausedVal !== _isPaused) {
        _isPaused = pausedVal;
        if (_isRecording) renderRecordingIndicator();
      }
      if (countsChanged) {
        _stats = statsVal;
        updateRecordingIndicatorCounts();
      }
    });
  }, 300);
}
startPolling();

// ===== 消息通道 =====
try {
  chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (_contextInvalid) { sendResponse({ error: "context_invalidated" }); return; }
    if (message.action === "startRecording") {
      _isRecording = true; showRecordingIndicator();
    } else if (message.action === "stopRecording") {
      _isRecording = false; hideRecordingIndicator();
    } else if (message.action === "getStatus") {
      sendResponse({ isRecording: _isRecording }); return;
    }
    sendResponse({ ok: true });
  });
} catch(e) {}

// ===== 录制状态悬浮条 =====
var _indicator = null;
var _countsEl = null;
var _pauseBtn = null;
var INDICATOR_STYLE_ID = "bugreport-indicator-style";

var INDICATOR_CSS =
  "#bugreport-indicator{position:fixed;top:8px;left:8px;z-index:2147483647;display:flex;align-items:center;gap:8px;" +
  "background:rgba(17,24,39,.92);color:#fff;font:12px/1.4 sans-serif;font-weight:600;padding:5px 10px;" +
  "border-radius:999px;box-shadow:0 4px 16px rgba(0,0,0,.35);cursor:default;user-select:none;-webkit-user-select:none;" +
  "max-width:calc(100vw - 24px);}" +
  "#bugreport-indicator .br-dot{width:8px;height:8px;border-radius:50%;background:#ef4444;box-shadow:0 0 6px #ef4444;" +
  "flex-shrink:0;animation:br-pulse 1.4s infinite;}" +
  "#bugreport-indicator.br-paused .br-dot{background:#9ca3af;box-shadow:none;animation:none;}" +
  "#bugreport-indicator .br-counts{white-space:nowrap;cursor:pointer;}" +
  "#bugreport-indicator .br-counts b{color:#38bdf8;font-weight:700;}" +
  "#bugreport-indicator .br-actions{display:flex;align-items:center;gap:6px;max-width:0;overflow:hidden;opacity:0;" +
  "transition:max-width .2s ease,opacity .2s ease;}" +
  "#bugreport-indicator:hover .br-actions,#bugreport-indicator.br-open .br-actions{max-width:240px;opacity:1;}" +
  "#bugreport-indicator button{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.35);" +
  "border-radius:999px;font:11px/1 sans-serif;padding:3px 8px;cursor:pointer;white-space:nowrap;}" +
  "#bugreport-indicator button:hover{border-color:#38bdf8;color:#38bdf8;}" +
  "@keyframes br-pulse{0%,100%{opacity:1}50%{opacity:.35}}";

function ensureIndicatorStyle() {
  if (document.getElementById(INDICATOR_STYLE_ID)) return;
  var style = document.createElement("style");
  style.id = INDICATOR_STYLE_ID;
  style.textContent = INDICATOR_CSS;
  (document.head || document.documentElement).appendChild(style);
}

function sendToBackground(message) {
  try {
    return chrome.runtime.sendMessage(message).catch(function () { return null; });
  } catch (e) {
    return Promise.resolve(null);
  }
}

function flashBarTip(text) {
  if (!_countsEl) return;
  _countsEl.textContent = text;
  setTimeout(function () {
    if (_countsEl) updateRecordingIndicatorCounts();
  }, 2000);
}

function openPanelFromPage() {
  sendToBackground({ action: "openSidePanel" }).then(function (response) {
    if (response && !response.success) flashBarTip("请点击扩展图标打开面板");
  });
}

function togglePauseFromPage() {
  var next = !_isPaused;
  _isPaused = next;
  renderRecordingIndicator();
  sendToBackground({ action: "setRecordingPaused", paused: next }).then(function (response) {
    if (response && !response.success) {
      _isPaused = !next;
      renderRecordingIndicator();
      flashBarTip(response.error || "暂停失败");
    }
  });
}

function captureFromPage() {
  flashBarTip("正在截图...");
  sendToBackground({ action: "captureTab" }).then(function (response) {
    flashBarTip(response && response.success ? "截图已保存" : ("截图失败：" + ((response && response.error) || "未知错误")));
  });
}

function stopFromPage() {
  sendToBackground({ action: "stopRecordingRequest" });
}

function makeBarButton(label, handler) {
  var button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    handler();
  });
  return button;
}

function showRecordingIndicator() {
  if (window.top !== window) return;  // 只在顶层页面显示，避免 iframe 重复
  if (!document.body) {
    document.addEventListener("DOMContentLoaded", function () {
      if (_isRecording) showRecordingIndicator();
    }, { once: true });
    return;
  }
  if (_indicator) {
    renderRecordingIndicator();
    return;
  }

  ensureIndicatorStyle();

  var bar = document.createElement("div");
  bar.id = "bugreport-indicator";
  bar.title = "Bug Report Generator 录制中";

  var dot = document.createElement("span");
  dot.className = "br-dot";

  var counts = document.createElement("span");
  counts.className = "br-counts";
  counts.title = "打开扩展面板";
  counts.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    openPanelFromPage();
  });

  var actions = document.createElement("span");
  actions.className = "br-actions";
  var pauseBtn = makeBarButton("暂停", togglePauseFromPage);
  actions.appendChild(pauseBtn);
  actions.appendChild(makeBarButton("截图", captureFromPage));
  actions.appendChild(makeBarButton("停止", stopFromPage));

  bar.appendChild(dot);
  bar.appendChild(counts);
  bar.appendChild(actions);
  document.body.appendChild(bar);

  _indicator = bar;
  _countsEl = counts;
  _pauseBtn = pauseBtn;
  renderRecordingIndicator();
}

function renderRecordingIndicator() {
  if (!_indicator) return;
  _indicator.classList.toggle("br-paused", _isPaused);
  if (_pauseBtn) _pauseBtn.textContent = _isPaused ? "继续" : "暂停";
  updateRecordingIndicatorCounts();
}

function updateRecordingIndicatorCounts() {
  if (!_countsEl) return;
  _countsEl.innerHTML = "步骤 <b>" + _stats.steps + "</b> · 接口 <b>" + _stats.logs +
    "</b> · 截图 <b>" + _stats.screenshots + "</b>" + (_isPaused ? " · 已暂停" : "");
}

function hideRecordingIndicator() {
  if (_indicator && _indicator.parentNode) {
    _indicator.parentNode.removeChild(_indicator);
  }
  _indicator = null;
  _countsEl = null;
  _pauseBtn = null;
}

// ===== 步骤保存 =====
function saveStep(step) {
  if (_contextInvalid) return;
  try {
    // 注入页面上下文，供 AI 标题生成时定位模块/页面
    step.pageUrl = step.pageUrl || window.location.href;
    step.pageTitle = step.pageTitle || (document.title || "");
    safeStorageGet(["steps"], function(result) {
      if (_contextInvalid) return;
      var steps = result.steps || [];
      steps.push(step);
      safeStorageSet({ steps: steps }, function() {
        if (chrome.runtime.lastError) {
          console.error("[BugReport] ❌ 保存失败:", chrome.runtime.lastError.message);
        } else {
          console.log("[BugReport] ✅ 步骤已保存, 当前共", steps.length, "条");
          sendToBackground({ action: "recordedStep" });
        }
      });
    });
  } catch(e) {
    console.error("[BugReport] ❌ saveStep 异常:", e.message);
  }
}

// ===== XPath =====
function getXPath(element) {
  try {
    if (!element || !element.parentNode) return "N/A";
    if (element.id) return '//*[@id="' + element.id + '"]';
    if (element === document.body) return "/html/body";
    var siblings = Array.from(element.parentNode.children);
    var sameTagSiblings = siblings.filter(function(s) { return s.tagName === element.tagName; });
    var index = sameTagSiblings.indexOf(element) + 1;
    return getXPath(element.parentNode) + "/" + element.tagName.toLowerCase() + "[" + index + "]";
  } catch (e) { return "N/A"; }
}

// ===== 获取输入字段的关联标签文字 =====
function getFieldLabel(element) {
  if (!element) return "";
  var tag = element.tagName ? element.tagName.toUpperCase() : "";
  var type = (element.type || "").toLowerCase();
  if (tag === "INPUT" && (type === "radio" || type === "checkbox")) {
    var antdFieldLabel = getAntdFormItemLabel(element);
    if (antdFieldLabel) return antdFieldLabel;
  }
  // 1. aria-label
  var al = element.getAttribute("aria-label");
  if (al && al.trim()) return al.trim();
  // 2. aria-labelledby
  var alb = element.getAttribute("aria-labelledby");
  if (alb) {
    var ids = alb.split(/\s+/);
    for (var ai = 0; ai < ids.length; ai++) {
      var ref = document.getElementById(ids[ai]);
      if (ref && ref.textContent) return ref.textContent.trim();
    }
  }
  // 2. 原生 labels 关联
  if (element.labels && element.labels.length) {
    for (var li = 0; li < element.labels.length; li++) {
      var labelNode = element.labels[li];
      if (labelNode && labelNode.textContent && labelNode.textContent.trim()) {
        return labelNode.textContent.trim();
      }
    }
  }
  // 3. 最近的 label 包裹
  if (element.closest) {
    var closestLabel = element.closest("label");
    if (closestLabel && closestLabel.textContent && closestLabel.textContent.trim()) {
      return closestLabel.textContent.trim();
    }
  }
  // 4. label[for="id"]
  if (element.id) {
    var labelEl = document.querySelector("label[for='" + element.id.replace(/'/g, "\\'") + "']");
    if (labelEl && labelEl.textContent) return labelEl.textContent.trim();
  }
  // 4.1 Ant Design 表单项 label
  var antdLabel = getAntdFormItemLabel(element);
  if (antdLabel) return antdLabel;
  // 5. 外层 label 包裹
  var parent = element.parentElement;
  while (parent) {
    if (parent.tagName === "LABEL") {
      var txt = parent.textContent.replace(element.textContent || "", "").trim();
      if (txt) return txt;
      break;
    }
    parent = parent.parentElement;
  }
  // 6. placeholder
  if (element.placeholder && element.placeholder.trim()) return element.placeholder.trim();
  // 7. title
  if (element.title && element.title.trim()) return element.title.trim();
  // 8. name / id 作为兜底
  if (element.name) return "[" + element.name + "]";
  if (element.id) return "[" + element.id + "]";
  return "";
}

function normalizeDisplayText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function getAntdFormItemLabel(element) {
  if (!element || !element.closest) return "";
  var formItem = element.closest(".ant-form-item");
  if (!formItem) return "";

  var labelNode = formItem.querySelector(".ant-form-item-label label");
  if (labelNode && labelNode.textContent && labelNode.textContent.trim()) {
    return normalizeDisplayText(labelNode.textContent);
  }

  var labelWrap = formItem.querySelector(".ant-form-item-label");
  if (labelWrap && labelWrap.textContent && labelWrap.textContent.trim()) {
    return normalizeDisplayText(labelWrap.textContent);
  }

  return "";
}

function isAntdSelectOption(element) {
  return !!(element && element.closest && element.closest(".ant-select-item-option,[role='option']"));
}

function isAntdRadioCheckboxWrapper(element) {
  return !!(element && element.closest && element.closest("label.ant-radio-wrapper, label.ant-checkbox-wrapper"));
}

function getAntdSelectOptionText(element) {
  if (!element || !element.closest) return "";
  var option = element.closest(".ant-select-item-option,[role='option']");
  if (!option) return "";
  var optionText = option.querySelector(".ant-select-item-option-content");
  if (optionText && optionText.textContent && optionText.textContent.trim()) {
    return normalizeDisplayText(optionText.textContent);
  }
  if (option.textContent && option.textContent.trim()) {
    return normalizeDisplayText(option.textContent);
  }
  return "";
}

function getAntdSelectInputByOption(element) {
  if (!element || !element.closest) return null;
  var option = element.closest(".ant-select-item-option,[role='option']");
  if (!option) return null;
  var listbox = option.closest("[role='listbox'],[id$='_list']");
  if (!listbox || !listbox.id) return null;

  var inputs = document.querySelectorAll("input[aria-controls], input[aria-owns]");
  for (var i = 0; i < inputs.length; i++) {
    var input = inputs[i];
    if (!input || !input.getAttribute) continue;
    if (input.getAttribute("aria-controls") === listbox.id || input.getAttribute("aria-owns") === listbox.id) {
      return input;
    }
  }
  return null;
}

function getRadioCheckboxOptionText(element) {
  if (!element || !element.closest) return "";
  var wrapper = element.closest("label.ant-radio-wrapper, label.ant-checkbox-wrapper");
  if (!wrapper) return "";
  if (wrapper.textContent && wrapper.textContent.trim()) {
    return normalizeDisplayText(wrapper.textContent);
  }
  return "";
}

function getTextFromIdRefs(attrValue) {
  if (!attrValue) return "";
  var ids = String(attrValue).split(/\s+/);
  var texts = [];
  for (var i = 0; i < ids.length; i++) {
    var ref = document.getElementById(ids[i]);
    if (ref && ref.textContent) {
      var txt = ref.textContent.trim();
      if (txt) texts.push(txt);
    }
  }
  return texts.join(" ").trim();
}

function getSvgText(svgEl) {
  if (!svgEl || !svgEl.querySelector) return "";
  var titleEl = svgEl.querySelector("title");
  if (titleEl && titleEl.textContent && titleEl.textContent.trim()) {
    return titleEl.textContent.trim();
  }
  var descEl = svgEl.querySelector("desc");
  if (descEl && descEl.textContent && descEl.textContent.trim()) {
    return descEl.textContent.trim();
  }
  return "";
}

function getAccessibleName(element) {
  if (!element || !element.getAttribute) return "";

  var ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

  var ariaLabelledBy = element.getAttribute("aria-labelledby");
  var labelledText = getTextFromIdRefs(ariaLabelledBy);
  if (labelledText) return labelledText;

  var title = element.getAttribute("title");
  if (title && title.trim()) return title.trim();

  var tag = element.tagName ? element.tagName.toUpperCase() : "";
  if (tag === "SVG") {
    var svgText = getSvgText(element);
    if (svgText) return svgText;
  } else if (element.ownerSVGElement) {
    var ownerSvgText = getSvgText(element.ownerSVGElement);
    if (ownerSvgText) return ownerSvgText;
  }

  return "";
}

function getControlDisplayText(element) {
  if (!element || !element.tagName) return "";

  var tag = element.tagName.toUpperCase();
  var type = (element.type || "").toLowerCase();

  // 单选框 / 复选框优先拿关联文案，避免落到默认值 on / ON
  if (tag === "INPUT" && (type === "checkbox" || type === "radio")) {
    return getFieldLabel(element) || getAccessibleName(element) || "";
  }

  var semanticText = getAccessibleName(element) || getFieldLabel(element);
  if (semanticText) return semanticText;

  if (tag === "INPUT") {
    var rawValue = (element.value || "").trim();
    if (type === "button" || type === "submit" || type === "reset" || type === "image") {
      return rawValue || "";
    }

    // 对普通输入框仍保留 value / placeholder 兜底
    var placeholder = (element.placeholder || "").trim();
    if (placeholder) return placeholder;
    if (rawValue && rawValue.toLowerCase() !== "on") return rawValue;
    return (element.title || "").trim();
  }

  return "";
}

function getSelectDisplayText(selectEl) {
  if (!selectEl || selectEl.tagName !== "SELECT") return "";

  if (selectEl.selectedOptions && selectEl.selectedOptions.length) {
    for (var i = 0; i < selectEl.selectedOptions.length; i++) {
      var opt = selectEl.selectedOptions[i];
      if (opt && opt.textContent && opt.textContent.trim()) {
        return opt.textContent.trim();
      }
    }
  }

  if (selectEl.options && selectEl.options.length) {
    for (var j = 0; j < selectEl.options.length; j++) {
      var option = selectEl.options[j];
      if (option && option.selected && option.textContent && option.textContent.trim()) {
        return option.textContent.trim();
      }
    }
  }

  return getFieldLabel(selectEl) || getAccessibleName(selectEl) || (selectEl.title || "").trim();
}

function getControlLabel(element) {
  if (!element) return "";
  if (element.tagName === "SELECT") return getFieldLabel(element) || getAccessibleName(element) || "下拉选择";
  if (element.tagName === "INPUT") {
    var type = (element.type || "").toLowerCase();
    if (type === "radio" || type === "checkbox") {
      return getFieldLabel(element) || getAccessibleName(element) || getInputLabel(element);
    }
    return getFieldLabel(element) || getAccessibleName(element) || getInputLabel(element);
  }
  return getFieldLabel(element) || getAccessibleName(element) || getTagNameCn(element.tagName);
}

function getControlValueText(element) {
  if (!element || !element.tagName) return "";

  var tag = element.tagName.toUpperCase();
  var type = (element.type || "").toLowerCase();

  if (tag === "SELECT") {
    return getSelectDisplayText(element);
  }

  if (tag === "INPUT") {
    if (type === "checkbox" || type === "radio") {
      return getRadioCheckboxOptionText(element) || (element.checked ? "已选择" : "已取消选择");
    }

    if (type === "password") return "********";

    var inputValue = (element.value || "").trim();
    if (inputValue && inputValue.toLowerCase() !== "on") return inputValue;
    return "";
  }

  if (tag === "TEXTAREA") {
    return (element.value || "").trim();
  }

  var antSelect = element.closest && element.closest(".ant-select");
  if (antSelect) {
    var selectedItem = antSelect.querySelector(".ant-select-selection-item");
    if (selectedItem && selectedItem.textContent && selectedItem.textContent.trim()) {
      return normalizeDisplayText(selectedItem.textContent);
    }
    var selectedSearch = antSelect.querySelector(".ant-select-selection-search-input");
    if (selectedSearch && selectedSearch.value && String(selectedSearch.value).trim()) {
      return String(selectedSearch.value).trim();
    }
  }

  return "";
}

function isInteractiveElement(element) {
  if (!element || !element.tagName) return false;

  var tag = element.tagName.toUpperCase();
  if (tag === "BUTTON" || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }

  if (tag === "A" && element.href) {
    return true;
  }

  var role = element.getAttribute && element.getAttribute("role");
  if (role) {
    role = role.toLowerCase();
    if (role === "button" || role === "link" || role === "menuitem" || role === "tab" || role === "switch" || role === "checkbox" || role === "radio") {
      return true;
    }
  }

  if (element.isContentEditable) {
    return true;
  }

  return false;
}

function isSvgLikeTarget(element) {
  if (!element || !element.tagName) return false;
  var tag = element.tagName.toUpperCase();
  return tag === "SVG" || tag === "PATH" || tag === "USE" || tag === "G" ||
    tag === "RECT" || tag === "CIRCLE" || tag === "POLYGON" || tag === "TEXT" ||
    tag === "TSPAN" || tag === "LINE" || tag === "ELLIPSE";
}

function resolveMeaningfulTarget(target) {
  if (!target || target.nodeType !== 1) return target;

  var selector = "button,a[href],input,textarea,select,[role='button'],[role='link'],[role='menuitem'],[role='tab'],[role='switch'],[role='checkbox'],[role='radio'],[contenteditable='true']";
  if (target.closest) {
    var semantic = target.closest(selector);
    if (semantic) return semantic;
  }

  if (isSvgLikeTarget(target)) {
    var node = target;
    while (node && node.parentElement && node.parentElement !== document.body && node.parentElement !== document.documentElement) {
      node = node.parentElement;
      if (isInteractiveElement(node)) return node;
    }
  }

  var meaningfulTarget = target;
  while (meaningfulTarget && meaningfulTarget.parentElement &&
         meaningfulTarget.parentElement !== document.body &&
         meaningfulTarget.parentElement !== document.documentElement) {
    var tag = meaningfulTarget.tagName;
    // 跳过纯装饰 / 非交互标签
    if (NON_INTERACTIVE_TAGS[tag]) {
      meaningfulTarget = meaningfulTarget.parentElement;
      continue;
    }
    // <a> 无 href 视为占位
    if (tag === "A" && !meaningfulTarget.href) {
      meaningfulTarget = meaningfulTarget.parentElement;
      continue;
    }
    // role="presentation" 或 "none" 跳过
    var role = meaningfulTarget.getAttribute && meaningfulTarget.getAttribute("role");
    if (role === "presentation" || role === "none") {
      meaningfulTarget = meaningfulTarget.parentElement;
      continue;
    }
    break;
  }

  return meaningfulTarget || target;
}

// ===== 基于点击坐标智能提取文字 =====
function getClickText(clientX, clientY, el) {
  // 方法1: caretRangeFromPoint 精确定位到字符
  try {
    var range = document.caretRangeFromPoint(clientX, clientY);
    if (range && range.startContainer) {
      var node = range.startContainer;
      if (node.nodeType === 3) {
        var txt = node.textContent.trim();
        if (txt && txt.length <= 60) return txt;
        // 文字太长则取点击位置附近的片段
        var off = range.startOffset;
        var left = Math.max(0, off - 15), right = Math.min(txt.length, off + 15);
        return txt.substring(left, right).trim();
      }
      // 某些情况下 startContainer 是元素节点，取其文本
      var elTxt = (node.textContent || "").trim();
      if (elTxt && elTxt.length <= 60) return elTxt;
    }
  } catch(e) {}

  // 方法2: 基于元素类型提取
  if (!el) return "";
  try {
    var controlText = getControlDisplayText(el);
    if (controlText) return controlText.substring(0, 40);

  var tag = el.tagName;
  if (tag === "SELECT") {
    var selectText = getSelectDisplayText(el);
    if (selectText) return selectText.substring(0, 40);
  }
  if (tag === "INPUT") {
    var inputType = (el.type || "").toLowerCase();
    if (inputType === "checkbox" || inputType === "radio") {
      var inputLabelText = getFieldLabel(el) || getAccessibleName(el);
      if (inputLabelText) return inputLabelText.substring(0, 40);
        return "";
      }
    }
    var CT = {DIV:1,SPAN:1,SECTION:1,HEADER:1,FOOTER:1,NAV:1,MAIN:1,ASIDE:1,ARTICLE:1,P:1,OL:1,UL:1,LI:1,DL:1,DT:1,DD:1,TABLE:1,FORM:1,FIELDSET:1};
    if (CT[tag]) {
      var dt = el.getAttribute && el.getAttribute("aria-label");
      if (!dt) dt = el.title;
      if (!dt) {
        var c = el.childNodes;
        for (var i = 0; i < c.length; i++) {
          if (c[i].nodeType === 3 && c[i].textContent.trim()) { dt = c[i].textContent.trim(); break; }
        }
      }
      return dt || "";
    }

    var text = (el.innerText || "").trim();
    if (text) return text.substring(0, 40);

    var title = (el.title || "").trim();
    if (title) return title.substring(0, 40);

    var value = (el.value || "").trim();
    if (value && value.toLowerCase() !== "on") return value.substring(0, 40);

    return "";
  } catch(e) { return ""; }
}

// ===== 非交互标签（上溯时跳过） =====
var NON_INTERACTIVE_TAGS = {
  SPAN:1, I:1, EM:1, STRONG:1, B:1, SMALL:1, U:1, CODE:1,
  SVG:1, PATH:1, USE:1, G:1, RECT:1, CIRCLE:1, POLYGON:1,
  TEXT:1, TSPAN:1, MARK:1, INS:1, DEL:1, SUB:1, SUP:1,
  ABBR:1, BDI:1, BDO:1, BR:1, CITE:1, DATA:1, DFN:1,
  KBD:1, MAP:1, METER:1, NOSCRIPT:1, OBJECT:1, OUTPUT:1,
  PICTURE:1, Q:1, RP:1, RT:1, RUBY:1, S:1, SAMP:1,
  SLOT:1, SOURCE:1, STRIKE:1, TEMPLATE:1, TIME:1, TT:1, VAR:1, WBR:1
};

// ===== 快速点击防抖 (300ms) =====
var _lastClickTarget = null;
var _lastClickTime = 0;

// ===== 点击事件记录 =====
document.addEventListener("click", function(e) {
  if (!_isRecording || _isPaused || _contextInvalid) return;
  if (_indicator && _indicator.contains(e.target)) return;
  var target = e.target;
  if (!target) return;
  var targetTag = target.tagName ? target.tagName.toUpperCase() : "";
  if (targetTag === "SELECT") return;
  if (targetTag === "INPUT") {
    var targetType = (target.type || "").toLowerCase();
    if (targetType === "checkbox" || targetType === "radio") return;
  }

  // 快速连续点击同一元素防抖
  var now = Date.now();
  if (target === _lastClickTarget && now - _lastClickTime < 300) {
    _lastClickTime = now;
    return;
  }
  _lastClickTarget = target;
  _lastClickTime = now;

  // 向上查找有意义元素，SVG 图标优先回落到语义化容器
  var meaningfulTarget = resolveMeaningfulTarget(target);

  var label = getControlLabel(meaningfulTarget);

  var text = getClickText(e.clientX, e.clientY, meaningfulTarget);
  if (!text) {
    text = getAccessibleName(meaningfulTarget) || getAccessibleName(target);
  }
  if (!text && (meaningfulTarget.tagName === "INPUT" || meaningfulTarget.tagName === "TEXTAREA" || meaningfulTarget.tagName === "SELECT")) {
    text = getFieldLabel(meaningfulTarget);
  }

  saveStep({
    type: "click",
    tagName: meaningfulTarget.tagName,
    tagNameCn: label,
    fieldLabel: label,
    fieldValue: getControlValueText(meaningfulTarget) || text || "",
    id: meaningfulTarget.id || "",
    className: typeof meaningfulTarget.className === "string" ? meaningfulTarget.className : "",
    text: text,
    xpath: getXPath(meaningfulTarget),
    timestamp: new Date().toISOString()
  });
}, true);

// ===== 输入事件记录（统一 input + 防抖 400ms）=====
var _inputTimer = null;
var _inputTarget = null;

document.addEventListener("input", function(e) {
  if (!_isRecording || _isPaused || _contextInvalid) return;
  if (_indicator && _indicator.contains(e.target)) return;
  var target = e.target;
  if (!target) return;
  if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") return;
  var inputType = (target.type || "").toLowerCase();
  if (target.tagName === "INPUT" && (inputType === "checkbox" || inputType === "radio")) return;

  _inputTarget = target;
  clearTimeout(_inputTimer);
  _inputTimer = setTimeout(function() {
    if (!_isRecording || _isPaused || !_inputTarget || _contextInvalid) return;
    var currentType = (_inputTarget.type || "").toLowerCase();
    if (_inputTarget.tagName === "INPUT" && (currentType === "checkbox" || currentType === "radio")) return;
    saveStep({
      type: "input",
      tagName: _inputTarget.tagName,
      tagNameCn: getFieldLabel(_inputTarget) || getAccessibleName(_inputTarget) || getInputLabel(_inputTarget),
      fieldLabel: getFieldLabel(_inputTarget) || getAccessibleName(_inputTarget) || getInputLabel(_inputTarget),
      fieldValue: _inputTarget.type === "password" ? "********" : (_inputTarget.value || ""),
      id: _inputTarget.id || "",
      name: _inputTarget.name || "",
      inputType: e ? (e.inputType || "") : "",
      value: _inputTarget.type === "password" ? "********" : (_inputTarget.value || ""),
      timestamp: new Date().toISOString()
    });
    _inputTarget = null;
  }, 400);
}, true);

// ===== Change 事件记录（select / checkbox / radio）=====
document.addEventListener("change", function(e) {
  if (!_isRecording || _isPaused || _contextInvalid) return;
  if (_indicator && _indicator.contains(e.target)) return;
  var target = e.target;
  if (!target) return;

  if (target.tagName === "SELECT") {
    var selectedTexts = Array.from(target.selectedOptions).map(function(o) { return (o.textContent || o.text || "").trim(); }).filter(Boolean);
    saveStep({
      type: "select",
      tagName: "SELECT",
      tagNameCn: getControlLabel(target),
      fieldLabel: getControlLabel(target),
      fieldValue: selectedTexts.join(", ") || getSelectDisplayText(target),
      id: target.id || "",
      name: target.name || "",
      value: selectedTexts.join(", ") || getSelectDisplayText(target),
      timestamp: new Date().toISOString()
    });
  } else if (target.tagName === "INPUT" && (target.type === "checkbox" || target.type === "radio")) {
    saveStep({
      type: "toggle",
      tagName: "INPUT",
      tagNameCn: getAntdFormItemLabel(target) || getFieldLabel(target) || getAccessibleName(target) || getControlLabel(target),
      fieldLabel: getAntdFormItemLabel(target) || getFieldLabel(target) || getAccessibleName(target) || getControlLabel(target),
      fieldValue: getRadioCheckboxOptionText(target) || (target.checked ? "已选择" : "已取消选择"),
      id: target.id || "",
      name: target.name || "",
      value: getRadioCheckboxOptionText(target) || (target.checked ? "已选择" : "已取消选择"),
      timestamp: new Date().toISOString()
    });
  }
}, true);

console.log("[BugReport] ========== Content Script 初始化完成 ==========");
