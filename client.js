// ======================================
// client.js
// Multiplayer English Game – Firebase 版本
// 以下註解說明重點改動處
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
// 2. 常數與全域狀態
// ===========================
const TOAST_DURATION = 2000;   // Toast 顯示 2 秒
const DICE_TIMEOUT    = 5000;  // 5 秒自動擲骰
const ANSWER_TIMEOUT  = 10000; // 10 秒自動送出答案
const TOTAL_GAME_TIME = 300;   // 總共 300 秒遊戲時間 (5 分鐘)

// 隨機產生自己的 playerId (8 碼字母數字)
const playerId = Math.random().toString(36).substr(2, 8);

let myNick  = '';     // 我自己的暱稱
let roomId  = '';     // 房號
let isHost  = false;  // 我是否為房主

// Firebase Database 參考
let dbRefRoom       = null; // 指向 /rooms/{roomId}
let dbRefPlayers    = null; // 指向 /rooms/{roomId}/players
let dbRefState      = null; // 指向 /rooms/{roomId}/state
let dbRefGroupOrder = null; // 指向 /rooms/{roomId}/state/groupOrder
let dbRefEvents     = null; // 指向 /rooms/{roomId}/events
let dbRefPositions  = null; // 指向 /rooms/{roomId}/positions

// 本地暫存從 Firebase 拿到的資料
let playersData   = {};    // { playerId: {nick, groupId, position, score}, … }
let groupOrder    = [];    // ["group3","group1",…]  (只留有人的組並打亂)
let positionsData = {};    // { group1:0, group2:0, …, group6:0 }
let gameStartTime = 0;     // 真正遊戲開始的 timestamp (ms)
let correctAnswer = '';    // 當前題目的正確答案

// 計時器 handle
let diceTimeoutHandle     = null; // 5 秒 auto-roll
let questionTimeoutHandle = null; // 10 秒 auto-submit
let questionCountdown     = null; // 每秒更新「Time Left」

// ===========================
// 3. 公用輔助函式
// ===========================
function showToast(msg) {
  const div = document.createElement('div');
  div.classList.add('toast');
  div.innerText = msg;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), TOAST_DURATION);
}

