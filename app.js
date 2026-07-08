/* ============ AI 写作工作流 — 纯前端逻辑 ============ */
'use strict';

const OPERATIONS = {
  polish:  { label: '润色', prompt: '请润色下面文本，修正语病与错别字，提升流畅度，保持原意与长度大致不变：' },
  expand:  { label: '扩写', prompt: '请在不改变核心意思前提下扩写下面文本，补充细节与背景，使内容更丰富：' },
  shorten: { label: '缩写', prompt: '请缩写下面文本，保留核心信息与要点，删除冗余，尽量简短：' },
  summary: { label: '概括', prompt: '请用一两段话概括下面文本的主旨与要点：' },
  review:  { label: '点评', prompt: '请从内容、结构、表达等方面点评下面文本，指出优点与可改进之处：' },
  cont:    { label: '续写', prompt: '请接着下面文本继续写，保持文风、人物与主题一致，自然衔接，不要重复已有内容：' },
};

const STORE_KEY = 'aiwf_state_v1';
const SET_KEY = 'aiwf_settings_v1';

let state = { nodes: [], edges: [] };
const nodeEls = new Map();   // id -> DOM 元素
let seq = 1;
const uid = (p) => p + '_' + (Date.now().toString(36)) + '_' + (seq++);

/* 视图缩放（适配视图 / 1:1） */
const view = { scale: 1, tx: 0, ty: 0 };
function applyView() {
  const vp = $('#viewport');
  if (vp) vp.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
}

/* ---------- 工具 ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const canvas = $('#canvas');
const nodesLayer = $('#nodes-layer');
const edgeLayer = $('#edge-layer');

function getNode(id) { return state.nodes.find(n => n.id === id); }
function incomingOf(id) { return state.edges.filter(e => e.to === id); }
function outgoingOf(id) { return state.edges.filter(e => e.from === id); }

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) state = JSON.parse(raw);
  } catch (e) { /* 忽略损坏数据 */ }
  if (!state.nodes) state.nodes = [];
  if (!state.edges) state.edges = [];
}
function saveState() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
  markSaved();
}
let saveTimer = null;
function markSaved() {
  const el = $('#save-status');
  el.textContent = '已保存';
  el.classList.remove('dirty');
}
function markDirty() {
  const el = $('#save-status');
  el.textContent = '未保存…';
  el.classList.add('dirty');
}

