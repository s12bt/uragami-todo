// uragami-todo: todo.json を読み書きする画面
// ファイルの形と置き場所の設定は README.md を参照

const { invoke } = window.__TAURI__.core;

const POLL_MS = 1500;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

const state = {
  doc: null, // todo.json の中身
  mtime: null, // 最後に読み書きしたときのファイル更新時刻
  path: "",
  editing: false, // 入力中は外からの更新を当てない
  addChildFor: null, // 子タスクの入力欄を開いているタスクの id
  closedChildFor: null, // 直前に入力欄を閉じたタスクの id と時刻（開き直しを防ぐ）
  closedAt: 0,
  saving: Promise.resolve(),
};

const $ = (id) => document.getElementById(id);

// ---------- ファイルの読み書き ----------

async function loadFromDisk() {
  const res = await invoke("load_todo");
  state.path = res.path;
  if (res.content == null) {
    state.doc = null;
    state.mtime = null;
    return;
  }
  try {
    state.doc = normalize(JSON.parse(res.content));
    state.mtime = res.mtime;
  } catch {
    // 同期の途中などで壊れて見えたときは、前の状態を残して次の読み込みを待つ
    toast("todo.json を読めませんでした。少し待ってから読み直します");
  }
}

function save() {
  const doc = state.doc;
  doc.updatedAt = new Date().toISOString();
  const content = JSON.stringify(doc, null, 2) + "\n";
  // 保存は順番に 1 つずつ行う
  state.saving = state.saving.then(async () => {
    try {
      state.mtime = await invoke("save_todo", { content, expectedMtime: state.mtime });
    } catch (e) {
      if (String(e) === "conflict") {
        await loadFromDisk();
        render();
        toast("ファイルが外で書き換わっていたので、読み直しました");
      } else {
        toast("保存できませんでした: " + e);
      }
    }
  });
  return state.saving;
}

async function poll() {
  if (state.editing) return;
  await state.saving;
  const res = await invoke("load_todo");
  if (res.mtime !== state.mtime) {
    await loadFromDisk();
    render();
  }
}

// 足りない項目を補う（AI や手で書き換えたファイルでも動くように）
function normalize(doc) {
  doc.tasks = Array.isArray(doc.tasks) ? doc.tasks : [];
  const fix = (t) => {
    t.id = t.id || newId();
    t.title = String(t.title ?? "");
    t.done = Boolean(t.done);
    t.children = Array.isArray(t.children) ? t.children : [];
    t.children.forEach(fix);
    return t;
  };
  doc.tasks.forEach((t) => {
    fix(t);
    t.tomorrow = Boolean(t.tomorrow);
  });
  return doc;
}

function newId() {
  return Math.random().toString(16).slice(2, 8);
}

// ---------- 操作 ----------

function findTask(id, list = state.doc.tasks) {
  for (const t of list) {
    if (t.id === id) return { task: t, list };
    const hit = findTask(id, t.children);
    if (hit) return hit;
  }
  return null;
}

function update(fn) {
  fn();
  render();
  save();
}

// id のタスクがあるときだけ fn を当てて保存する。
// メニューやダイアログを開いている間に外で消えていたら、何もしない
function updateTask(id, fn) {
  const hit = state.doc && findTask(id);
  if (!hit) return render();
  update(() => fn(hit.task, hit.list));
}

const actions = {
  toggle: (id) => updateTask(id, (task) => {
    task.done = !task.done;
  }),
  tomorrow: (id) => updateTask(id, (task) => {
    task.tomorrow = true;
  }),
  today: (id) => updateTask(id, (task) => {
    task.tomorrow = false;
  }),
  rename: (id, title) => updateTask(id, (task) => {
    task.title = title;
  }),
  remove: (id) => updateTask(id, (task, list) => {
    list.splice(list.indexOf(task), 1);
  }),
  addChild: (parentId, title) => updateTask(parentId, (task) => {
    task.children.push({ id: newId(), title, done: false, children: [] });
  }),
  addTask: (title) => update(() => {
    // ファイルがまだ無いときは、ここで作り始める
    if (!state.doc) state.doc = { version: 1, tasks: [] };
    const tasks = state.doc.tasks;
    const firstTomorrow = tasks.findIndex((t) => t.tomorrow);
    const task = { id: newId(), title, done: false, tomorrow: false, children: [] };
    if (firstTomorrow === -1) tasks.push(task);
    else tasks.splice(firstTomorrow, 0, task);
  }),
  // 今日の並びを入れ替える。明日やるものは後ろにまとめる
  reorderToday: (ids) => update(() => {
    const byId = new Map(state.doc.tasks.map((t) => [t.id, t]));
    const today = ids.map((id) => byId.get(id)).filter(Boolean);
    const rest = state.doc.tasks.filter((t) => !today.includes(t));
    state.doc.tasks = [...today, ...rest];
  }),
  reorderChildren: (parentId, ids) => updateTask(parentId, (parent) => {
    const byId = new Map(parent.children.map((t) => [t.id, t]));
    const sorted = ids.map((id) => byId.get(id)).filter(Boolean);
    parent.children = [...sorted, ...parent.children.filter((t) => !sorted.includes(t))];
  }),
};

