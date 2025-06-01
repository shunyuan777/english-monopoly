// ======================================
// client.js
// Multiplayer English Game – Firebase 版本
// 完整程式碼，所有邏輯皆以中文註解
// ======================================

// ===========================
// 1. 取得所有的 DOM 元素
// ===========================
const nickInput     = document.getElementById('nick');
const btnCreate     = document.getElementById('btnCreate');
const roomIdIn      = document.getElementById('roomIdIn');
const btnJoin       = document.getElementById('btnJoin');

const roomInfoDiv   = document.getElementById('roomInfo');
const roomIdShow    = document.getElementById('roomIdShow');
const groupListUl   = document.getElementById('groupList');
const playerListUl  = document.getElementById('playerList');
const selGroup      = document.getElementById('selGroup');
const btnJoinGroup  = document.getElementById('btnJoinGroup');
const hostControls  = document.getElementById('hostControls');
const btnStart      = document.getElementById('btnStart');

const gameDiv       = document.getElementById('game');
const timerSpan     = document.getElementById('timer');
const orderInfo     = document.getElementById('orderInfo');
const turnInfo      = document.getElementById('turnInfo');
const btnRoll       = document.getElementById('btnRoll');
const nonTurnMsg    = document.getElementById('nonTurnMsg');
const questionArea  = document.getElementById('questionArea');
const qText         = document.getElementById('qText');
const choicesList   = document.getElementById('choicesList');
const btnSubmitAns  = document.getElementById('btnSubmitAns');
const questionTimer = document.getElementById('questionTimer');
const posListUl     = document.getElementById('posList');

const resultDiv     = document.getElementById('result');
const rankListOl    = document.getElementById('rankList');

// ===========================
// 2. 常數與全域狀態初始值
// ===========================
const TOAST_DURATION = 2000;   // Toast 顯示 2 秒
const DICE_TIMEOUT    = 5000;  // 5 秒自動擲骰
const ANSWER_TIMEOUT  = 10000; // 10 秒自動提交答案
const TOTAL_GAME_TIME = 300;   // 總共 300 秒遊戲時間 (5 分鐘)

// 每位玩家產生一個隨機的 8 碼字串作為識別
const playerId = Math.random().toString(36).substr(2, 8);

let myNick  = '';     // 我自己的暱稱
let roomId  = '';     // 房號 (5 碼大寫英數字)
let isHost  = false;  // 是否為房主

// Firebase Database 的參考物件 (稍後指向 /rooms/{roomId})
let dbRefRoom       = null; // 指向 /rooms/{roomId}
let dbRefPlayers    = null; // 指向 /rooms/{roomId}/players
let dbRefState      = null; // 指向 /rooms/{roomId}/state
let dbRefGroupOrder = null; // 指向 /rooms/{roomId}/state/groupOrder
let dbRefEvents     = null; // 指向 /rooms/{roomId}/events
let dbRefPositions  = null; // 指向 /rooms/{roomId}/positions

// 本地暫存從 Firebase 拿到的資料
let playersData   = {};    // { playerId: {nick, groupId, position, score},  ... }
let groupOrder    = [];    // 例如 [ "group3", "group1" ]（只保留有人的組別，並已打亂順序）
let positionsData = {};    // { group1: 0, group2: 0, ..., group6: 0 }
let gameStartTime = 0;     // 遊戲真正開始的 timestamp (ms 形式)
let correctAnswer = '';    // 當前題目的正確答案 (如 "A")

// 計時器 Handle
let diceTimeoutHandle       = null; // 5 秒自動擲骰繫結
let questionTimeoutHandle   = null; // 10 秒自動送答案繫結
let questionCountdown       = null; // 每秒更新「Time Left: X s」的 interval

// ===========================
// 3. 公用輔助函式
// ===========================

// 顯示 Toast 訊息，持續 2 秒後自動消失
function showToast(msg) {
  const div = document.createElement('div');
  div.classList.add('toast');
  div.innerText = msg;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), TOAST_DURATION);
}

