import { ContourTracker, MESSAGES, PATTERNS } from "./contour.mjs";
import { PitchGraph, drawPatternIcons } from "./graph.mjs";
import { Microphone, microphoneError } from "./microphone.mjs";

const byId = (id) => document.getElementById(id);
const tracker = new ContourTracker();
const buttons = Array.from(document.querySelectorAll("[data-pattern]"));
const unit = byId("unit");
const range = byId("range");
const microphone = byId("microphone");
const clear = byId("clear");
const previous = byId("previous");
const status = byId("status");
const feedback = byId("feedback");
let settings = {};
try {
  settings = JSON.parse(localStorage.getItem("voice-line-settings") || "{}") ?? {};
} catch {
  // The app also works when browser storage is blocked.
}
let pattern = Object.hasOwn(PATTERNS, settings.pattern) ? settings.pattern : "falling";
if (settings.unit === "hz") unit.value = "hz";
if (["low", "high"].includes(settings.range)) range.value = settings.range;

let session = null;
let state = "idle";
let hiddenLatest = null;
let history = null;
let notice = null;

function saveSettings() {
  try {
    localStorage.setItem("voice-line-settings", JSON.stringify({ pattern, unit: unit.value, range: range.value }));
  } catch {
    // Settings remain usable for this session.
  }
}

function getView() {
  const latest = tracker.latest !== hiddenLatest ? tracker.latest : null;
  const trace = history ?? tracker.active ?? latest;
  const live = !history && Boolean(tracker.active);
  const previousTrace = live ? latest : null;
  return {
    trace, live, previous: previousTrace, unit: unit.value, fallback: tracker.reference,
    pattern: history?.pattern ?? pattern,
  };
}

const graph = new PitchGraph(byId("graph"), getView);

function setText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function setFeedback(kind, title, detail) {
  feedback.dataset.kind = kind;
  setText(byId("feedback-title"), title);
  setText(byId("feedback-detail"), detail);
}

function update() {
  const view = getView();
  const stateLabel = { idle: "マイク停止中", starting: "マイクを準備中", live: "マイク使用中" }[state];
  const micLabel = { idle: "マイクを開始", starting: "開始を取り消す", live: "マイクを停止" }[state];
  status.dataset.state = microphone.dataset.state = state;
  setText(byId("status-label"), stateLabel);
  setText(byId("microphone-label"), micLabel);
  setText(byId("axis-note"), unit.value === "hz" ? "周波数（Hz）" : "ふだんの声を 0 とした高さ");
  setText(byId("guide-label"), history ? `前回の目標（${PATTERNS[view.pattern].label}）` : "目標の形");
  byId("ghost-legend").hidden = !view.previous;
  clear.disabled = !view.trace;
  previous.disabled = !tracker.latest;
  setText(previous, history ? "練習に戻る" : "前回の結果");

  if (notice) {
    setFeedback(notice.kind, notice.title, notice.detail);
  } else if (state === "starting") {
    setFeedback("", "マイクを準備しています。", "許可を聞かれたら「許可」を選んでください。");
  } else if (view.live) {
    setFeedback("", "発声中", "声が止まると結果を表示します。");
  } else if (view.trace) {
    const { result, truncated } = view.trace;
    const title = `${history ? "前回の結果 · " : ""}${MESSAGES[result]}`;
    const match = result === view.pattern;
    const detail = truncated ? "長い発声の最後の部分を表示しています。" :
      result === "unclear" ? "声の変化が見えるように、ひと息で少し長めに試してください。" :
        match ? `目標の「${PATTERNS[view.pattern].label}」と同じ方向です。` : PATTERNS[view.pattern].hint;
    setFeedback(match ? "match" : "", title, detail);
  } else if (state === "live") {
    setFeedback("", "練習フレーズを言ってみましょう。", "話している間、緑の線が右に伸びます。");
  } else {
    setFeedback("", "マイクを開始して、声を出してみましょう。", "初回は、マイクの使用を「許可」してください。");
  }
  graph.schedule();
}

function choosePattern(next) {
  pattern = next;
  if (tracker.active) tracker.active.pattern = pattern;
  history = null;
  for (const button of buttons) button.setAttribute("aria-pressed", String(button.dataset.pattern === pattern));
  drawPatternIcons(buttons);
  setText(byId("example"), PATTERNS[pattern].example);
  setText(byId("hint"), PATTERNS[pattern].hint);
  update();
}

function stop(message = null) {
  const current = session;
  session = null;
  current?.close();
  tracker.stop();
  state = "idle";
  notice = message;
  update();
}

microphone.addEventListener("click", async () => {
  if (session) {
    stop();
    return;
  }
  notice = null;
  history = null;
  tracker.resetFrames();
  const current = new Microphone((frame) => {
    if (session !== current) return;
    const { active, latest } = tracker;
    if (!tracker.push(frame, pattern)) return;
    if (tracker.active !== active || tracker.latest !== latest) {
      if (tracker.active) tracker.active.pattern = pattern;
      update();
    } else {
      graph.schedule();
    }
  }, () => {
    if (session === current) {
      stop({ kind: "error", title: "マイクが中断されました", detail: "接続やマイクの許可を確認し、「マイクを開始」を押すと再開できます。" });
    }
  });
  session = current;
  state = "starting";
  update();
  try {
    if (await current.start(range.value) && session === current) {
      state = "live";
      update();
    }
  } catch (error) {
    if (session === current) {
      const [title, detail] = microphoneError(error);
      stop({ kind: "error", title, detail });
    }
  }
});

clear.addEventListener("click", () => {
  hiddenLatest = tracker.latest;
  history = null;
  notice = null;
  tracker.clear();
  update();
});

previous.addEventListener("click", () => {
  if (history) history = null;
  else if (tracker.active || hiddenLatest === tracker.latest) history = tracker.latest;
  else history = tracker.previous ?? tracker.latest;
  notice = null;
  update();
});

for (const button of buttons) {
  button.addEventListener("click", () => {
    choosePattern(button.dataset.pattern);
    saveSettings();
  });
}
unit.addEventListener("change", () => { saveSettings(); update(); });
range.addEventListener("change", saveSettings);

function stopWhenHidden() {
  if (session) stop({ kind: "", title: "画面を離れたためマイクを停止しました", detail: "「マイクを開始」を押すと練習を再開できます。" });
}
document.addEventListener("visibilitychange", () => { if (document.hidden) stopWhenHidden(); });
window.addEventListener("pagehide", stopWhenHidden);

choosePattern(pattern);
if (isSecureContext && "serviceWorker" in navigator && location.protocol !== "file:") {
  void navigator.serviceWorker.register("./sw.js").catch(() => {});
}
