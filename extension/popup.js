const st = document.getElementById("st");

function show() {
  chrome.runtime.sendMessage({ cmd: "ping_status" }, (r) => {
    if (!r) {
      st.innerHTML = '<span class="err">无法查询（后台未响应）</span>';
      return;
    }
    const lines = [];
    lines.push(r.up ? '<b>已连上</b>' : '<span class="err">未连上</span>');
    lines.push('Native Messaging: ' + (r.nm ? '开' : '关'));
    lines.push('队列轮询: ' + (r.polling ? '运行中' : '未运行'));
    if (!r.nm && !r.polling) {
      lines.push('<span class="err">两条路都没起来，点下面重连</span>');
    }
    if (r.lastError) {
      lines.push('<span class="err">' + String(r.lastError).slice(0, 160) + '</span>');
    }
    lines.push('<span style="opacity:.6">详细状态: node server.js status</span>');
    st.innerHTML = lines.join('<br>');
  });
}

document.getElementById("rc").addEventListener("click", () => {
  chrome.runtime.sendMessage({ cmd: "reconnect" }, () => {
    setTimeout(show, 1500);
  });
});

show();
setInterval(show, 5000);