/* ---------- 设置 ---------- */
function loadSettings() {
  try {
    const raw = localStorage.getItem(SET_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' };
}
function saveSettings(s) { localStorage.setItem(SET_KEY, JSON.stringify(s)); }

/* 文本框随内容自适应高度 */
function autoGrow(ta) {
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 640) + 'px';
}

/* ---------- 渲染 ---------- */
function renderAll() {
  // 移除已删节点 DOM
  for (const [id, el] of nodeEls) {
    if (!getNode(id)) { el.remove(); nodeEls.delete(id); }
  }
  // 创建/更新节点
  for (const node of state.nodes) renderNode(node.id);
  drawEdges();
}

function renderNode(id) {
  const node = getNode(id);
  if (!node) return;
  let el = nodeEls.get(id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'node ' + node.type;
    el.dataset.id = id;
    nodesLayer.appendChild(el);
    nodeEls.set(id, el);
    buildNodeInner(el, node);
  }
  el.style.left = node.x + 'px';
  el.style.top = node.y + 'px';

  // 更新字段（仅在非聚焦时写回，避免打断输入）
  const active = document.activeElement;
  if (node.type === 'input') {
    const ta = $('.content', el);
    if (active !== ta) { ta.value = node.content || ''; autoGrow(ta); }
  } else {
    const sel = $('.op-select', el);
    if (active !== sel) sel.value = node.operation;
    const inst = $('.instruction', el);
    if (active !== inst) inst.value = node.instruction || '';
    const out = $('.output', el);
    if (active !== out) { out.value = node.output || ''; autoGrow(out); }
    const btn = $('.run-btn', el);
    if (node.running) { btn.textContent = '运行中…'; btn.classList.add('running'); btn.disabled = true; }
    else { btn.textContent = '运行'; btn.classList.remove('running'); btn.disabled = false; }
    const histBtn = $('.hist-btn', el);
    if (histBtn) histBtn.textContent = '历史' + (node.history && node.history.length ? ' (' + node.history.length + ')' : '');
    updateUpPreview(el, node);
  }
}

function buildNodeInner(el, node) {
  const header = document.createElement('div');
  header.className = 'node-header';
  const title = document.createElement('span');
  title.className = 'node-title';
  title.textContent = node.type === 'input' ? '输入框' : 'AI 操作框';
  header.appendChild(title);

  const hActions = document.createElement('div');
  hActions.className = 'node-header-actions';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'node-copy';
  copyBtn.textContent = '复制';
  copyBtn.title = '复制此节点（偏移放置）';
  copyBtn.addEventListener('click', (e) => { e.stopPropagation(); copyNode(node.id, false); });
  hActions.appendChild(copyBtn);
  const copyTreeBtn = document.createElement('button');
  copyTreeBtn.className = 'node-copy tree';
  copyTreeBtn.textContent = '复制整链';
  copyTreeBtn.title = '复制此节点及其所有下游（整条链）';
  copyTreeBtn.addEventListener('click', (e) => { e.stopPropagation(); copyNode(node.id, true); });
  hActions.appendChild(copyTreeBtn);
  const del = document.createElement('button');
  del.className = 'node-del';
  del.textContent = '✕';
  del.title = '删除';
  del.addEventListener('click', (e) => { e.stopPropagation(); deleteNode(node.id); });
  hActions.appendChild(del);
  header.appendChild(hActions);
  el.appendChild(header);

  const body = document.createElement('div');
  body.className = 'node-body';

  if (node.type === 'input') {
    const ta = document.createElement('textarea');
    ta.className = 'content';
    ta.placeholder = '在这里输入/粘贴你的原始文本…';
    ta.addEventListener('input', () => { node.content = ta.value; autoGrow(ta); onContentChanged(node.id); });
    body.appendChild(ta);
  } else {
    const row = document.createElement('div');
    row.className = 'row';
    const lbl = document.createElement('label');
    lbl.className = 'lbl';
    lbl.textContent = '操作';
    const sel = document.createElement('select');
    sel.className = 'op-select';
    for (const k in OPERATIONS) {
      const o = document.createElement('option');
      o.value = k; o.textContent = OPERATIONS[k].label;
      sel.appendChild(o);
    }
    sel.value = node.operation;
    sel.addEventListener('change', () => { node.operation = sel.value; saveState(); });
    row.appendChild(lbl); row.appendChild(sel);
    body.appendChild(row);

    const inst = document.createElement('textarea');
    inst.className = 'instruction';
    inst.placeholder = '可选：自由附加指令（如「语气更正式」「控制在 100 字内」）…';
    inst.addEventListener('input', () => { node.instruction = inst.value; saveState(); });
    body.appendChild(inst);

    const prev = document.createElement('div');
    prev.className = 'up-preview empty';
    body.appendChild(prev);

    const actions = document.createElement('div');
    actions.className = 'node-actions';
    const runBtn = document.createElement('button');
    runBtn.className = 'tb primary run-btn';
    runBtn.textContent = '运行';
    runBtn.addEventListener('click', () => runNode(node.id));
    const histBtn = document.createElement('button');
    histBtn.className = 'tb hist-btn';
    histBtn.textContent = '历史';
    histBtn.addEventListener('click', () => toggleHistory(el, node));
    const copyBtn = document.createElement('button');
    copyBtn.className = 'tb';
    copyBtn.textContent = '复制结果';
    copyBtn.addEventListener('click', () => copyText(node.output || ''));
    actions.appendChild(runBtn); actions.appendChild(histBtn); actions.appendChild(copyBtn);
    body.appendChild(actions);

    const out = document.createElement('textarea');
    out.className = 'output';
    out.placeholder = 'AI 结果将显示在这里（可编辑，作为下游输入）…';
    out.addEventListener('input', () => { node.output = out.value; autoGrow(out); saveState(); });
    body.appendChild(out);

    const histPanel = document.createElement('div');
    histPanel.className = 'history-panel hidden';
    body.appendChild(histPanel);
  }
  el.appendChild(body);

  // 端口
  const portOut = document.createElement('div');
  portOut.className = 'port port-out';
  portOut.title = '拖出连线';
  portOut.addEventListener('mousedown', (e) => startConnect(e, node.id));
  el.appendChild(portOut);

  if (node.type === 'ai') {
    const portIn = document.createElement('div');
    portIn.className = 'port port-in';
    portIn.title = '连线终点';
    el.appendChild(portIn);
  }

  // 拖拽移动
  header.addEventListener('mousedown', (e) => startDrag(e, node.id));
}

function updateUpPreview(el, node) {
  const prev = $('.up-preview', el);
  const inc = incomingOf(node.id);
  if (inc.length === 0) {
    prev.textContent = '（暂无上游输入）';
    prev.classList.add('empty');
    return;
  }
  const parts = inc.map(e => {
    const s = getNode(e.from);
    return s.type === 'input' ? (s.content || '') : (s.output || '');
  }).filter(t => t.trim());
  const txt = parts.join('\n\n');
  if (txt.trim()) {
    prev.textContent = '（共 ' + inc.length + ' 个上游，按顺序拼接）\n' + txt;
    prev.classList.remove('empty');
  } else {
    prev.textContent = '（上游暂无内容）';
    prev.classList.add('empty');
  }
}

function onContentChanged(id) {
  markDirty();
  // 更新所有下游的预览
  for (const e of outgoingOf(id)) {
    const el = nodeEls.get(e.to);
    if (el) updateUpPreview(el, getNode(e.to));
  }
  saveState();
}

/* ---------- 连线绘制 ---------- */
/* 端口中心（内容坐标，不依赖 DOM 缩放后位置）
   与 styles.css 中 .node 宽(280px) 及 .port top(16px)+半径(7px)=23 保持一致 */
const NODE_W = 280, PORT_DY = 23;
function portCenter(nodeId, which) {
  const node = getNode(nodeId);
  if (!node) return { x: 0, y: 0 };
  if (which === 'out') return { x: node.x + NODE_W - 1, y: node.y + PORT_DY };
  return { x: node.x - 1, y: node.y + PORT_DY };
}
function fitView() {
  if (state.nodes.length === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of state.nodes) {
    const el = nodeEls.get(n.id);
    // 用实际渲染高度，兜底估算
    let h = (el && el.offsetHeight) || 0;
    if (h < 60) h = n.type === 'ai' ? 420 : (estNodeHeight(n.content || '') + 80);
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x + NODE_W > maxX) maxX = n.x + NODE_W;
    if (n.y + h > maxY) maxY = n.y + h;
  }
  const pad = 80;
  const bw = (maxX - minX) + pad * 2;
  const bh = (maxY - minY) + pad * 2;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (cw === 0 || ch === 0) return; // 画布不可见时跳过
  const scale = Math.min(cw / bw, ch / bh, 1);
  view.scale = scale;
  view.tx = (cw - bw * scale) / 2 - (minX - pad) * scale;
  view.ty = (ch - bh * scale) / 2 - (minY - pad) * scale;
  applyView();
}
/** 根据文本长度估算节点内容区高度 */
function estNodeHeight(txt) {
  if (!txt) return 110;
  const lines = Math.max(3, Math.ceil((txt.length * 1.2) / 22));
  return Math.min(640, 80 + lines * 22);
}
function resetView() { view.scale = 1; view.tx = 0; view.ty = 0; applyView(); }