function shuffleArray(arr) {
  return arr
    .map(v => ({ val: v, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(o => o.val);
}

// ===========================
// 4. 房主按「Create Room」
// ===========================
btnCreate.addEventListener('click', async () => {
  myNick = nickInput.value.trim();
  if (!myNick) return alert('Please enter a nickname');

  // 4.1 產生 5 碼大寫房號，不重複
  let newId;
  while (true) {
    newId = Math.random().toString(36).substr(2, 5).toUpperCase();
    const exists = await db.ref(`rooms/${newId}`).get();
    if (!exists.exists()) break;
  }
  roomId = newId;
  isHost = true;

  // 4.2 初始化 Firebase 結構
  const roomRef = db.ref(`rooms/${roomId}`);
  await roomRef.set({
    players: {
      [playerId]: { nick: myNick, groupId: null, position: 0, score: 0 }
    },
    state: {
      status: 'lobby',
      groupOrder: [],
      turnIndex: 0,
      questionInProgress: false,
      gameEndTime: 0,
      startTime: 0
    },
    positions: {
      group1: 0, group2: 0, group3: 0,
      group4: 0, group5: 0, group6: 0
    },
    events: {},
    answerBuffer: {}
  });

  setupRoomListeners();
  showRoomInfoUI();
  showToast(`Room created: ${roomId}`);
});

// ===========================
// 5. 一般玩家按「Join Room」
// ===========================
btnJoin.addEventListener('click', () => {
  myNick = nickInput.value.trim();
  roomId = roomIdIn.value.trim().toUpperCase();
  if (!myNick) return alert('Please enter a nickname');
  if (!roomId) return alert('Please enter a Room ID');

  const roomRef = db.ref(`rooms/${roomId}`);
  roomRef.get().then(snapshot => {
    if (!snapshot.exists()) return alert('Room does not exist');
    const data = snapshot.val();
    if (data.state.status !== 'lobby') return alert('Game has already started');

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
// 6. 顯示房間內頁 (Group 選擇)
// ===========================
function showRoomInfoUI() {
  document.getElementById('lobby').classList.add('hidden');
  roomInfoDiv.classList.remove('hidden');
  roomIdShow.innerText = roomId;
  if (isHost) hostControls.classList.remove('hidden');
}

// ===========================
// 7. 設定 Firebase 監聽
// ===========================
function setupRoomListeners() {
  dbRefRoom       = db.ref(`rooms/${roomId}`);
  dbRefPlayers    = db.ref(`rooms/${roomId}/players`);
  dbRefState      = db.ref(`rooms/${roomId}/state`);
  dbRefGroupOrder = db.ref(`rooms/${roomId}/state/groupOrder`);
  dbRefEvents     = db.ref(`rooms/${roomId}/events`);
  dbRefPositions  = db.ref(`rooms/${roomId}/positions`);

  // 7.1 監聽 players
  dbRefPlayers.on('value', snap => {
    playersData = snap.val() || {};
    renderPlayersAndGroups();
  });

  // 7.2 監聽 state.status
  dbRefState.child('status').on('value', snap => {
    if (snap.val() === 'playing') enterGameUI();
  });

  // 7.3 監聽 state.startTime
  dbRefState.child('startTime').on('value', snap => {
    gameStartTime = snap.val() || 0;
  });

  // 7.4 監聽 state.groupOrder
  dbRefGroupOrder.on('value', snap => {
    groupOrder = snap.val() || [];
    renderPositions();
  });

  // 7.5 監聽 state.turnIndex
  dbRefState.child('turnIndex').on('value', snap => {
    updateTurnDisplay();
  });

  // 7.6 監聽 state.questionInProgress
  dbRefState.child('questionInProgress').on('value', snap => {
    if (!snap.val()) btnRoll.classList.add('hidden');
  });

  // 7.7 監聽 positions
  dbRefPositions.on('value', snap => {
    positionsData = snap.val() || {};
    renderPositions();
  });

  // 7.8 監聽 events.child_added
  dbRefEvents.on('child_added', snap => {
    const ev = snap.val();
    if (gameStartTime && ev.timestamp < gameStartTime) return;
    handleGameEvent(ev);
  });
}

// ===========================
// 8. 渲染 Lobby 玩家與組別狀態
// ===========================
function renderPlayersAndGroups() {
  playerListUl.innerHTML = '';
  groupListUl.innerHTML  = '';

  const groupBuckets = {
    group1: [], group2: [], group3: [],
    group4: [], group5: [], group6: []
  };

  Object.entries(playersData).forEach(([pid, info]) => {
    // 顯示玩家清單
    const li = document.createElement('li');
    li.innerText = `${info.nick} (${info.groupId || 'No group'})`;
    playerListUl.appendChild(li);

    // 加入對應桶子
    if (info.groupId && groupBuckets[info.groupId]) {
      groupBuckets[info.groupId].push(info.nick);
    }
  });

  // 顯示每組成員，若空則顯示 “–”
  Object.entries(groupBuckets).forEach(([grp, names]) => {
    const li = document.createElement('li');
    li.innerText = `${grp}: ${names.length > 0 ? names.join(', ') : '–'}`;
    groupListUl.appendChild(li);
  });
}

// ===========================
// 9. 玩家按「Join Group」
// ===========================
btnJoinGroup.addEventListener('click', () => {
  const chosenGrp = selGroup.value;
  if (!roomId) return;
  db.ref(`rooms/${roomId}/players/${playerId}/groupId`).set(chosenGrp);
  showToast(`Joined ${chosenGrp}`);
});

// ===========================
// 10. 房主按「Start Game」
// ===========================
btnStart.addEventListener('click', async () => {
  // 10.1 至少須有 2 個玩家分組
  const assignedCount = Object.values(playersData)
    .map(p => p.groupId)
    .filter(g => g !== null).length;
  if (assignedCount < 2) {
    return alert('At least two players must join groups to start.');
  }

  // 10.2 建立 6 個桶子
  const groupBuckets = {
    group1: [], group2: [], group3: [],
    group4: [], group5: [], group6: []
  };
  Object.entries(playersData).forEach(([pid, info]) => {
    if (info.groupId && groupBuckets[info.groupId]) {
      groupBuckets[info.groupId].push(pid);
    }
  });

  // 10.3 過濾掉空組，打亂順序
  const nonEmptyGroups = Object.entries(groupBuckets)
    .filter(([gid, arr]) => arr.length > 0)
    .map(([gid]) => gid);
  const randomizedOrder = shuffleArray(nonEmptyGroups);

  // 10.4 計算遊戲結束時間與開始時間
  const nowTs = Date.now();
  const endTs = nowTs + TOTAL_GAME_TIME * 1000;

  // 10.5 清空舊的 events 及 answerBuffer
  await dbRefRoom.child('events').remove();
  await dbRefRoom.child('answerBuffer').remove();

  // 10.6 更新 state
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
// ===========================
function enterGameUI() {
  roomInfoDiv.classList.add('hidden');
  gameDiv.classList.remove('hidden');
  startGameLoop();
}

// ===========================
// 12. 遊戲主循環：更新剩餘時間 & 首次顯示 turn
// ===========================
let gameTimerInterval = null;
async function startGameLoop() {
  // 12.1 取得 gameEndTime
  const snap = await dbRefState.child('gameEndTime').get();
  const endTs = snap.val() || (Date.now() + TOTAL_GAME_TIME * 1000);

  // 12.2 每秒更新剩餘秒數
  gameTimerInterval = setInterval(() => {
    const remain = Math.max(0, Math.floor((endTs - Date.now()) / 1000));
    timerSpan.innerText = remain;
    if (remain <= 0) {
      clearInterval(gameTimerInterval);
      endGame();
    }
  }, 1000);

  // 12.3 顯示第一次 turn
  updateTurnDisplay();
}

// ===========================
// 13. 修正版 updateTurnDisplay()
//     ● 先清掉所有舊計時器 (5s auto-roll, 10s auto-submit, 1s countdown)  
//     ● 隱藏題目區、按鈕、提示  
//     ● 讀取 turnIndex，顯示「Current Turn」  
//     ● 如果輪到自己那組，顯示 Roll 按鈕並啟動 5s auto-roll  
//     ● 否則顯示「Not your turn」
// ===========================
function updateTurnDisplay() {
  // 13.1 清除上一輪的所有計時器
  clearTimeout(diceTimeoutHandle);
  clearTimeout(questionTimeoutHandle);
  clearInterval(questionCountdown);

  // 13.2 隱藏題目區與所有互動元件
  questionArea.classList.add('hidden');
  btnSubmitAns.classList.add('hidden');
  btnRoll.classList.add('hidden');
  nonTurnMsg.classList.add('hidden');

  // 13.3 讀取 turnIndex → 計算所在 groupId
  dbRefState.child('turnIndex').get().then(snap => {
    const turnIdx = snap.val() || 0;
    const groupId = groupOrder[turnIdx % groupOrder.length] || '';

    orderInfo.innerText = `Order: ${groupOrder.join(' → ')}`;
    turnInfo.innerText  = `Current Turn: ${groupId}`;

    const myGroup = playersData[playerId]?.groupId;
    // 13.4 如果輪到我的組，就顯示 Roll 按鈕並啟動 5s auto-roll
    if (myGroup === groupId) {
      btnRoll.classList.remove('hidden');
      diceTimeoutHandle = setTimeout(() => {
        showToast('5 s elapsed → auto‐rolling');
        rollDiceAndPublish();
      }, DICE_TIMEOUT);
    } else {
      // 13.5 否則顯示「Not your turn」
      nonTurnMsg.classList.remove('hidden');
    }
  });
}

// ===========================
// 14. 修正版 rollDiceAndPublish()
//     ● 先判斷 questionInProgress 是否為 false  
//     ● 推送 rollDice 事件、更新位置、將 questionInProgress 設 true  
//     ● 隨機挑題、打亂選項  
//     ● 清空 answerBuffer  
//     ● 延遲 300ms 後推送 askQuestion  
//     (改動：將 10s auto-submit 移到 showQuestionUI 裡執行)  
// ===========================
async function rollDiceAndPublish() {
  // 14.1 避免重複擲骰
  const inProgSnap = await dbRefState.child('questionInProgress').get();
  if (inProgSnap.val()) return;

  // 14.2 隨機擲 1~6
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

  // 14.4 把 questionInProgress 設 true
  await dbRefState.update({ questionInProgress: true });

  // 14.5 立即更新該組位置 (oldPos + dice)
  const oldPos = positionsData[myGrp] || 0;
  const newPos = Math.max(0, oldPos + dice);
  await dbRefPositions.child(myGrp).set(newPos);

  // 14.6 隨機挑題，打亂選項
  const questions = await fetch('questions.json').then(r => r.json());
  const chosenQ  = questions[Math.floor(Math.random() * questions.length)];
  const choices  = shuffleArray(chosenQ.options.slice());

  // 14.7 清空 answerBuffer
  await dbRefRoom.child('answerBuffer').remove();

  // 14.8 延遲 300 ms 後推送 askQuestion 事件
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

  // 14.9 ❶ 原本放到這裡的 10 秒 auto-submit 移除  
  //    ❷ 現在改成在 showQuestionUI() 開始時才啟動  
}

// ===========================
// 15. 修正版 handleGameEvent(ev)
//     ● 過濾 timestamp < gameStartTime 的舊事件  
//     ● rollDice: 顯示 Toast 並隱藏 Roll 按鈕  
//     ● askQuestion: 僅「輪到該組」執行 showQuestionUI()  
//       (改動：在 showQuestionUI 開啟 10s auto-submit)  
//     ● afterAnswer: 顯示 Toast 並切換到下一組  
// ===========================
async function handleGameEvent(ev) {
  // 15.1 過濾遊戲開始前的殘留事件
  if (gameStartTime && ev.timestamp < gameStartTime) return;

  if (ev.type === 'rollDice') {
    // 15.2 顯示骰子結果，隱藏 Roll 按鈕
    showToast(`Group ${ev.groupId} rolled: ${ev.dice}`);
    btnRoll.classList.add('hidden');
  }
  else if (ev.type === 'askQuestion') {
    // 15.3 只有輪到的那組才能執行 showQuestionUI
    const turnIdx    = await dbRefState.child('turnIndex').get().then(s => s.val());
    const currentGrp = groupOrder[turnIdx % groupOrder.length];
    if (ev.groupId !== currentGrp) return;
    showQuestionUI(ev.question, ev.choices, ev.answer);
  }
  else if (ev.type === 'afterAnswer') {
    // 15.4 顯示得分變動，切換下一組
    showToast(`Group ${ev.groupId} Δ = ${ev.delta}`);
    goToNextTurn();
  }
}

// ===========================
// 16. 修正版 showQuestionUI()
//     ● 顯示題目區與 Submit 按鈕  
//     ● 更新題目文字、正確答案 correctAnswer  
//     ● 動態插入選項 radio  
//     ● 啟動 10 秒倒數 (questionTimeoutHandle)  
//     ● 每秒更新「Time Left: X s」 (questionCountdown)  
//     ● 綁定 Submit 按鈕送出 answer  
// ===========================
function showQuestionUI(questionText, choices, answerKey) {
  // 16.1 顯示題目區及 Submit 按鈕
  questionArea.classList.remove('hidden');
  btnSubmitAns.classList.remove('hidden');
  nonTurnMsg.classList.add('hidden');

  // 16.2 更新題目文字與正確答案
  qText.innerText     = questionText;
  correctAnswer       = answerKey.trim().toUpperCase();

  // 16.3 動態插入 radio button 選項
  choicesList.innerHTML = '';
  choices.forEach((opt) => {
    const label = document.createElement('label');
    label.innerHTML = `
      <input type="radio" name="choice" value="${opt.charAt(0)}" />
      ${opt}
    `;
    choicesList.appendChild(label);
  });

  // 16.4 啟動 10 秒倒數 (auto-submit)
  let timeLeft = ANSWER_TIMEOUT / 1000;
  questionTimer.innerText = timeLeft;

  // 清除舊的倒數 interval（若有）
  clearInterval(questionCountdown);
  // 每秒更新「Time Left」
  questionCountdown = setInterval(() => {
    timeLeft--;
    questionTimer.innerText = timeLeft;
    if (timeLeft <= 0) {
      clearInterval(questionCountdown);
      submitAnswer(null);
    }
  }, 1000);

  // 啟動 10 秒 auto-submit
  questionTimeoutHandle = setTimeout(() => {
    submitAnswer(null);
  }, ANSWER_TIMEOUT);

  // 16.5 綁定 Submit 按鈕
  btnSubmitAns.onclick = () => {
    const checked = document.querySelector('input[name="choice"]:checked');
    const selected = checked ? checked.value.trim().toUpperCase() : null;
    clearInterval(questionCountdown);
    clearTimeout(questionTimeoutHandle);
    submitAnswer(selected);
  };
}

// ===========================
// 17. 修正版 submitAnswer(answer)
//     ● 一開始就清除 10 秒 auto-submit 和倒數 interval  
//     ● 隱藏題目區與 Submit 按鈕  
//     ● 將答題寫入 /answerBuffer/{playerId}  
//     ● 檢查本組所有成員是否都應答，若是則 processAnswers()  
// ===========================
async function submitAnswer(answer) {
  // 17.1 清除 10 秒 auto-submit 與倒數 interval
  clearTimeout(questionTimeoutHandle);
  clearInterval(questionCountdown);

  // 17.2 隱藏題目區與按鈕
  questionArea.classList.add('hidden');
  btnSubmitAns.classList.add('hidden');

  // 17.3 將答案寫入 Firebase
  const ansToWrite = (answer || '').toString().trim().toUpperCase();
  await dbRefRoom.child(`answerBuffer/${playerId}`).set(ansToWrite);

  // 17.4 檢查本組所有成員是否都已回答
  const myGrp = playersData[playerId]?.groupId;
  if (!myGrp) return;

  const members = Object.entries(playersData)
    .filter(([, info]) => info.groupId === myGrp)
    .map(([pid]) => pid);

  // 拿一次整個 answerBuffer
  const snap = await db.ref(`rooms/${roomId}/answerBuffer`).get();
  const buf  = snap.val() || {};
  const answeredCount = members.filter(pid => buf[pid] !== undefined).length;

  if (answeredCount >= members.length) {
    processAnswers();
  }
}

// ===========================
// 18. processAnswers()
//     ● 重置 questionInProgress = false  
//     ● 讀取 turnIndex 得到本組 groupId  
//     ● 從 answerBuffer 拿本組所有人答案，計算 correctCount  
//     ● 計算 delta，更新 position  
//     ● 推送 afterAnswer 事件  
//     ● 切換下一組  
// ===========================
async function processAnswers() {
  // 18.1 重置 questionInProgress
  await dbRefState.update({ questionInProgress: false });

  // 18.2 找到本組 groupId
  const turnIdx = await dbRefState.child('turnIndex').get().then(s => s.val());
  const grpId   = groupOrder[turnIdx % groupOrder.length];

  // 18.3 拿本組所有答案
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

  // 18.4 計算 delta
  let delta = 0;
  if (correctCount === groupSize) {
    delta = +2;
  } else if (correctCount < groupSize / 2) {
    delta = -(groupSize * 2);
  } else {
    delta = 0;
  }

  // 18.5 更新位置
  const oldPos = positionsData[grpId] || 0;
  const newPos = Math.max(0, oldPos + delta);
  await dbRefPositions.child(grpId).set(newPos);

  // 18.6 推送 afterAnswer 事件
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
//     ● 更新 turnIndex → 觸發 updateTurnDisplay()
// ===========================
async function goToNextTurn() {
  const turnIdx = await dbRefState.child('turnIndex').get().then(s => s.val());
  const nextIdx = (turnIdx + 1) % groupOrder.length;
  await dbRefState.update({ turnIndex: nextIdx });
}

// ===========================
// 20. renderPositions()
//     ● 只依照 groupOrder 列出正在比賽的組別與位置  
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
//     ● 隱藏遊戲畫面、顯示結果畫面  
//     ● 依 position 排序顯示最終名次  
// ===========================
async function endGame() {
  gameDiv.classList.add('hidden');
  resultDiv.classList.remove('hidden');

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
// ===========================
dbRefState?.child('gameEndTime').on('value', snap => {
  const endTs = snap.val();
  if (!endTs) return;
  const now = Date.now();
  const delay = endTs - now;
  if (delay <= 0) {
    endGame();
  } else {
    setTimeout(() => endGame(), delay);
  }
});