// ---------- 描画 ----------

function render() {
  const doc = state.doc;
  const today = $("today");
  const tomorrow = $("tomorrow");
  today.replaceChildren();
  tomorrow.replaceChildren();

  if (!doc) {
    $("date").textContent = "今日のこと";
    showNotice(`まだタスクがありません。下の「＋」から書き始めると、次の場所に保存します。\n${state.path}`);
    $("tomorrow-section").hidden = true;
    return;
  }

  $("date").textContent = formatDate(doc.date);

  const todayTasks = doc.tasks.filter((t) => !t.tomorrow);
  const tomorrowTasks = doc.tasks.filter((t) => t.tomorrow);

  if (todayTasks.length === 0) showNotice("今日のタスクはありません。");
  else showNotice("");

  todayTasks.forEach((t) => today.append(taskItem(t)));
  makeSortable(today, (ids) => actions.reorderToday(ids));

  $("tomorrow-section").hidden = tomorrowTasks.length === 0;
  tomorrowTasks.forEach((t) => tomorrow.append(tomorrowItem(t)));
}

function showNotice(text) {
  $("notice").hidden = !text;
  $("notice").textContent = text;
  $("notice").style.whiteSpace = "pre-line";
}

function formatDate(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  if (!m) return "今日のこと";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS[d.getDay()]}）`;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function checkButton(task, small = false) {
  return el(
    "button",
    {
      class: small ? "check small" : "check",
      title: task.done ? "未完了に戻す" : "完了にする",
      onclick: () => actions.toggle(task.id),
    },
    [task.done ? "✓" : ""],
  );
}

function titleNode(task) {
  const span = el("span", { class: "title", title: "ダブルクリックで書き換え" }, [task.title]);
  span.addEventListener("dblclick", () => startRename(span, task));
  return span;
}

function startRename(span, task) {
  state.editing = true;
  const input = el("input", { class: "title-input", type: "text" });
  input.value = task.title;
  let finished = false;
  const finish = (commit) => {
    if (finished) return;
    finished = true;
    state.editing = false;
    const title = input.value.trim();
    if (commit && title && title !== task.title) actions.rename(task.id, title);
    else render();
  };
  input.addEventListener("keydown", (e) => {
    if (isImeKey(e)) return;
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  span.replaceWith(input);
  input.focus();
  input.select();
}

function taskItem(task) {
  const li = el("li", { class: "item" + (task.done ? " done" : ""), "data-id": task.id });
  li.append(
    el("div", { class: "row" }, [
      el("span", { class: "handle", title: "ドラッグで並べ替え" }, ["⋮⋮"]),
      checkButton(task),
      titleNode(task),
      // マウスを乗せたときだけ見える、子タスクを足すボタン
      el("button", { class: "add-sub", title: "子タスクを足す", onclick: () => openAddChild(task.id) }, ["＋"]),
    ]),
  );
  onMenu(li.firstChild, [
    // 終わったものは明日に回さない
    ...(task.done ? [] : [["明日に回す", () => actions.tomorrow(task.id)]]),
    ["削除", () => deleteTask(task.id)],
  ]);

  const children = el("ul", { class: "children" });
  task.children.forEach((c) => children.append(childItem(c)));
  if (state.addChildFor === task.id) children.append(addChildForm(task.id));
  if (children.childElementCount) li.append(children);
  makeSortable(children, (ids) => actions.reorderChildren(task.id, ids));
  return li;
}

function childItem(task) {
  const li = el("li", { class: "item child" + (task.done ? " done" : ""), "data-id": task.id });
  li.append(
    el("div", { class: "row" }, [
      el("span", { class: "handle", title: "ドラッグで並べ替え" }, ["⋮⋮"]),
      checkButton(task, true),
      titleNode(task),
    ]),
  );
  onMenu(li.firstChild, [["削除", () => actions.remove(task.id)]]);
  return li;
}

function tomorrowItem(task) {
  const row = el("div", { class: "row" }, [el("span", { class: "title" }, [task.title])]);
  onMenu(row, [
    ["今日に戻す", () => actions.today(task.id)],
    ["削除", () => deleteTask(task.id)],
  ]);
  return el("li", { class: "item", "data-id": task.id }, [row]);
}

// 子タスクがあるときだけ、一緒に消えることを確かめてから消す。
// 子タスクの数は、メニューを開いた時点ではなく押した時点のデータで数える（その間に外で書き換わることがあるため）
async function deleteTask(id) {
  const hit = state.doc && findTask(id);
  if (!hit) return render();
  const n = hit.task.children.length;
  if (n && !(await confirmDialog(`「${hit.task.title}」の子タスク ${n} 件も一緒に削除されます。続けますか？`, "削除"))) return;
  actions.remove(id);
}

// ---------- 確認のダイアログ ----------

function confirmDialog(message, okLabel) {
  return new Promise((resolve) => {
    // 開いている間は裏の画面を操作できなくし、外からの読み直しも止める
    const paper = document.querySelector(".paper");
    const wasEditing = state.editing;
    state.editing = true;
    paper.inert = true;
    const close = (ok) => {
      paper.inert = false;
      state.editing = wasEditing;
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(ok);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(false);
      }
    };
    const cancel = el("button", { class: "btn", onclick: () => close(false) }, ["キャンセル"]);
    const ok = el("button", { class: "btn stamp", onclick: () => close(true) }, [okLabel]);
    // 押した瞬間に閉じると、指を離したときのクリックが下のタスクに届くため、クリックで閉じる
    const overlay = el("div", { class: "overlay", onclick: (e) => e.target === overlay && close(false) }, [
      el("div", { class: "dialog", role: "alertdialog", "aria-modal": "true", "aria-describedby": "dialog-text" }, [
        el("p", { class: "dialog-text", id: "dialog-text" }, [message]),
        el("div", { class: "dialog-actions" }, [cancel, ok]),
      ]),
    ]);
    document.body.append(overlay);
    document.addEventListener("keydown", onKey, true);
    // 誤って消さないよう、最初はキャンセルを選んでおく
    cancel.focus();
  });
}

// ---------- 右クリックのメニュー ----------

function onMenu(target, items) {
  target.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, items);
  });
}

function openMenu(x, y, items) {
  closeMenu();
  const menu = el(
    "ul",
    { id: "menu", class: "menu" },
    items.map(([label, fn]) =>
      el("li", {}, [
        el("button", {
          onclick: () => {
            closeMenu();
            fn();
          },
        }, [label]),
      ]),
    ),
  );
  document.body.append(menu);
  // 画面の端からはみ出さないように寄せる
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + "px";
}

function closeMenu() {
  document.getElementById("menu")?.remove();
}

document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest("#menu")) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
});
window.addEventListener("blur", closeMenu);
window.addEventListener("scroll", closeMenu, true);
// メニューを出す場所以外では、WebView の標準メニュー（再読み込みなど）を出さない
document.addEventListener("contextmenu", (e) => e.preventDefault());

function openAddChild(id) {
  // 開いていた入力欄が、この「＋」のクリックで閉じたばかりなら開き直さない
  if (state.closedChildFor === id && Date.now() - state.closedAt < 600) return;
  state.addChildFor = state.addChildFor === id ? null : id;
  render();
  const input = document.querySelector(".add-child input");
  if (input) input.focus();
}

function addChildForm(parentId) {
  const input = el("input", { type: "text", autocomplete: "off" });
  input.addEventListener("focus", () => (state.editing = true));
  input.addEventListener("blur", () => {
    state.editing = false;
    if (!input.value.trim()) {
      state.addChildFor = null;
      state.closedChildFor = parentId;
      state.closedAt = Date.now();
      setTimeout(render);
    }
  });
  input.addEventListener("keydown", (e) => {
    if (isImeKey(e)) return;
    if (e.key === "Escape") {
      input.value = "";
      input.blur();
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      state.editing = false;
      actions.addChild(parentId, title);
      const next = document.querySelector(".add-child input");
      if (next) next.focus();
    }
  });
  return el("li", { class: "add-child" }, [input]);
}

// ---------- 並べ替え（つまみをドラッグ） ----------

function makeSortable(list, onDone) {
  list.querySelectorAll(":scope > .item > .row > .handle").forEach((handle) => {
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const item = handle.closest(".item");
      const before = ids(list);
      item.classList.add("dragging");
      handle.setPointerCapture(e.pointerId);
      state.editing = true;

      const move = (ev) => {
        const others = [...list.querySelectorAll(":scope > .item:not(.dragging)")];
        const next = others.find((o) => {
          const r = o.getBoundingClientRect();
          return ev.clientY < r.top + r.height / 2;
        });
        if (next) list.insertBefore(item, next);
        else if (others.length) others[others.length - 1].after(item);
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        item.classList.remove("dragging");
        state.editing = false;
        const after = ids(list);
        if (after.join() !== before.join()) onDone(after);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  });
}

function ids(list) {
  return [...list.querySelectorAll(":scope > .item")].map((n) => n.dataset.id);
}

// ---------- そのほか ----------

// 日本語入力の変換中・変換確定のキーか。WebKit では確定の Enter が isComposing=false で届くため、
// keyCode 229 も見る
function isImeKey(e) {
  return e.isComposing || e.keyCode === 229;
}

let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

// Enter での送信はフォームに任せず、変換確定の Enter を除いてから自前で行う
$("add-form").addEventListener("submit", (e) => e.preventDefault());
$("add-input").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || isImeKey(e)) return;
  e.preventDefault();
  const input = $("add-input");
  const title = input.value.trim();
  if (!title) return;
  input.value = "";
  actions.addTask(title);
});
$("add-input").addEventListener("focus", () => (state.editing = true));
$("add-input").addEventListener("blur", () => (state.editing = false));

(async () => {
  await loadFromDisk();
  render();
  setInterval(() => poll().catch(() => {}), POLL_MS);
})();