function edgePath(s, t) {
  const dx = Math.max(40, Math.abs(t.x - s.x) / 2);
  return `M ${s.x} ${s.y} C ${s.x + dx} ${s.y}, ${t.x - dx} ${t.y}, ${t.x} ${t.y}`;
}

function drawEdges() {
  edgeLayer.innerHTML = '';
  for (const e of state.edges) {
    const from = getNode(e.from), to = getNode(e.to);
    if (!from || !to) continue;
    const s = portCenter(e.from, 'out');
    const t = portCenter(e.to, 'in');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('class', 'edge');
    p.setAttribute('d', edgePath(s, t));
    p.addEventListener('click', () => {
      if (confirm('删除这条连线？')) { deleteEdge(e.id); }
    });
    edgeLayer.appendChild(p);
  }
  if (tempConnect && tempConnect.cur) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('class', 'temp');
    p.setAttribute('d', edgePath(tempConnect.start, tempConnect.cur));
    edgeLayer.appendChild(p);
  }
}

/* ---------- 连线交互 ---------- */
let tempConnect = null;
function startConnect(e, fromId) {
  e.stopPropagation();
  e.preventDefault();
  tempConnect = { from: fromId, start: portCenter(fromId, 'out'), cur: null };
  document.addEventListener('mousemove', onConnectMove);
  document.addEventListener('mouseup', onConnectUp);
}
function onConnectMove(e) {
  if (!tempConnect) return;
  const cr = canvas.getBoundingClientRect();
  tempConnect.cur = {
    x: (e.clientX - cr.left - view.tx) / view.scale,
    y: (e.clientY - cr.top - view.ty) / view.scale,
  };
  drawEdges();
}
function onConnectUp(e) {
  document.removeEventListener('mousemove', onConnectMove);
  document.removeEventListener('mouseup', onConnectUp);
  const target = document.elementFromPoint(e.clientX, e.clientY);
  const portIn = target && target.closest && target.closest('.port-in');
  if (portIn) {
    const toEl = portIn.closest('.node');
    const toId = toEl && toEl.dataset.id;
    if (toId) tryConnect(tempConnect.from, toId);
  }
  tempConnect = null;
  drawEdges();
}

