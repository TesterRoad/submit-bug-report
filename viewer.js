/* viewer.js · 独立大图预览
 * 依赖：chrome.storage.local 的临时占位 _viewerImg（由 popup 点击截图时写入）
 * 打开后：读占位 → 渲染 → 移除占位（避免泄露/占空间）
 */
(function () {
  "use strict";

  var TMP_KEY = "_viewerImg";

  var imgEl = document.getElementById("viewerImg");
  var stageEl = document.getElementById("viewerStage");
  var closeBtn = document.getElementById("viewerCloseBtn");
  var stateEl = document.getElementById("viewerState");

  function setState(text) {
    if (stateEl) stateEl.textContent = text;
  }

  function closeWindow() {
    try {
      window.close();
    } catch (e) {
      // 个别场景下 window.close 被策略拦截，退化为跳转 about:blank
      try {
        window.location.href = "about:blank";
      } catch (e2) { /* ignore */ }
    }
  }

  function setPlaceholder(opts) {
    if (!stageEl) return;
    var cls = "viewer-placeholder" + (opts.isError ? " error" : "");
    var html =
      '<div class="' + cls + '">' +
      "  <h4>" + (opts.title || "等待数据") + "</h4>" +
      "  <p>" + (opts.desc || "") + "</p>" +
      "</div>";
    // 清掉旧 img / placeholder
    while (stageEl.firstChild) stageEl.removeChild(stageEl.firstChild);
    stageEl.insertAdjacentHTML("afterbegin", html);
  }

  function loadImg(src) {
    if (!src) {
      setState("无数据");
      setPlaceholder({
        isError: true,
        title: "SCREENSHOT MISSING",
        desc: "未读取到截图数据，请返回上一步重新点击。",
      });
      return;
    }
    if (!imgEl) {
      setPlaceholder({
        isError: true,
        title: "DOM ERROR",
        desc: "图片节点丢失，无法渲染。",
      });
      return;
    }
    setState("加载中…");

    imgEl.onload = function () {
      imgEl.classList.remove("loading");
      imgEl.classList.add("loaded");
      var w = imgEl.naturalWidth || 0;
      var h = imgEl.naturalHeight || 0;
      setState("加载完成 · " + w + " × " + h + " px");
    };
    imgEl.onerror = function () {
      imgEl.classList.remove("loading");
      setState("加载失败");
      setPlaceholder({
        isError: true,
        title: "LOAD FAILED",
        desc: "截图数据无法解析，请返回上一步重新点击。",
      });
    };
    imgEl.src = src;
  }

  function cleanup(cb) {
    try {
      if (chrome && chrome.storage && chrome.storage.local && chrome.storage.local.remove) {
        chrome.storage.local.remove([TMP_KEY], function () {
          if (cb) cb();
        });
        return;
      }
    } catch (e) { /* ignore */ }
    if (cb) cb();
  }

  function readAndRender() {
    if (!chrome || !chrome.storage || !chrome.storage.local || !chrome.storage.local.get) {
      setState("环境异常");
      setPlaceholder({
        isError: true,
        title: "STORAGE UNAVAILABLE",
        desc: "无法访问扩展存储空间，该页面需作为扩展页面打开。",
      });
      return;
    }
    try {
      chrome.storage.local.get([TMP_KEY], function (res) {
        var src = res && res[TMP_KEY];
        if (!src) {
          setState("无待显示截图");
          setPlaceholder({
            isError: true,
            title: "NO PENDING SCREENSHOT",
            desc: "请返回扩展面板，点击报告中的截图以打开大图。",
          });
          return;
        }
        // 读完就清，避免同一截图残留；如果打开失败，用户可重新点击再生成
        cleanup(function () {
          loadImg(src);
        });
      });
    } catch (e) {
      setState("读取错误");
      setPlaceholder({
        isError: true,
        title: "READ ERROR",
        desc: String(e && e.message ? e.message : e),
      });
    }
  }

  // 交互：ESC / 按钮 / 点击舞台空白 → 关闭
  if (closeBtn) {
    closeBtn.addEventListener("click", function () {
      closeWindow();
    });
  }
  document.addEventListener("keydown", function (e) {
    if (e.keyCode === 27) {
      e.preventDefault();
      closeWindow();
    }
  });
  if (stageEl) {
    // 点舞台非图片区域（即空白）→ 关
    stageEl.addEventListener("click", function (e) {
      if (e.target === stageEl) closeWindow();
    });
  }
  // 防止误拖拽图片
  if (imgEl) {
    imgEl.addEventListener("dragstart", function (e) {
      e.preventDefault();
    });
    // 阻止浏览器右键另存时的默认拖拽菜单副作用
    imgEl.addEventListener("contextmenu", function () {
      /* 允许右键（复制/另存为），仅阻止冒泡副作用 */
    });
  }

  // 启动
  setState("读取数据…");
  readAndRender();
})();
