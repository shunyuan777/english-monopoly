// ======================================
// client.js
// Multiplayer English Game – Firebase 版本
// 已修正：非本組不會看到題目，也不能作答
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
const TOTAL_GAME_TIME = 300;   // 300 秒 (5 分鐘)

const playerId = Math.random().toString(36).substr(2, 8);

let myNick  = '';
let roomId  = '';
let isHost  = false;

let dbRefRoom       = null;
let dbRefPlayers    = null;
let dbRefState      = null;
let dbRefGroupOrder = null;
let dbRefEvents     = null;
let dbRefPositions  = null;

let playersData   = {};    // { playerId: {nick, groupId, ...} }
let groupOrder    = [];    // e.g. ["group3","group1",...]
let positionsData = {};    // { group1:0, group2:0, ... }
let gameStartTime = 0;     // 真正開始 timestamp (ms)
let correctAnswer = '';    // 當前題目正確答案

let diceTimeoutHandle     = null;
let questionTimeoutHandle = null;
let questionCountdown     = null;

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

  let newId;
  while (true) {
    newId = Math.random().toString(36).substr(2, 5).toUpperCase();
    const exists = await db.ref(`rooms/${newId}`).get();
    if (!exists.exists()) break;
  }
  roomId = newId;
  isHost = true;

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
    // 過濾時間戳小於 gameStartTime 的舊事件
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

  // 顯示各組底下有哪些玩家；若空組顯示 “–”
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
  const assignedCount = Object.values(playersData)
    .map(p => p.groupId)
    .filter(g => g !== null).length;
  if (assignedCount < 2) return alert('At least two players must join groups to start.');

  // 建立 6 個桶子，將各組玩家 pid 收集
  const groupBuckets = {
    group1: [], group2: [], group3: [],
    group4: [], group5: [], group6: []
  };
  Object.entries(playersData).forEach(([pid, info]) => {
    if (info.groupId && groupBuckets[info.groupId]) {
      groupBuckets[info.groupId].push(pid);
    }
  });

  // 過濾掉空組，隨機排序成 groupOrder
  const nonEmptyGroups = Object.entries(groupBuckets)
    .filter(([gid, arr]) => arr.length > 0)
    .map(([gid]) => gid);
  const randomizedOrder = shuffleArray(nonEmptyGroups);

  const nowTs = Date.now();
  const endTs = nowTs + TOTAL_GAME_TIME * 1000;

  // 清空舊的 events 及 answerBuffer
  await dbRefRoom.child('events').remove();
  await dbRefRoom.child('answerBuffer').remove();

  // 更新 state
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
  // 取得 gameEndTime
  const snap = await dbRefState.child('gameEndTime').get();
  const endTs = snap.val() || (Date.now() + TOTAL_GAME_TIME * 1000);

  // 每秒更新剩餘秒數
  gameTimerInterval = setInterval(() => {
    const remain = Math.max(0, Math.floor((endTs - Date.now()) / 1000));
    timerSpan.innerText = remain;
    if (remain <= 0) {
      clearInterval(gameTimerInterval);
      endGame();
    }
  }, 1000);

  // 顯示第一次輪到哪組
  updateTurnDisplay();
}

// ===========================
// 13. 修正後 updateTurnDisplay()
//     ● 清掉上一輪所有計時器
//     ● 顯示「Current Turn」的組別
//     ● 如果輪到自己那組，顯示 Roll 按鈕並啟動 5s auto-roll
//     ● 否則顯示「Not your turn」
// ===========================
function updateTurnDisplay() {
  // 先清除上一輪殘留的一切
  clearTimeout(diceTimeoutHandle);
  clearTimeout(questionTimeoutHandle);
  clearInterval(questionCountdown);

  questionArea.classList.add('hidden');
  btnSubmitAns.classList.add('hidden');
  btnRoll.classList.add('hidden');
  nonTurnMsg.classList.add('hidden');

  dbRefState.child('turnIndex').get().then(snap => {
    const turnIdx = snap.val() || 0;
    const groupId = groupOrder[turnIdx % groupOrder.length] || '';

    orderInfo.innerText = `Order: ${groupOrder.join(' → ')}`;
    turnInfo.innerText  = `Current Turn: ${groupId}`;

    const myGroup = playersData[playerId]?.groupId;
    if (myGroup === groupId) {
      btnRoll.classList.remove('hidden');
      diceTimeoutHandle = setTimeout(() => {
        showToast('5 s elapsed → auto‐rolling');
        rollDiceAndPublish();
      }, DICE_TIMEOUT);
    } else {
      nonTurnMsg.classList.remove('hidden');
    }
  });
}