function tryConnect(fromId, toId) {
  if (fromId === toId) { toast('不能连到自己'); return; }
  const to = getNode(toId);
  if (!to || to.type !== 'ai') { toast('输入框不能接收连线'); return; }
  if (state.edges.some(e => e.from === fromId && e.to === toId)) { toast('连线已存在'); return; }
  if (createsCycle(fromId, toId)) { toast('不能连成环'); return; }
  state.edges.push({ id: uid('e'), from: fromId, to: toId });
  saveState();
  renderAll();
}
function createsCycle(fromId, toId) {
  // 从 toId 出发能否到达 fromId
  const seen = new Set();
  const stack = [toId];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === fromId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const e of outgoingOf(cur)) stack.push(e.to);
  }
  return false;
}

/* ---------- 节点操作 ---------- */
function addNode(type) {
  const id = uid(type);
  const node = {
    id, type,
    x: 120 + (state.nodes.length % 5) * 40,
    y: 120 + (state.nodes.length % 5) * 40,
    content: '', operation: 'polish', instruction: '', output: '', running: false, history: [],
  };
  state.nodes.push(node);
  saveState();
  renderAll();
}

function deleteNode(id) {
  if (!confirm('删除该节点及其连线？')) return;
  state.nodes = state.nodes.filter(n => n.id !== id);
  state.edges = state.edges.filter(e => e.from !== id && e.to !== id);
  saveState();
  renderAll();
}
function deleteEdge(id) {
  state.edges = state.edges.filter(e => e.id !== id);
  saveState();
  renderAll();
}

/* ---------- 复制节点 / 整链 ---------- */
function collectSubtree(rootId) {
  const ids = new Set();
  const stack = [rootId];
  while (stack.length) {
    const cur = stack.pop();
    if (ids.has(cur)) continue;
    ids.add(cur);
    for (const e of outgoingOf(cur)) stack.push(e.to);
  }
  return ids;
}

function cloneNodeFields(src, newId, dx, dy) {
  return {
    id: newId,
    type: src.type,
    x: src.x + dx,
    y: src.y + dy,
    content: src.content || '',
    operation: src.operation || 'polish',
    instruction: src.instruction || '',
    output: src.output || '',
    running: false,
    history: Array.isArray(src.history) ? src.history.map(h => ({ ...h })) : [],
  };
}

function copyNode(id, subtree) {
  const root = getNode(id);
  if (!root) return;
  const dx = 48, dy = 48;
  if (subtree) {
    const ids = collectSubtree(id);
    const map = {};
    const newNodes = [];
    for (const oid of ids) {
      const n = getNode(oid);
      const nid = uid(n.type);
      map[oid] = nid;
      newNodes.push(cloneNodeFields(n, nid, dx, dy));
    }
    for (const e of state.edges) {
      if (map[e.from] && map[e.to]) {
        state.edges.push({ id: uid('e'), from: map[e.from], to: map[e.to] });
      }
    }
    state.nodes.push(...newNodes);
    saveState();
    renderAll();
    toast('已复制整链（' + ids.size + ' 个节点）');
  } else {
    const nid = uid(root.type);
    state.nodes.push(cloneNodeFields(root, nid, dx, dy));
    saveState();
    renderAll();
    toast('已复制节点');
  }
}