// 洗牌陣列 (Fisher–Yates shuffle 類似效果)
function shuffleArray(arr) {
  return arr
    .map(v => ({ val: v, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(o => o.val);
}

// ===========================
// 4. 房主「Create Room」按鈕事件
//    4.1 驗證暱稱是否輸入
//    4.2 產生不重複的 5 碼大寫英數字房號
//    4.3 在 Firebase /rooms/{roomId} 下建立初始資料結構
//    4.4 開啟監聽 & 顯示房間內頁面 (Group 選擇畫面)
// ===========================
btnCreate.addEventListener('click', async () => {
  myNick = nickInput.value.trim();
  if (!myNick) {
    return alert('Please enter a nickname');
  }

  // 產生 5 碼大寫英數字、確認在 DB 裡不存在
  let newId;
  while (true) {
    newId = Math.random().toString(36).substr(2, 5).toUpperCase();
    const exists = await db.ref(`rooms/${newId}`).get();
    if (!exists.exists()) break;
  }
  roomId = newId;
  isHost = true;

  // 建立房間結構
  const roomRef = db.ref(`rooms/${roomId}`);
  await roomRef.set({
    players: {
      // 房主自己先加入 players
      [playerId]: { nick: myNick, groupId: null, position: 0, score: 0 }
    },
    state: {
      status: 'lobby',        // "lobby" 或 "playing"
      groupOrder: [],         // 遊戲開始時會填入隨機排序的非空組
      turnIndex: 0,           // 目前輪到第幾組的索引
      questionInProgress: false, // 是否正在進行答題
      gameEndTime: 0,         // 遊戲結束 timestamp (ms)
      startTime: 0            // 遊戲真正開始時的 timestamp (ms)
    },
    positions: {
      // 先初始化 6 組位置都為 0
      group1: 0, group2: 0, group3: 0,
      group4: 0, group5: 0, group6: 0
    },
    events: {},          // 之後 rollDice、askQuestion、afterAnswer 事件都寫到這裡
    answerBuffer: {}     // 暫存每個玩家本輪的答案
  });

  // 啟動 Firebase 監聽 & 顯示房間內頁面
  setupRoomListeners();
  showRoomInfoUI();
  showToast(`Room created: ${roomId}`);
});

// ===========================
// 5. 一般玩家「Join Room」按鈕事件
//    5.1 驗證暱稱或房號是否輸入
//    5.2 判斷房間是否存在、是否尚未開始
//    5.3 將玩家加入 /rooms/{roomId}/players
//    5.4 開啟監聽 & 顯示房間內票
// ===========================
btnJoin.addEventListener('click', () => {
  myNick = nickInput.value.trim();
  roomId = roomIdIn.value.trim().toUpperCase();
  if (!myNick) {
    return alert('Please enter a nickname');
  }
  if (!roomId) {
    return alert('Please enter a Room ID');
  }

  const roomRef = db.ref(`rooms/${roomId}`);
  roomRef.get().then(snapshot => {
    if (!snapshot.exists()) {
      return alert('Room does not exist');
    }
    const data = snapshot.val();
    if (data.state.status !== 'lobby') {
      return alert('Game has already started');
    }
    // 加入 players 節點
    db.ref(`rooms/${roomId}/players/${playerId}`)
      .set({ nick: myNick, groupId: null, position: 0, score: 0 })
      .then(() => {
        isHost = false;
        setupRoomListeners();
        showRoomInfoUI();
        showToast(`Joined room: ${roomId}`);
      });
  });
});

// ===========================
// 6. 顯示房間資訊與 Group 選擇 UI
// ===========================
function showRoomInfoUI() {
  // 隱藏 Lobby 畫面
  document.getElementById('lobby').classList.add('hidden');
  // 顯示房間內頁 (可選擇組別、房號、玩家列表)
  roomInfoDiv.classList.remove('hidden');
  roomIdShow.innerText = roomId;

  // 如果是房主，顯示 Start Game 按鈕
  if (isHost) {
    hostControls.classList.remove('hidden');
  }
}

// ===========================
// 7. 設定 Firebase 監聽器
//    7.1 players：更新 playersData 並重繪 Lobby 畫面
//    7.2 state.status：若變成 "playing" 則進入遊戲介面
//    7.3 state.startTime：取得遊戲開始 timestamp (ms)
//    7.4 state.groupOrder：儲存正在比賽的組別清單，並重繪位置
//    7.5 state.turnIndex：更新當前輪到哪組 (並啟動 5 秒自動擲骰)
//    7.6 state.questionInProgress：若 false，隱藏 Roll 按鈕
//    7.7 positions：更新 positionsData 並重繪位置
//    7.8 events.child_added：處理所有新事件，過濾時間 < startTime 的舊事件
// ===========================
function setupRoomListeners() {
  dbRefRoom       = db.ref(`rooms/${roomId}`);
  dbRefPlayers    = db.ref(`rooms/${roomId}/players`);
  dbRefState      = db.ref(`rooms/${roomId}/state`);
  dbRefGroupOrder = db.ref(`rooms/${roomId}/state/groupOrder`);
  dbRefEvents     = db.ref(`rooms/${roomId}/events`);
  dbRefPositions  = db.ref(`rooms/${roomId}/positions`);

  // 7.1 監聽 players：更新本地玩家資料、重繪 Lobby 畫面
  dbRefPlayers.on('value', snap => {
    playersData = snap.val() || {};
    renderPlayersAndGroups();
  });

  // 7.2 監聽 state.status：若變成 "playing"，則進入遊戲主畫面
  dbRefState.child('status').on('value', snap => {
    if (snap.val() === 'playing') {
      enterGameUI();
    }
  });

  // 7.3 監聽 state.startTime：取得遊戲真正開始的 timestamp
  dbRefState.child('startTime').on('value', snap => {
    gameStartTime = snap.val() || 0;
  });

  // 7.4 監聽 state.groupOrder：取得目前輪到的組別順序，並重繪位置
  dbRefGroupOrder.on('value', snap => {
    groupOrder = snap.val() || [];
    renderPositions();
  });

  // 7.5 監聽 state.turnIndex：取得索引並更新畫面 (含 5 秒自動擲骰)
  dbRefState.child('turnIndex').on('value', snap => {
    updateTurnDisplay();
  });

  // 7.6 監聽 state.questionInProgress：若 false，隱藏 Roll 按鈕
  dbRefState.child('questionInProgress').on('value', snap => {
    if (!snap.val()) {
      btnRoll.classList.add('hidden');
    }
  });

  // 7.7 監聽 positions：取得各組位置資料，並重繪位置列表
  dbRefPositions.on('value', snap => {
    positionsData = snap.val() || {};
    renderPositions();
  });

  // 7.8 監聽 events.child_added：新增事件時逐一處理，但過濾掉 startTime 之前的舊事件
  dbRefEvents.on('child_added', snap => {
    const ev = snap.val();
    // 如果事件的 timestamp < gameStartTime → 跳過 (舊殘留事件不處理)
    if (gameStartTime && ev.timestamp < gameStartTime) {
      return;
    }
    handleGameEvent(ev);
  });
}

// ===========================
// 8. 顯示 players 列表 & 各組人數 (Lobby 畫面)
//    8.1 將 playersData 中的玩家依照 groupId 分到六個桶子
//    8.2 顯示玩家清單
//    8.3 顯示每個 group 底下有哪些玩家；若空組顯示 “–”
// ===========================
function renderPlayersAndGroups() {
  playerListUl.innerHTML = '';
  groupListUl.innerHTML  = '';

  // 準備 6 個桶子 (group1…group6)，先都清空
  const groupBuckets = {
    group1: [], group2: [], group3: [],
    group4: [], group5: [], group6: []
  };

  // 遍歷所有玩家，把他們加入自己所屬的桶子
  Object.entries(playersData).forEach(([pid, info]) => {
    // (1) 顯示玩家清單
    const li = document.createElement('li');
    li.innerText = `${info.nick} (${info.groupId || 'No group'})`;
    playerListUl.appendChild(li);

    // (2) 若玩家已經選擇了 groupId，將其加入對應 bucket
    if (info.groupId && groupBuckets[info.groupId]) {
      groupBuckets[info.groupId].push(info.nick);
    }
  });

  // 8.3 顯示各組底下有哪些玩家；若 names 陣列為空，就顯示 “–”
  Object.entries(groupBuckets).forEach(([grp, names]) => {
    const li = document.createElement('li');
    li.innerText = `${grp}: ${names.length > 0 ? names.join(', ') : '–'}`;
    groupListUl.appendChild(li);
  });
}

// ===========================
// 9. 一般玩家「Join Group」按鈕事件
//    9.1 讀取下拉選單 selGroup 的值，寫到 /rooms/{roomId}/players/{playerId}/groupId
//    9.2 顯示 Toast 提示
// ===========================
btnJoinGroup.addEventListener('click', () => {
  const chosenGrp = selGroup.value; // 例如 "group3"
  if (!roomId) return;
  db.ref(`rooms/${roomId}/players/${playerId}/groupId`).set(chosenGrp);
  showToast(`Joined ${chosenGrp}`);
});

// ===========================
// 10. 房主「Start Game」按鈕事件
//     10.1 檢查至少要有兩位玩家分組完成 (groupId != null)
//     10.2 將 playersData 依 groupId 收集到六個 bucket
//     10.3 過濾掉空的 bucket，只保留有玩家的組，並隨機打散排序
//     10.4 計算遊戲結束時間 (gameEndTime = now + 300 秒)，並記錄 startTime
//     10.5 在開始前先移除所有舊的 /events 和 /answerBuffer
//     10.6 更新 state：status = "playing", groupOrder, turnIndex, questionInProgress, gameEndTime, startTime
// ===========================
btnStart.addEventListener('click', async () => {
  // 10.1 把 playersData 中的所有 groupId 收集，排除 null，至少 2 人才可開始
  const assignedCount = Object.values(playersData)
    .map(p => p.groupId)
    .filter(g => g !== null).length;
  if (assignedCount < 2) {
    return alert('At least two players must join groups to start.');
  }

  // 10.2 建立六個 bucket，把同組玩家的 playerId 收集起來
  const groupBuckets = {
    group1: [], group2: [], group3: [],
    group4: [], group5: [], group6: []
  };
  Object.entries(playersData).forEach(([pid, info]) => {
    if (info.groupId && groupBuckets[info.groupId]) {
      groupBuckets[info.groupId].push(pid);
    }
  });

  // 10.3 過濾掉空的 bucket (length === 0) → 只保留有成員的組別 → 隨機打散成 groupOrder
  const nonEmptyGroups = Object.entries(groupBuckets)
    .filter(([gid, arr]) => arr.length > 0)
    .map(([gid]) => gid);
  const randomizedOrder = shuffleArray(nonEmptyGroups);

  // 10.4 計算 now、endTs = now + 300s (遊戲總時長 5 分鐘)
  const nowTs = Date.now();
  const endTs = nowTs + TOTAL_GAME_TIME * 1000;

  // 10.5 清空舊的 events（所有 rollDice/askQuestion/afterAnswer 都會在這裡）
  await dbRefRoom.child('events').remove();
  // 同時也清空舊的 answerBuffer，避免殘留答案影響
  await dbRefRoom.child('answerBuffer').remove();

  // 10.6 更新 state 資訊 (一次寫入)
  await dbRefState.update({
    status: 'playing',
    groupOrder: randomizedOrder,
    turnIndex: 0,
    questionInProgress: false,
    gameEndTime: endTs,
    startTime: nowTs
  });
});

// ===========================
// 11. 進入遊戲介面
//     11.1 隱藏 Lobby/Group 選擇畫面
//     11.2 顯示遊戲主畫面 & 啟動遊戲主循環
// ===========================
function enterGameUI() {
  roomInfoDiv.classList.add('hidden');
  gameDiv.classList.remove('hidden');
  startGameLoop();
}

// ===========================
// 12. 遊戲主循環：更新剩餘時間 & 首次顯示輪到哪一組
//     12.1 讀取 state.gameEndTime，計算倒數秒數 → 每秒更新一次
//     12.2 若倒數 <= 0，自動結束遊戲
//     12.3 同步呼叫 updateTurnDisplay() 顯示第一個 turn
// ===========================
let gameTimerInterval = null;
async function startGameLoop() {
  // 12.1 從 DB 拿 gameEndTime
  const snap = await dbRefState.child('gameEndTime').get();
  const endTs = snap.val() || (Date.now() + TOTAL_GAME_TIME * 1000);

  // 12.2 每秒更新畫面上剩餘秒數
  gameTimerInterval = setInterval(() => {
    const remain = Math.max(0, Math.floor((endTs - Date.now()) / 1000));
    timerSpan.innerText = remain;
    if (remain <= 0) {
      clearInterval(gameTimerInterval);
      endGame();
    }
  }, 1000);

  // 12.3 顯示第一次輪到哪組
  updateTurnDisplay();
}

// ===========================
// 13. 正確版 updateTurnDisplay()
//     13.1 一開始就清除所有舊的計時器 (避免前一組的 5s 或 10s 計時器影響)
//     13.2 隱藏題目 UI、隱藏按鈕、隱藏提示文字
//     13.3 從 state.turnIndex 拿到現在在輪到哪一組 groupId
//     13.4 如果輪到我的組 (playerId 對應的 groupId)，顯示 Roll 按鈕並啟動 5s 自動擲骰
//     13.5 否則顯示「Not your turn」提示
// ===========================
function updateTurnDisplay() {
  // 13.1 清除上一組的所有計時器
  clearTimeout(diceTimeoutHandle);
  clearTimeout(questionTimeoutHandle);
  clearInterval(questionCountdown);

  // 13.2 隱藏題目區與所有互動元件
  questionArea.classList.add('hidden');
  btnSubmitAns.classList.add('hidden');
  btnRoll.classList.add('hidden');
  nonTurnMsg.classList.add('hidden');

  // 13.3 拿當前 turnIndex → 計算出 groupId
  dbRefState.child('turnIndex').get().then(snap => {
    const turnIdx = snap.val() || 0;
    const groupId = groupOrder[turnIdx % groupOrder.length] || '';

    orderInfo.innerText = `Order: ${groupOrder.join(' → ')}`;
    turnInfo.innerText  = `Current Turn: ${groupId}`;

    // 13.4 如果輪到的是我的組，就顯示 Roll 按鈕，並且 5s 後自動擲骰
    const myGroup = playersData[playerId]?.groupId;
    if (myGroup === groupId) {
      btnRoll.classList.remove('hidden');
      diceTimeoutHandle = setTimeout(() => {
        showToast('5 s elapsed → auto‐rolling');
        rollDiceAndPublish();
      }, DICE_TIMEOUT);
    } else {
      // 13.5 否則顯示「Not your turn」提示
      nonTurnMsg.classList.remove('hidden');
    }
  });
}

// ===========================
// 14. 正確版 rollDiceAndPublish()
//     14.1 確認目前沒有題目在進行 (state.questionInProgress === false)
//     14.2 隨機擲出 1~6 點
//     14.3 推送 rollDice 事件到 /events
//     14.4 更新 state.questionInProgress = true (避免重複擲骰)
//     14.5 立即更新該組位置 (oldPos + dice)
//     14.6 隨機從 questions.json 中挑題、打亂選項順序
//     14.7 清空 answerBuffer (保證答案是本回合最新)
//     14.8 延遲 300 毫秒後推送 askQuestion 事件
//     14.9 啟動 10 秒自動送答案計時器 (若 10s 過仍未按 Submit，就視為 null)
// ===========================
async function rollDiceAndPublish() {
  // 14.1 如果目前有題目正在進行，就不允許再擲骰
  const inProgSnap = await dbRefState.child('questionInProgress').get();
  if (inProgSnap.val()) {
    return;
  }

  // 14.2 隨機滾 1~6
  const dice = Math.floor(Math.random() * 6) + 1;

  // 14.3 推送 rollDice 事件
  const evKey = dbRefEvents.push().key;
  const myGrp = playersData[playerId]?.groupId;
  const evData = {
    type: 'rollDice',
    groupId: myGrp,
    dice,
    timestamp: Date.now()
  };
  await dbRefEvents.child(evKey).set(evData);

  // 14.4 將 questionInProgress 設為 true，避免重複擲骰
  await dbRefState.update({ questionInProgress: true });

  // 14.5 立即更新該組位置 (oldPos + dice)
  const oldPos = positionsData[myGrp] || 0;
  const newPos = Math.max(0, oldPos + dice);
  await dbRefPositions.child(myGrp).set(newPos);

  // 14.6 隨機挑題：先 fetch JSON，再打亂 options
  const questions = await fetch('questions.json').then(r => r.json());
  const chosenQ  = questions[Math.floor(Math.random() * questions.length)];
  const choices  = shuffleArray(chosenQ.options.slice());

  // 14.7 清空 answerBuffer，確保每回合的答案都是新的
  await dbRefRoom.child('answerBuffer').remove();

  // 14.8 在 300ms 之後 push askQuestion 事件 (讓 UI 先顯示「Group rolled: Y」)
  setTimeout(async () => {
    const qKey = dbRefEvents.push().key;
    await dbRefEvents.child(qKey).set({
      type: 'askQuestion',
      groupId: myGrp,
      question: chosenQ.question,
      choices,
      answer: chosenQ.answer,
      timestamp: Date.now()
    });
  }, 300);

  // 14.9 啟動 10s 自動送答案計時器
  questionTimeoutHandle = setTimeout(() => {
    submitAnswer(null);
  }, ANSWER_TIMEOUT);
}

// ===========================
// 15. 處理來自 /events 的新事件 (rollDice / askQuestion / afterAnswer)
//     15.1 先過濾掉 timestamp < gameStartTime 的舊事件
//     15.2 如果是 rollDice：顯示 Toast，並隱藏 Roll 按鈕
//     15.3 如果是 askQuestion 且發給「輪到的那一組」：呼叫 showQuestionUI()
//     15.4 如果是 afterAnswer：顯示 Toast，並呼叫 goToNextTurn()
// ===========================
async function handleGameEvent(ev) {
  // 15.1 忽略舊事件 (時間戳小於遊戲真正開始時間)
  if (gameStartTime && ev.timestamp < gameStartTime) {
    return;
  }

  if (ev.type === 'rollDice') {
    // 15.2 顯示「Group X rolled: Y」提示，並隱藏 Roll 按鈕
    showToast(`Group ${ev.groupId} rolled: ${ev.dice}`);
    btnRoll.classList.add('hidden');
  }
  else if (ev.type === 'askQuestion') {
    // 15.3 僅有「輪到的那組」才看得到題目
    const turnIdx   = await dbRefState.child('turnIndex').get().then(s => s.val());
    const currentGrp = groupOrder[turnIdx % groupOrder.length];
    if (ev.groupId !== currentGrp) {
      return;
    }
    showQuestionUI(ev.question, ev.choices, ev.answer);
  }
  else if (ev.type === 'afterAnswer') {
    // 15.4 顯示「Group X Δ = ±N」提示，並切換到下一組
    showToast(`Group ${ev.groupId} Δ = ${ev.delta}`);
    goToNextTurn();
  }
}

// ===========================
// 16. showQuestionUI()
//     16.1 顯示題目區、Submit 按鈕，隱藏「Not your turn」
//     16.2 更新題目文字、正確答案 (correctAnswer)
//     16.3 動態插入 radio 按鈕選項
//     16.4 啟動 10 秒倒數 (每秒更新「Time Left」)，若歸零就 submitAnswer(null)
//     16.5 綁定 Submit 按鈕點擊事件，送出 answer
// ===========================
function showQuestionUI(questionText, choices, answerKey) {
  // 16.1 顯示題目區與 Submit 按鈕
  questionArea.classList.remove('hidden');
  btnSubmitAns.classList.remove('hidden');
  nonTurnMsg.classList.add('hidden');

  // 16.2 設定題目文字與正確答案
  qText.innerText     = questionText;
  correctAnswer       = answerKey.trim().toUpperCase();

  // 16.3 動態插入 radio 按鈕選項
  choicesList.innerHTML = '';
  choices.forEach((opt) => {
    const label = document.createElement('label');
    label.innerHTML = `
      <input type="radio" name="choice" value="${opt.charAt(0)}" />
      ${opt}
    `;
    choicesList.appendChild(label);
  });

  // 16.4 啟動 10 秒倒數，每秒更新「Time Left: X s」
  let timeLeft = ANSWER_TIMEOUT / 1000;
  questionTimer.innerText = timeLeft;
  clearInterval(questionCountdown);
  questionCountdown = setInterval(() => {
    timeLeft--;
    questionTimer.innerText = timeLeft;
    if (timeLeft <= 0) {
      clearInterval(questionCountdown);
      submitAnswer(null); // 10 秒到，自動送出 null
    }
  }, 1000);

  // 16.5 綁定 Submit 按鈕點擊事件
  btnSubmitAns.onclick = () => {
    const checked = document.querySelector('input[name="choice"]:checked');
    const selected = checked ? checked.value.trim().toUpperCase() : null;
    clearInterval(questionCountdown);
    submitAnswer(selected);
  };
}

// ===========================
// 17. submitAnswer(answer)
//     17.1 立即清除 10 秒 auto‐submit 計時器 (questionTimeoutHandle)
//     17.2 隱藏題目區、Submit 按鈕
//     17.3 將 answer 寫入 /answerBuffer/{playerId}
//     17.4 檢查組內所有成員是否都已經回答，若全部回答則呼叫 processAnswers()
// ===========================
async function submitAnswer(answer) {
  // 17.1 清除 10 秒自動送答計時器與倒數 interval
  clearTimeout(questionTimeoutHandle);
  clearInterval(questionCountdown);

  // 17.2 隱藏題目區與 Submit 按鈕
  questionArea.classList.add('hidden');
  btnSubmitAns.classList.add('hidden');

  // 17.3 將 answer 寫入 /rooms/{roomId}/answerBuffer/{playerId}
  const ansToWrite = (answer || '').toString().trim().toUpperCase();
  await dbRefRoom.child(`answerBuffer/${playerId}`).set(ansToWrite);

  // 17.4 檢查本組所有成員是否都已作答
  const myGrp = playersData[playerId]?.groupId;
  if (!myGrp) return;

  // 找出本組成員清單
  const members = Object.entries(playersData)
    .filter(([, info]) => info.groupId === myGrp)
    .map(([pid]) => pid);

  // 一次讀取整個 answerBuffer
  const snap = await db.ref(`rooms/${roomId}/answerBuffer`).get();
  const buf  = snap.val() || {};
  // 計算有在 buffer 中表示已回答的人數
  const answeredCount = members.filter(pid => buf[pid] !== undefined).length;

  // 如果本組所有成員都回答，立刻進行 processAnswers()
  if (answeredCount >= members.length) {
    processAnswers();
  }
}

// ===========================
// 18. processAnswers()
//     18.1 先把 questionInProgress 設回 false
//     18.2 讀取 state.turnIndex → 得到目前該組 groupId
//     18.3 讀取 /answerBuffer → 計算本組答對人數 correctCount
//     18.4 計算 delta：全部答對 +2；少於半組 退 (size×2)；否則 0
//     18.5 更新該組位置 (positionsData + delta)，寫回 /positions
//     18.6 推送 one afterAnswer 事件到 /rooms/{roomId}/events
//     18.7 呼叫 goToNextTurn()
// ===========================
async function processAnswers() {
  // 18.1 將 questionInProgress 設回 false，準備下一輪
  await dbRefState.update({ questionInProgress: false });

  // 18.2 從 Database 拿 turnIndex → 計算出 grpId
  const turnIdx = await dbRefState.child('turnIndex').get().then(s => s.val());
  const grpId   = groupOrder[turnIdx % groupOrder.length];

  // 18.3 拿出整個 answerBuffer，計算本組正確人數
  const snapBuf = await db.ref(`rooms/${roomId}/answerBuffer`).get();
  const bufData = snapBuf.val() || {};

  const members = Object.entries(playersData)
    .filter(([, info]) => info.groupId === grpId)
    .map(([pid]) => pid);

  let correctCount = 0;
  members.forEach(pid => {
    const ans = (bufData[pid] || '').toString().trim().toUpperCase();
    if (ans === correctAnswer) correctCount++;
  });
  const groupSize = members.length;

  // 18.4 根據答對人數計算 delta
  let delta = 0;
  if (correctCount === groupSize) {
    // 全組都答對 → +2
    delta = +2;
  } else if (correctCount < groupSize / 2) {
    // 小於半組人數 → 退 (size × 2)
    delta = -(groupSize * 2);
  } else {
    // 其餘情況 → delta = 0
    delta = 0;
  }

  // 18.5 更新該組位置 (最少為 0)
  const oldPos = positionsData[grpId] || 0;
  const newPos = Math.max(0, oldPos + delta);
  await dbRefPositions.child(grpId).set(newPos);

  // 18.6 推送一筆 afterAnswer 事件到 /events
  const afterKey = dbRefEvents.push().key;
  await dbRefEvents.child(afterKey).set({
    type: 'afterAnswer',
    groupId: grpId,
    correctCount,
    delta,
    timestamp: Date.now()
  });

  // 18.7 切換到下一組
  goToNextTurn();
}

// ===========================
// 19. goToNextTurn()
//     19.1 拿當前 turnIndex，做 mod(groupOrder.length) → 下一索引
//     19.2 更新 state.turnIndex，觸發 updateTurnDisplay()
// ===========================
async function goToNextTurn() {
  const turnIdx = await dbRefState.child('turnIndex').get().then(s => s.val());
  const nextIdx = (turnIdx + 1) % groupOrder.length;
  await dbRefState.update({ turnIndex: nextIdx });
}

// ===========================
// 20. renderPositions()
//     20.1 清空 posListUl
//     20.2 只依照 groupOrder 中的組別順序顯示 (非空組、正在比賽)
// ===========================
function renderPositions() {
  posListUl.innerHTML = '';
  groupOrder.forEach(grp => {
    if (positionsData.hasOwnProperty(grp)) {
      const li = document.createElement('li');
      li.innerText = `${grp}: ${positionsData[grp]}`;
      posListUl.appendChild(li);
    }
  });
}

// ===========================
// 21. endGame()
//     21.1 隱藏遊戲畫面、顯示結果畫面
//     21.2 根據 positionsData 排序，顯示最終排名
// ===========================
async function endGame() {
  gameDiv.classList.add('hidden');
  resultDiv.classList.remove('hidden');

  // 21.2 排序邏輯：依照各組最終 position (score) 大到小
  const ranking = Object.entries(playersData)
    .map(([, info]) => ({
      nick: info.nick,
      score: positionsData[info.groupId] || 0
    }))
    .sort((a, b) => b.score - a.score);

  rankListOl.innerHTML = '';
  ranking.forEach((p, idx) => {
    const li = document.createElement('li');
    li.innerText = `${idx + 1}. ${p.nick} (Position: ${p.score})`;
    rankListOl.appendChild(li);
  });
}

// ===========================
// 22. 監聽 gameEndTime，自動結束遊戲
//     22.1 如果現在時間已經超過 gameEndTime → 直接呼叫 endGame()
//     22.2 否則在剩餘時間到時 (setTimeout)，呼叫 endGame()
// ===========================
dbRefState?.child('gameEndTime').on('value', snap => {
  const endTs = snap.val();
  if (!endTs) return;
  const now = Date.now();
  const delay = endTs - now;
  if (delay <= 0) {
    endGame();
  } else {
    setTimeout(() => {
      endGame();
    }, delay);
  }
});