// ===========================
// 14. 修正後 rollDiceAndPublish()
//     ● 檢查 questionInProgress → 防重複擲骰
//     ● 推送 rollDice → 更新位置 → 設 questionInProgress = true
//     ● 隨機挑題，清空 answerBuffer
//     ● 300ms 後推送 askQuestion
// ===========================
async function rollDiceAndPublish() {
  const inProgSnap = await dbRefState.child('questionInProgress').get();
  if (inProgSnap.val()) return;

  const dice = Math.floor(Math.random() * 6) + 1;

  const evKey = dbRefEvents.push().key;
  const myGrp = playersData[playerId]?.groupId;
  const evData = {
    type: 'rollDice',
    groupId: myGrp,
    dice,
    timestamp: Date.now()
  };
  await dbRefEvents.child(evKey).set(evData);

  await dbRefState.update({ questionInProgress: true });

  const oldPos = positionsData[myGrp] || 0;
  const newPos = Math.max(0, oldPos + dice);
  await dbRefPositions.child(myGrp).set(newPos);

  const questions = await fetch('questions.json').then(r => r.json());
  const chosenQ  = questions[Math.floor(Math.random() * questions.length)];
  const choices  = shuffleArray(chosenQ.options.slice());

  await dbRefRoom.child('answerBuffer').remove();

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
}

// ===========================
// 15. 修正後 handleGameEvent(ev)
//     ● rollDice: 顯示 Toast、隱藏 Roll 按鈕
//     ● askQuestion: “非本組不顯示” → 先比對 ev.groupId 與我的組
//     ● afterAnswer: 顯示 Toast → 切到下一組
// ===========================
async function handleGameEvent(ev) {
  if (gameStartTime && ev.timestamp < gameStartTime) return;

  if (ev.type === 'rollDice') {
    showToast(`Group ${ev.groupId} rolled: ${ev.dice}`);
    btnRoll.classList.add('hidden');
  }
  else if (ev.type === 'askQuestion') {
    // ===========================
    // 關鍵改動：先檢查「是不是輪到我的組」 
    //           只有 ev.groupId === myGroup 才顯示題目
    // ===========================
    const myGroup   = playersData[playerId]?.groupId;
    if (ev.groupId !== myGroup) {
      return; // 非輪到組別，直接 return，不顯示題目
    }
    showQuestionUI(ev.question, ev.choices, ev.answer);
  }
  else if (ev.type === 'afterAnswer') {
    showToast(`Group ${ev.groupId} Δ = ${ev.delta}`);
    goToNextTurn();
  }
}