/* ---------- 拖拽移动 ---------- */
function startDrag(e, id) {
  if (e.target.closest('.node-del') || e.target.closest('.node-copy')) return;
  e.preventDefault();
  const node = getNode(id);
  const cr = canvas.getBoundingClientRect();
  const startX = e.clientX, startY = e.clientY;
  const origX = node.x, origY = node.y;
  function move(ev) {
    node.x = Math.max(0, origX + (ev.clientX - startX) / view.scale);
    node.y = Math.max(0, origY + (ev.clientY - startY) / view.scale);
    const el = nodeEls.get(id);
    el.style.left = node.x + 'px';
    el.style.top = node.y + 'px';
    drawEdges();
  }
  function up() {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    saveState();
  }
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

/* ---------- AI 调用（流式） ---------- */
const runningSet = new Set();

async function runNode(id) {
  const node = getNode(id);
  if (!node || node.type !== 'ai') return;
  if (runningSet.has(id)) return;
  const inc = incomingOf(id);
  if (inc.length === 0) { toast('该 AI 框没有上游输入'); return; }
  const parts = [];
  for (const e of inc) {
    const src = getNode(e.from);
    const txt = src.type === 'input' ? (src.content || '') : (src.output || '');
    if (txt.trim()) parts.push(txt.trim());
  }
  if (parts.length === 0) { toast('上游没有内容，先填写上游'); return; }
  const srcText = parts.join('\n\n');

  const settings = loadSettings();
  if (!settings.apiKey) { openSettings(); toast('请先配置 API Key'); return; }

  const tpl = OPERATIONS[node.operation].prompt;
  let userMsg = tpl;
  if (node.instruction && node.instruction.trim()) userMsg += '\n附加要求：' + node.instruction.trim();
  userMsg += '\n\n' + srcText;

  node.running = true; node.output = '';
  renderNode(id);
  runningSet.add(id);

  try {
    const url = settings.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + settings.apiKey,
      },
      body: JSON.stringify({
        model: settings.model,
        messages: [{ role: 'user', content: userMsg }],
        stream: true,
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error('HTTP ' + res.status + ' ' + txt.slice(0, 200));
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (delta) {
            node.output += delta;
            const outEl = $('.output', nodeEls.get(id));
            if (document.activeElement !== outEl) { outEl.value = node.output; autoGrow(outEl); }
            // 实时更新下游预览
            for (const e of outgoingOf(id)) {
              const el = nodeEls.get(e.to);
              if (el) updateUpPreview(el, getNode(e.to));
            }
          }
        } catch (_) { /* 忽略不完整片段 */ }
      }
    }
    recordHistory(node, node.operation, node.instruction, srcText, node.output);
  } catch (err) {
    node.output = '【调用出错】' + err.message;
    const outEl = $('.output', nodeEls.get(id));
    outEl.value = node.output;
    toast('调用失败：' + err.message);
  } finally {
    node.running = false;
    runningSet.delete(id);
    renderNode(id);
    saveState();
  }
}

/* ---------- 运行历史 ---------- */
function recordHistory(node, op, instruction, input, output) {
  if (!output || !output.trim()) return;
  if (output.startsWith('【调用出错】')) return;
  if (!node.history) node.history = [];
  node.history.unshift({ ts: Date.now(), op, instruction: instruction || '', input, output });
  if (node.history.length > 12) node.history.length = 12;
}

function toggleHistory(el, node) {
  const panel = $('.history-panel', el);
  if (!panel) return;
  if (panel.classList.contains('hidden')) {
    renderHistory(panel, node);
    panel.classList.remove('hidden');
  } else {
    panel.classList.add('hidden');
  }
}

