// settings.js - 设置页面

document.addEventListener("DOMContentLoaded", function() {
  // 左侧：自动截图
  var enableToggle = document.getElementById("enableAutoCapture");
  var delayInput = document.getElementById("captureDelay");
  var ruleList = document.getElementById("ruleList");
  var addRuleBtn = document.getElementById("addRule");
  var saveBtn = document.getElementById("saveSettings");
  var saveStatus = document.getElementById("saveStatus");

  // 右侧：LLM 配置
  var llmEnabled = document.getElementById("llmEnabled");
  var llmApiUrl = document.getElementById("llmApiUrl");
  var llmApiKey = document.getElementById("llmApiKey");
  var llmModel = document.getElementById("llmModel");
  var llmPrompt = document.getElementById("titlePrompt");
  var resetPromptBtn = document.getElementById("resetPrompt");
  var testBtn = document.getElementById("testLlmConn");
  var testStatus = document.getElementById("testLlmStatus");

  // 截图存储
  var shotCompress = document.getElementById("shotCompress");
  var shotQuality = document.getElementById("shotQuality");
  var shotQualityValue = document.getElementById("shotQualityValue");
  var clearScreenshotsBtn = document.getElementById("clearScreenshots");
  var storageFill = document.getElementById("storageFill");
  var storageText = document.getElementById("storageText");
  var shortcutHint = document.getElementById("shortcutHint");

  var rules = [];

  // ===== URL 自动规范化（适配 new-api 中转站与各种输入习惯） =====
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

  // ===== 初始化 =====
  chrome.storage.local.get(["autoCapture", "llmConfig", "screenshotConfig"], function(result) {
    // 自动截图配置
    var config = result.autoCapture || { enabled: true, delay: 500, rules: [] };
    enableToggle.checked = config.enabled;
    delayInput.value = config.delay || 500;
    rules = config.rules || [];
    renderRules();

    // LLM 配置
    var llm = result.llmConfig || {};
    llmEnabled.checked = !!llm.enabled;
    llmApiUrl.value = llm.apiUrl || "";
    llmApiKey.value = llm.apiKey || "";
    llmModel.value = llm.model || "";
    llmPrompt.value = llm.prompt || DEFAULT_TITLE_PROMPT;

    // 截图存储配置
    var shot = result.screenshotConfig || {};
    shotCompress.checked = shot.compress !== false;
    var shotQualityValueInit = typeof shot.quality === "number" ? shot.quality : 0.75;
    shotQuality.value = shotQualityValueInit;
    shotQualityValue.textContent = Math.round(shotQualityValueInit * 100) + "%";
    refreshStorageUsage();
    renderShortcutHint();

    // 按当前实际渲染高度，固定三张卡片为等高
    fixCardHeights();
  });

  // ===== 渲染规则列表 =====
  function renderRules() {
    if (rules.length === 0) {
      ruleList.innerHTML = '<p class="no-rules">暂无规则，点击上方按钮添加</p>';
      return;
    }

    var html = "";
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      html += '<div class="rule-item" data-index="' + i + '">' +
        '<div class="rule-header">' +
          '<input type="text" class="rule-name" value="' + esc(rule.name) + '" placeholder="规则名称">' +
          '<label class="toggle-small">' +
            '<input type="checkbox" class="rule-enabled" ' + (rule.enabled ? 'checked' : '') + '>' +
            '<span class="toggle-slider-small"></span>' +
          '</label>' +
          '<button class="btn-delete" title="删除规则">&times;</button>' +
        '</div>' +
        '<textarea class="rule-expression" placeholder="输入表达式，如: status >= 400 || (body && body.code !== 0)">' + esc(rule.expression) + '</textarea>' +
      '</div>';
    }
    ruleList.innerHTML = html;

    // 绑定事件
    var ruleItems = ruleList.querySelectorAll(".rule-item");
    ruleItems.forEach(function(item) {
      var index = parseInt(item.getAttribute("data-index"));
      
      item.querySelector(".btn-delete").addEventListener("click", function() {
        rules.splice(index, 1);
        renderRules();
      });

      item.querySelector(".rule-name").addEventListener("input", function(e) {
        rules[index].name = e.target.value;
      });

      item.querySelector(".rule-expression").addEventListener("input", function(e) {
        rules[index].expression = e.target.value;
      });

      item.querySelector(".rule-enabled").addEventListener("change", function(e) {
        rules[index].enabled = e.target.checked;
      });
    });
  }

  // ===== 按当前实际高度固定三张卡片（取最高卡片的高度） =====
  function fixCardHeights() {
    var cards = document.querySelectorAll(".settings-columns .settings-card");
    if (!cards.length) return;
    // 先回到自然高度，再测量最高者
    for (var i = 0; i < cards.length; i++) {
      cards[i].style.height = "auto";
    }
    var maxH = 0;
    for (var j = 0; j < cards.length; j++) {
      var h = cards[j].offsetHeight;
      if (h > maxH) maxH = h;
    }
    if (maxH > 0) {
      for (var k = 0; k < cards.length; k++) {
        cards[k].style.height = maxH + "px";
      }
    }
  }

  // ===== 添加规则 =====
  addRuleBtn.addEventListener("click", function() {
    rules.push({
      name: "规则 " + (rules.length + 1),
      expression: "status >= 400",
      enabled: true
    });
    renderRules();
  });

  // ===== 测试 LLM API 连接 =====
  if (testBtn) {
    testBtn.addEventListener("click", function() {
      var rawUrl = llmApiUrl.value.trim();
      var apiKey = llmApiKey.value.trim();
      var model = llmModel.value.trim() || "gpt-3.5-turbo";

      if (!rawUrl) {
        testStatus.textContent = "请先填写 API 地址";
        testStatus.className = "test-status error";
        return;
      }
      if (!apiKey) {
        testStatus.textContent = "请先填写 API Key";
        testStatus.className = "test-status error";
        return;
      }

      var fullUrl = normalizeApiUrl(rawUrl);
      // 如果输入的是简写，静默更新输入框为完整 URL 以便直观确认
      llmApiUrl.value = fullUrl;

      testBtn.disabled = true;
      testStatus.textContent = "正在连接中转站测试...";
      testStatus.className = "test-status testing";

      var startTime = Date.now();

      fetch(fullUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + apiKey
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 5,
          temperature: 0.1
        })
      })
      .then(function(res) {
        var elapsed = Date.now() - startTime;
        if (!res.ok) {
          return res.text().then(function(errText) {
            var msg = "HTTP " + res.status;
            try {
              var errJson = JSON.parse(errText);
              if (errJson.error && errJson.error.message) {
                msg += ": " + errJson.error.message;
              }
            } catch (e) {}
            throw new Error(msg);
          });
        }
        return res.json().then(function(data) {
          return { data: data, elapsed: elapsed };
        });
      })
      .then(function(result) {
        testStatus.textContent = "连接成功！响应正常 ✓ (" + result.elapsed + "ms)";
        testStatus.className = "test-status success";
      })
      .catch(function(err) {
        testStatus.textContent = "连接失败: " + err.message;
        testStatus.className = "test-status error";
      })
      .finally(function() {
        testBtn.disabled = false;
      });
    });
  }

  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== "local") return;
    if (changes.screenshots) refreshStorageUsage();
  });

  // ===== 截图存储 =====

  function refreshStorageUsage() {
    chrome.storage.local.getBytesInUse(null, function (bytes) {
      if (chrome.runtime.lastError) {
        storageText.textContent = "无法读取存储占用";
        return;
      }
      renderStorageUsage(bytes || 0);
    });
  }

  function renderStorageUsage(bytes) {
    var quota = 10 * 1024 * 1024;
    var percent = Math.min(100, Math.round(bytes / quota * 100));
    storageFill.style.width = percent + "%";
    storageFill.className = "storage-fill" + (percent >= 80 ? " warn" : "");
    storageText.textContent = formatBytes(bytes) + " / 10 MB（" + percent + "%）" +
      (percent >= 80 ? "，接近上限，建议清理截图" : "");
    storageText.className = "setting-hint" + (percent >= 80 ? " storage-warn" : "");
  }

  function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + " MB";
    if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
    return bytes + " B";
  }

  shotQuality.addEventListener("input", function () {
    shotQualityValue.textContent = Math.round((parseFloat(shotQuality.value) || 0.75) * 100) + "%";
  });

  clearScreenshotsBtn.addEventListener("click", function () {
    if (!confirm("确定清理所有已捕获的截图吗？")) return;
    chrome.storage.local.set({ screenshots: [] }, function () {
      refreshStorageUsage();
    });
  });

  function renderShortcutHint() {
    if (!chrome.commands || !chrome.commands.getAll) return;
    chrome.commands.getAll(function (commands) {
      var labels = {
        "toggle-recording": "录制",
        "capture-screenshot": "截图",
        "open-panel": "面板"
      };
      var parts = [];
      (commands || []).forEach(function (command) {
        if (!labels[command.name]) return;
        parts.push(labels[command.name] + " " + (command.shortcut || "未绑定"));
      });
      shortcutHint.textContent = parts.length
        ? "快捷键：" + parts.join(" · ") + "（可在 chrome://extensions/shortcuts 修改）"
        : "";
    });
  }

  // ===== 恢复默认 Prompt =====
  if (resetPromptBtn) {
    resetPromptBtn.addEventListener("click", function() {
      llmPrompt.value = DEFAULT_TITLE_PROMPT;
    });
  }

  // ===== 保存设置 =====
  saveBtn.addEventListener("click", function() {
    var config = {
      enabled: enableToggle.checked,
      delay: parseInt(delayInput.value) || 500,
      rules: rules
    };

    var rawUrl = llmApiUrl.value.trim();
    var formattedUrl = normalizeApiUrl(rawUrl);
    if (formattedUrl) {
      llmApiUrl.value = formattedUrl;
    }

    var llmConfig = {
      enabled: llmEnabled.checked,
      apiUrl: formattedUrl || rawUrl,
      apiKey: llmApiKey.value.trim(),
      model: llmModel.value.trim(),
      prompt: llmPrompt.value
    };

    var screenshotConfig = {
      compress: shotCompress.checked,
      quality: parseFloat(shotQuality.value) || 0.75
    };

    chrome.storage.local.set({
      autoCapture: config,
      llmConfig: llmConfig,
      screenshotConfig: screenshotConfig
    }, function() {
      if (chrome.runtime.lastError) {
        saveStatus.textContent = "保存失败: " + chrome.runtime.lastError.message;
        saveStatus.className = "save-status error";
      } else {
        saveStatus.textContent = "设置已保存 ✓";
        saveStatus.className = "save-status success";
        setTimeout(function() {
          saveStatus.textContent = "";
          saveStatus.className = "save-status";
        }, 2000);
      }
    });
  });

  // ===== HTML 转义 =====
  function esc(text) {
    if (!text) return "";
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
});