// ===========================
// 16. 修正後 showQuestionUI()
//     ● 開頭檢查 questionInProgress，如果為 false 就 return
// ===========================
async function showQuestionUI(questionText, choices, answerKey) {
  const inProg = await dbRefState.child('questionInProgress').get().then(s => s.val());
  if (!inProg) return;

  questionArea.classList.remove('hidden');
  btnSubmitAns.classList.remove('hidden');
  nonTurnMsg.classList.add('hidden');

  qText.innerText     = questionText;
  correctAnswer       = answerKey.trim().toUpperCase();

  choicesList.innerHTML = '';
  choices.forEach((opt) => {
    const label = document.createElement('label');
    label.innerHTML = `
      <input type="radio" name="choice" value="${opt.charAt(0)}" />
      ${opt}
    `;
    choicesList.appendChild(label);
  });

  let timeLeft = ANSWER_TIMEOUT / 1000;
  questionTimer.innerText = timeLeft;
  clearInterval(questionCountdown);
  questionCountdown = setInterval(() => {
    timeLeft--;
    questionTimer.innerText = timeLeft;
    if (timeLeft <= 0) {
      clearInterval(questionCountdown);
      submitAnswer(null);
    }
  }, 1000);

  questionTimeoutHandle = setTimeout(() => {
    submitAnswer(null);
  }, ANSWER_TIMEOUT);

  btnSubmitAns.onclick = () => {
    const checked  = document.querySelector('input[name="choice"]:checked');
    const selected = checked ? checked.value.trim().toUpperCase() : null;
    clearInterval(questionCountdown);
    clearTimeout(questionTimeoutHandle);
    submitAnswer(selected);
  };
}

// ===========================
// 17. 修正後 submitAnswer(answer)
//     ● 一開始先檢查「是不是輪到我的組」
//     ● 再檢查 questionInProgress 是否為 true
// ===========================
async function submitAnswer(answer) {
  // ====== 關鍵改動：只有輪到我的組才可送出答案 ======
  const snapIdx  = await dbRefState.child('turnIndex').get();
  const turnIdx  = snapIdx.val() || 0;
  const currentGrp = groupOrder[turnIdx % groupOrder.length];
  const myGrp    = playersData[playerId]?.groupId;
  if (myGrp !== currentGrp) {
    return; // 非輪到組別 → 不執行
  }

  // 如果 questionInProgress 已經被設為 false (代表已結算)，直接 return
  const inProg = await dbRefState.child('questionInProgress').get().then(s => s.val());
  if (!inProg) return;

  clearTimeout(questionTimeoutHandle);
  clearInterval(questionCountdown);

  questionArea.classList.add('hidden');
  btnSubmitAns.classList.add('hidden');

  const ansToWrite = (answer || '').toString().trim().toUpperCase();
  await dbRefRoom.child(`answerBuffer/${playerId}`).set(ansToWrite);

  // 檢查同組成員是否都已回答
  const members = Object.entries(playersData)
    .filter(([, info]) => info.groupId === myGrp)
    .map(([pid]) => pid);

  const snap = await db.ref(`rooms/${roomId}/answerBuffer`).get();
  const buf  = snap.val() || {};
  const answeredCount = members.filter(pid => buf[pid] !== undefined).length;

  if (answeredCount >= members.length) {
    processAnswers();
  }
}

// ===========================
// 18. processAnswers()
// ===========================
async function processAnswers() {
  await dbRefState.update({ questionInProgress: false });

  const snapIdx = await dbRefState.child('turnIndex').get();
  const turnIdx = snapIdx.val() || 0;
  const grpId   = groupOrder[turnIdx % groupOrder.length];

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

  let delta = 0;
  if (correctCount === groupSize) {
    delta = +2;
  } else if (correctCount < groupSize / 2) {
    delta = -(groupSize * 2);
  } else {
    delta = 0;
  }

  const oldPos = positionsData[grpId] || 0;
  const newPos = Math.max(0, oldPos + delta);
  await dbRefPositions.child(grpId).set(newPos);

  const afterKey = dbRefEvents.push().key;
  await dbRefEvents.child(afterKey).set({
    type: 'afterAnswer',
    groupId: grpId,
    correctCount,
    delta,
    timestamp: Date.now()
  });

  goToNextTurn();
}

// ===========================
// 19. goToNextTurn()
// ===========================
async function goToNextTurn() {
  const snapIdx = await dbRefState.child('turnIndex').get();
  const turnIdx = snapIdx.val() || 0;
  const nextIdx = (turnIdx + 1) % groupOrder.length;
  await dbRefState.update({ turnIndex: nextIdx });
}

// ===========================
// 20. renderPositions()
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