function renderHistory(panel, node) {
  panel.innerHTML = '';
  if (!node.history || node.history.length === 0) {
    panel.innerHTML = '<div class="hist-empty">暂无历史记录</div>';
    return;
  }
  node.history.forEach((h) => {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.title = '当时输入：\n' + (h.input || '');
    const time = new Date(h.ts).toLocaleString('zh-CN', { hour12: false });
    const opLabel = OPERATIONS[h.op] ? OPERATIONS[h.op].label : (h.op || '运行');
    const head = document.createElement('div');
    head.className = 'hist-head';
    head.innerHTML = '<span class="hist-time">' + time + '</span><span class="hist-op">' + opLabel + '</span>';
    const prev = document.createElement('div');
    prev.className = 'hist-preview';
    prev.textContent = h.output.length > 120 ? h.output.slice(0, 120) + '…' : h.output;
    const btns = document.createElement('div');
    btns.className = 'hist-btns';
    const restore = document.createElement('button');
    restore.className = 'tb tiny';
    restore.textContent = '恢复此版本';
    restore.addEventListener('click', () => restoreHistory(node, h));
    const copyh = document.createElement('button');
    copyh.className = 'tb tiny';
    copyh.textContent = '复制';
    copyh.addEventListener('click', () => copyText(h.output));
    btns.appendChild(restore); btns.appendChild(copyh);
    item.appendChild(head); item.appendChild(prev); item.appendChild(btns);
    panel.appendChild(item);
  });
  const clear = document.createElement('button');
  clear.className = 'tb tiny danger';
  clear.textContent = '清空历史';
  clear.addEventListener('click', () => {
    if (confirm('清空该节点全部历史记录？')) { node.history = []; renderHistory(panel, node); saveState(); }
  });
  panel.appendChild(clear);
}

function restoreHistory(node, h) {
  node.output = h.output;
  saveState();
  renderNode(node.id);
  for (const e of outgoingOf(node.id)) {
    const el = nodeEls.get(e.to);
    if (el) updateUpPreview(el, getNode(e.to));
  }
  toast('已恢复历史版本');
}

async function runDownstream(id) {
  await runNode(id);
  for (const e of outgoingOf(id)) {
    await runDownstream(e.to);
  }
}

async function runAll() {
  const roots = state.nodes.filter(n => incomingOf(n.id).length === 0);
  for (const r of roots) await runDownstream(r.id);
  toast('全部运行完成');
}

/* ---------- 导入 / 导出 / 复制 ---------- */
function exportJson() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'ai-writing-workflow.json';
  a.click();
  URL.revokeObjectURL(a.href);
}
function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error('格式不正确');
      state = { nodes: data.nodes, edges: data.edges };
      saveState();
      renderAll();
      toast('导入成功');
    } catch (e) { toast('导入失败：' + e.message); }
  };
  reader.readAsText(file);
}
function copyText(txt) {
  if (!txt) { toast('没有可复制的内容'); return; }
  navigator.clipboard.writeText(txt).then(() => toast('已复制'), () => toast('复制失败'));
}

/* ---------- 导入文档 → 多个输入框 ---------- */
function splitDoc(text, mode, size) {
  const t = (text || '').replace(/\r/g, '');
  if (mode === 'whole') {
    const s = t.trim();
    return s ? [s] : [];
  }
  if (mode === 'size') {
    const n = Math.max(20, parseInt(size, 10) || 200);
    const segs = [];
    let i = 0;
    while (i < t.length) {
      let end = Math.min(i + n, t.length);
      if (end < t.length) {
        const seg = t.slice(end - 40, end);
        const m = seg.match(/[。.!?！？\n]/);
        if (m && m.index !== undefined) end = end - 40 + m.index + 1;
      }
      const piece = t.slice(i, end).trim();
      if (piece) segs.push(piece);
      i = end;
    }
    return segs;
  }
  // 按段落：以一个或多个换行分隔
  return t.split(/\n+/).map(s => s.trim()).filter(s => s.length > 0);
}

function importDocToNodes() {
  const text = $('#doc-text').value;
  const mode = $('#doc-mode').value;
  const size = $('#doc-size').value;
  const importMode = $('#doc-import-mode').value;
  const segs = splitDoc(text, mode, size);
  if (segs.length === 0) { toast('没有可拆分的内容'); return; }
  if ($('#doc-clear').checked) { state.nodes = []; state.edges = []; }

  // 根据内容长度估算节点高度（每中文字约 18px 行高，每行约 22 字）
  const estHeight = (txt) => {
    const lines = Math.max(3, Math.ceil((txt.length * 1.2) / 22));
    return Math.min(640, 80 + lines * 22);
  };

  if (importMode === 'chain') {
    /* 链式：每段一对 [输入框] → [AI框] 横排，避免重叠 */
    const op = $('#doc-op').value || 'polish';
    const instr = $('#doc-op-instr').value.trim();
    const NODE_W = 280;          /* 与 CSS .node width 一致 */
    const PAIR_GAP = 40;         /* 输入框与 AI 框的间距 */
    const COL_GAP = 60;          /* 列间距 */
    const ROW_GAP = 80;          /* 行间距 */
    const PAIR_W = NODE_W * 2 + PAIR_GAP;  /* 一对的总宽度 */
    const cols = Math.max(1, Math.floor((canvas.clientWidth || 1200) / (PAIR_W + COL_GAP)));
    let curX = 60, curY = 80, maxRowH = 0;

    segs.forEach((s, k) => {
      const hIn = estHeight(s);
      const hAi = estHeight(s) + 140;   /* AI 框比输入高（多操作区+输出区） */
      const pairH = Math.max(hIn, hAi);

      if (k > 0 && k % cols === 0) {
        curX = 60;
        curY += maxRowH + ROW_GAP;
        maxRowH = 0;
      }

      const inId = uid('input');
      state.nodes.push({
        id: inId, type: 'input',
        x: curX, y: curY,
        content: s,
        operation: 'polish', instruction: '', output: '', running: false, history: [],
      });
      const aiId = uid('ai');
      state.nodes.push({
        id: aiId, type: 'ai',
        x: curX + NODE_W + PAIR_GAP, y: curY,
        content: '', operation: op, instruction: instr, output: '', running: false, history: [],
      });
      state.edges.push({ id: uid('e'), from: inId, to: aiId });

      if (pairH > maxRowH) maxRowH = pairH;
      curX += PAIR_W + COL_GAP;
    });

    closeImportDoc();
    saveState();
    renderAll();
    if (state.nodes.length > 4) setTimeout(fitView, 200);
    toast('已生成 ' + segs.length + ' 条 输入→AI 链，点「向下游全部运行」批量处理');
  } else {
    /* 仅输入框 */
    const NODE_W = 280;
    const COL_GAP = 40;
    const ROW_GAP = 50;
    const cols = Math.max(1, Math.floor((canvas.clientWidth || 1200) / (NODE_W + COL_GAP)));
    let curX = 60, curY = 80, maxRowH = 0;

    segs.forEach((s, k) => {
      const h = estHeight(s);
      if (k > 0 && k % cols === 0) {
        curX = 60;
        curY += maxRowH + ROW_GAP;
        maxRowH = 0;
      }
      state.nodes.push({
        id: uid('input'), type: 'input',
        x: curX, y: curY,
        content: s,
        operation: 'polish', instruction: '', output: '', running: false, history: [],
      });
      if (h > maxRowH) maxRowH = h;
      curX += NODE_W + COL_GAP;
    });

    closeImportDoc();
    saveState();
    renderAll();
    if (state.nodes.length > 4) setTimeout(fitView, 200);
    toast('已生成 ' + segs.length + ' 个输入框');
  }
}
function openImportDoc() { $('#import-doc-modal').classList.remove('hidden'); }
function closeImportDoc() { $('#import-doc-modal').classList.add('hidden'); }

/* ---------- 轻提示 ---------- */
let toastTimer = null;
function toast(msg) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);background:#1f2329;color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;z-index:99;opacity:0;transition:.2s;pointer-events:none;';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2200);
}

/* ---------- 设置弹窗 ---------- */
function openSettings() {
  const s = loadSettings();
  $('#set-base').value = s.baseUrl;
  $('#set-key').value = s.apiKey;
  $('#set-model').value = s.model;
  $('#settings-modal').classList.remove('hidden');
}
function closeSettings() { $('#settings-modal').classList.add('hidden'); }

/* ---------- 事件绑定 ---------- */
$('#btn-add-input').addEventListener('click', () => addNode('input'));
$('#btn-add-ai').addEventListener('click', () => addNode('ai'));
$('#btn-run-all').addEventListener('click', runAll);
$('#btn-export').addEventListener('click', exportJson);
$('#btn-import').addEventListener('click', () => $('#file-import').click());
$('#file-import').addEventListener('change', (e) => {
  if (e.target.files[0]) importJson(e.target.files[0]);
  e.target.value = '';
});
$('#btn-settings').addEventListener('click', openSettings);
$('#set-cancel').addEventListener('click', closeSettings);
$('#set-save').addEventListener('click', () => {
  saveSettings({
    baseUrl: $('#set-base').value.trim() || 'https://api.deepseek.com/v1',
    apiKey: $('#set-key').value.trim(),
    model: $('#set-model').value.trim() || 'deepseek-chat',
  });
  closeSettings();
  toast('设置已保存');
});
$('#settings-modal').addEventListener('click', (e) => {
  if (e.target === $('#settings-modal')) closeSettings();
});

/* 导入文档 */
$('#btn-import-doc').addEventListener('click', openImportDoc);
$('#doc-cancel').addEventListener('click', closeImportDoc);
$('#doc-ok').addEventListener('click', importDocToNodes);
$('#import-doc-modal').addEventListener('click', (e) => {
  if (e.target === $('#import-doc-modal')) closeImportDoc();
});
$('#doc-mode').addEventListener('change', (e) => {
  $('#doc-size').disabled = (e.target.value !== 'size');
});
$('#doc-import-mode').addEventListener('change', (e) => {
  $('#doc-chain-opts').classList.toggle('hidden', e.target.value !== 'chain');
});
function fillDocOp() {
  const sel = $('#doc-op');
  if (!sel) return;
  for (const [k, v] of Object.entries(OPERATIONS)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = v.label;
    sel.appendChild(o);
  }
}
fillDocOp();
$('#btn-fit').addEventListener('click', fitView);
$('#btn-1x').addEventListener('click', resetView);

/* 滚轮平移画布（替代滚动条，支持上下左右） */
canvas.addEventListener('wheel', (e) => {
  // 在文本框内滚动时让文本框自己滚，不平移画布
  if (e.target.closest('textarea')) return;
  e.preventDefault();
  if (e.shiftKey) {
    // shift + 滚轮：左右平移
    view.tx -= e.deltaY;
  } else {
    view.tx -= e.deltaX;
    view.ty -= e.deltaY;
  }
  applyView();
}, { passive: false });

/* 在空白处按住拖拽 = 平移整个画布 */
canvas.addEventListener('mousedown', (e) => {
  if (e.target.closest('.node')) return;          // 点在节点上不平移
  if (e.button !== 0) return;                      // 仅左键
  const startX = e.clientX, startY = e.clientY;
  const otx = view.tx, oty = view.ty;
  canvas.classList.add('panning');
  const move = (ev) => {
    view.tx = otx + (ev.clientX - startX);
    view.ty = oty + (ev.clientY - startY);
    applyView();
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    canvas.classList.remove('panning');
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
});
/* ---------- 文档解析库按需加载（Word/PDF 走浏览器端 CDN，无后端） ---------- */
const DOC_LIBS = {
  pdfjs: {
    url: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3/build/pdf.min.js',
    ready: () => !!window.pdfjsLib,
    after: () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3/build/pdf.worker.min.js'; }
  },
  mammoth: {
    url: 'https://cdn.jsdelivr.net/npm/mammoth@1/mammoth.browser.min.js',
    ready: () => !!window.mammoth
  }
};
function loadScriptOnce(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error('解析库加载失败，请检查网络'));
    document.head.appendChild(s);
  });
}
async function ensureDocLib(name) {
  const L = DOC_LIBS[name];
  if (L.ready()) return;
  await loadScriptOnce(L.url);
  if (L.after) L.after();
  if (!L.ready()) throw new Error('解析库未能初始化：' + name);
}

$('#doc-pick').addEventListener('click', () => $('#doc-file').click());
$('#doc-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const lower = f.name.toLowerCase();
  try {
    if (lower.endsWith('.pdf')) {
      toast('正在解析 PDF…');
      await ensureDocLib('pdfjs');
      const buf = await f.arrayBuffer();
      const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
      let out = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const tc = await page.getTextContent();
        out += tc.items.map(it => it.str || '').join(' ') + '\n\n';
      }
      $('#doc-text').value = out.trim();
      toast('已读取 PDF：' + pdf.numPages + ' 页');
    } else if (lower.endsWith('.docx')) {
      toast('正在解析 Word…');
      await ensureDocLib('mammoth');
      const buf = await f.arrayBuffer();
      const res = await window.mammoth.extractRawText({ arrayBuffer: buf });
      $('#doc-text').value = (res.value || '').trim();
      toast('已读取 Word 文档');
    } else if (lower.endsWith('.doc')) {
      toast('旧版 .doc 暂不支持，请另存为 .docx 后重试');
    } else {
      const r = new FileReader();
      r.onload = () => { $('#doc-text').value = r.result; toast('已读取文件'); };
      r.readAsText(f);
    }
  } catch (err) {
    toast('解析失败：' + (err && err.message ? err.message : err));
  }
  e.target.value = '';
});

/* ---------- 启动 ---------- */
loadState();
renderAll();
