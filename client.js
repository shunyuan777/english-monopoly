// ======================================
// client.js
// Multiplayer English Game – Firebase 版本
// － 新增：在 askQuestion / submitAnswer 中，從 Firebase 重新讀取 groupOrder 
//       以避免本機快取落後導致「某組被跳過」的問題。
// ======================================

// ===========================
// 1. 取得所有 DOM
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

// Firebase 參考節點
let dbRefRoom       = null;
let dbRefPlayers    = null;
let dbRefState      = null;
let dbRefGroupOrder = null;
let dbRefEvents     = null;
let dbRefPositions  = null;

// 本機緩存（大部分情況下可用，但處理 askQuestion / submitAnswer 時會「特別重新從 Firebase 讀」）
let playersData   = {};    // { playerId: {nick, groupId, position, score} }
let groupOrder    = [];    // e.g. ["group3", "group1", ...]
let positionsData = {};    // { group1:0, group2:0, ..., group6:0 }
let gameStartTime = 0;     // 真正開始的 timestamp (ms)
let correctAnswer = '';    // 當前題目的正確答案

// 計時器 handle
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

// Fisher–Yates 洗牌演算法
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

  // 產生不重複的 5 碼房號
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
    // 過濾掉遊戲開始前的舊事件
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
    const li = document.createElement('li');
    li.innerText = `${info.nick} (${info.groupId || 'No group'})`;
    playerListUl.appendChild(li);

    if (info.groupId && groupBuckets[info.groupId]) {
      groupBuckets[info.groupId].push(info.nick);
    }
  });

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
  // (1) 至少要有兩位玩家分組
  const assignedCount = Object.values(playersData)
    .map(p => p.groupId)
    .filter(g => g !== null).length;
  if (assignedCount < 2) {
    return alert('At least two players must join groups to start.');
  }

  // (2) 建 6 個桶子，蒐集同組的 pid
  const groupBuckets = {
    group1: [], group2: [], group3: [],
    group4: [], group5: [], group6: []
  };
  Object.entries(playersData).forEach(([pid, info]) => {
    if (info.groupId && groupBuckets[info.groupId]) {
      groupBuckets[info.groupId].push(pid);
    }
  });

  // (3) 過濾掉沒人的組，打亂順序
  const nonEmptyGroups = Object.entries(groupBuckets)
    .filter(([gid, arr]) => arr.length > 0)
    .map(([gid]) => gid);
  const randomizedOrder = shuffleArray(nonEmptyGroups);

  // (4) 取得現在和結束時間 (5 分鐘後)
  const nowTs = Date.now();
  const endTs = nowTs + TOTAL_GAME_TIME * 1000;

  // (5) 清除舊的 events 和 answerBuffer
  await dbRefRoom.child('events').remove();
  await dbRefRoom.child('answerBuffer').remove();

  // (6) 一次更新 state
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
  // 讀 gameEndTime
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
// 13. updateTurnDisplay()
//     (1) 清掉上一輪所有計時器  
//     (2) 更新「Current Turn」的組別顯示  
//     (3) 再從 Firebase 讀「我的 groupId」，判斷要不要顯示 Roll 按鈕  
// ===========================
function updateTurnDisplay() {
  // (1) 清除上一輪殘留的所有計時器
  clearTimeout(diceTimeoutHandle);
  clearTimeout(questionTimeoutHandle);
  clearInterval(questionCountdown);

  // 隱藏題目與所有互動元件
  questionArea.classList.add('hidden');
  btnSubmitAns.classList.add('hidden');
  btnRoll.classList.add('hidden');
  nonTurnMsg.classList.add('hidden');

  // (2) 讀取最新 turnIndex 和 groupOrder
  Promise.all([
    dbRefState.child('turnIndex').get(),
    dbRefGroupOrder.get()
  ]).then(([turnSnap, orderSnap]) => {
    const turnIdx       = turnSnap.val() || 0;
    const latestOrder   = orderSnap.val() || [];
    groupOrder = latestOrder; // 更新本機緩存
    const currentGrp = latestOrder[turnIdx % latestOrder.length] || '';

    orderInfo.innerText = `Order: ${latestOrder.join(' → ')}`;
    turnInfo.innerText  = `Current Turn: ${currentGrp}`;

    // (3) 再從 Firebase 取得自己最新的 groupId
    dbRefPlayers.child(playerId).child('groupId').get().then(myGrpSnap => {
      const myGroup = myGrpSnap.val();
      if (myGroup === currentGrp) {
        // 輪到自己：顯示 Roll 按鈕，啟動 5 秒自動擲骰
        btnRoll.classList.remove('hidden');
        diceTimeoutHandle = setTimeout(() => {
          showToast('5 s elapsed → auto‐rolling');
          rollDiceAndPublish();
        }, DICE_TIMEOUT);
      } else {
        // 不是輪到自己：顯示「Not your turn」
        nonTurnMsg.classList.remove('hidden');
      }
    }).catch(() => {
      // 讀不到我的 groupId，就當成不是輪到自己
      nonTurnMsg.classList.remove('hidden');
    });
  });
}

// ===========================
// 14. rollDiceAndPublish()
//     (1) 再從 Firebase 讀「我的 groupId」避免本機快取落後  
//     (2) 推送 rollDice 事件 + 更新 position + 啟動 questionInProgress  
//     (3) 隨機挑題、清空 answerBuffer  
//     (4) 300ms 後推送 askQuestion 事件  
// ===========================
async function rollDiceAndPublish() {
  // (1) 避免重複擲骰
  const inProgSnap = await dbRefState.child('questionInProgress').get();
  if (inProgSnap.val()) return;

  const dice = Math.floor(Math.random() * 6) + 1;

  // 重新從 Firebase 讀取「我的 groupId」
  const myGrpSnap = await dbRefPlayers.child(playerId).child('groupId').get();
  const myGrp     = myGrpSnap.val();
  if (!myGrp) return;

  // (2) 推送 rollDice 事件
  const evKey = dbRefEvents.push().key;
  const evData = {
    type: 'rollDice',
    groupId: myGrp,
    dice,
    timestamp: Date.now()
  };
  await dbRefEvents.child(evKey).set(evData);

  // 設定 questionInProgress = true，避免重複擲骰或重複出題
  await dbRefState.update({ questionInProgress: true });

  // (3) 立即更新該組 position
  const oldPos = positionsData[myGrp] || 0;
  const newPos = Math.max(0, oldPos + dice);
  await dbRefPositions.child(myGrp).set(newPos);

  // 隨機挑題、打亂選項
  const questions = await fetch('questions.json').then(r => r.json());
  const chosenQ  = questions[Math.floor(Math.random() * questions.length)];
  const choices  = shuffleArray(chosenQ.options.slice());

  // 清空 answerBuffer
  await dbRefRoom.child('answerBuffer').remove();

  // (4) 300ms 後推送 askQuestion 事件
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
// 15. handleGameEvent(ev)
//     (1) rollDice → 只顯示 Toast，隱藏 Roll  
//     (2) askQuestion → 再重新讀 turnIndex & 最新 groupOrder；確認「ev.groupId === currentGrp」，再讀「自己最新的 groupId」  
//         ● 只有當 ev.groupId、currentGrp、myGroup 三者都相同時，才呼叫 showQuestionUI()  
//     (3) afterAnswer → Toast + 切到下一組  
// ===========================
async function handleGameEvent(ev) {
  // (0) 過濾掉遊戲開始前的舊事件
  if (gameStartTime && ev.timestamp < gameStartTime) return;

  if (ev.type === 'rollDice') {
    showToast(`Group ${ev.groupId} rolled: ${ev.dice}`);
    btnRoll.classList.add('hidden');
  }
  else if (ev.type === 'askQuestion') {
    // (1) 先從 Firebase 同步讀取最新的 turnIndex & groupOrder
    const [ turnSnap, orderSnap ] = await Promise.all([
      dbRefState.child('turnIndex').get(),
      dbRefState.child('groupOrder').get()
    ]);
    const turnIdx       = turnSnap.val() || 0;
    const latestOrder   = orderSnap.val() || [];
    groupOrder = latestOrder; // 更新本機緩存
    const currentGrp    = latestOrder[turnIdx % latestOrder.length];

    // (2) 若 ev.groupId 不等於輪到的組，就 return
    if (ev.groupId !== currentGrp) {
      return;
    }

    // (3) 再從 Firebase 讀「我的 groupId」
    const myGrpSnap = await dbRefPlayers.child(playerId).child('groupId').get();
    const myGroup   = myGrpSnap.val();
    if (myGroup !== currentGrp) {
      // 即使 askQuestion 事件給了這組 group，但如果自己實際沒屬於該組，還是跳過
      return;
    }

    // (4) 剩下就是「輪到我的組」 → 顯示題目
    showQuestionUI(ev.question, ev.choices, ev.answer);
  }
  else if (ev.type === 'afterAnswer') {
    showToast(`Group ${ev.groupId} Δ = ${ev.delta}`);
    goToNextTurn();
  }
}

// ===========================
// 16. showQuestionUI(question, choices, answerKey)
//     (1) 開頭先從 Firebase 讀 questionInProgress，若已被設為 false，直接 return  
//     (2) 顯示題目、動態插入選項 radio  
//     (3) 啟動 10 秒倒數 & auto-submit  
// ===========================
async function showQuestionUI(questionText, choices, answerKey) {
  // (1) 如果 questionInProgress 已被設為 false，就 return
  const inProg = await dbRefState.child('questionInProgress').get().then(s => s.val());
  if (!inProg) return;

  questionArea.classList.remove('hidden');
  btnSubmitAns.classList.remove('hidden');
  nonTurnMsg.classList.add('hidden');

  qText.innerText     = questionText;
  correctAnswer       = answerKey.trim().toUpperCase();

  // (2) 動態插入 radio 選項
  choicesList.innerHTML = '';
  choices.forEach((opt) => {
    const label = document.createElement('label');
    label.innerHTML = `
      <input type="radio" name="choice" value="${opt.charAt(0)}" />
      ${opt}
    `;
    choicesList.appendChild(label);
  });

  // (3) 啟動 10 秒倒數 & auto-submit
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
// 17. submitAnswer(answer)
//     (1) 再從 Firebase 讀 最新的 turnIndex & groupOrder → 確認輪到哪組  
//     (2) 再從 Firebase 讀 最新的「我的 groupId」  
//     (3) 若 myGroup ≠ currentGrp，直接 return，不處理  
//     (4) 再檢查 questionInProgress，若已 false，直接 return  
//     (5) 把答案寫入 answerBuffer，檢查組內是否都答完，若是就 processAnswers()  
// ===========================
async function submitAnswer(answer) {
  // (1) 讀 Firebase 版的 turnIndex & groupOrder
  const [ turnSnap, orderSnap ] = await Promise.all([
    dbRefState.child('turnIndex').get(),
    dbRefState.child('groupOrder').get()
  ]);
  const turnIdx       = turnSnap.val() || 0;
  const latestOrder   = orderSnap.val() || [];
  groupOrder = latestOrder; 
  const currentGrp    = latestOrder[turnIdx % latestOrder.length];

  // (2) 再從 Firebase 讀取「我的 groupId」
  const myGrpSnap = await dbRefPlayers.child(playerId).child('groupId').get();
  const myGroup   = myGrpSnap.val();
  if (myGroup !== currentGrp) {
    // 如果非輪到的組 → 直接 return
    return;
  }

  // (3) 檢查 questionInProgress，若已 false → 代表本輪已 processed → 直接 return
  const inProg = await dbRefState.child('questionInProgress').get().then(s => s.val());
  if (!inProg) return;

  clearTimeout(questionTimeoutHandle);
  clearInterval(questionCountdown);

  questionArea.classList.add('hidden');
  btnSubmitAns.classList.add('hidden');

  const ansToWrite = (answer || '').toString().trim().toUpperCase();
  await dbRefRoom.child(`answerBuffer/${playerId}`).set(ansToWrite);

  // (4) 檢查本組所有成員是否都已回答
  const allPlayersSnap = await dbRefPlayers.get();
  const allPlayersData = allPlayersSnap.val() || {};
  const members = Object.entries(allPlayersData)
    .filter(([, info]) => info.groupId === myGroup)
    .map(([pid]) => pid);

  const bufSnap = await db.ref(`rooms/${roomId}/answerBuffer`).get();
  const bufData = bufSnap.val() || {};
  const answeredCount = members.filter(pid => bufData[pid] !== undefined).length;

  if (answeredCount >= members.length) {
    processAnswers();
  }
}

// ===========================
// 18. processAnswers()
// ===========================
async function processAnswers() {
  // (1) 設 questionInProgress = false
  await dbRefState.update({ questionInProgress: false });

  // (2) 讀 Firebase 版的 turnIndex & groupOrder
  const [ turnSnap, orderSnap ] = await Promise.all([
    dbRefState.child('turnIndex').get(),
    dbRefState.child('groupOrder').get()
  ]);
  const turnIdx       = turnSnap.val() || 0;
  const latestOrder   = orderSnap.val() || [];
  groupOrder = latestOrder; 
  const grpId         = latestOrder[turnIdx % latestOrder.length];

  // (3) 讀所有答案
  const bufSnap = await db.ref(`rooms/${roomId}/answerBuffer`).get();
  const bufData = bufSnap.val() || {};

  // (4) 讀所有玩家，找出本組成員
  const allPlayersSnap = await dbRefPlayers.get();
  const allPlayersData = allPlayersSnap.val() || {};
  const members = Object.entries(allPlayersData)
    .filter(([, info]) => info.groupId === grpId)
    .map(([pid]) => pid);

  let correctCount = 0;
  members.forEach(pid => {
    const ans = (bufData[pid] || '').toString().trim().toUpperCase();
    if (ans === correctAnswer) correctCount++;
  });
  const groupSize = members.length;

  // (5) 計算 delta
  let delta = 0;
  if (correctCount === groupSize) {
    delta = +2;
  } else if (correctCount < groupSize / 2) {
    delta = -(groupSize * 2);
  } else {
    delta = 0;
  }

  // (6) 更新位置
  const oldPos = positionsData[grpId] || 0;
  const newPos = Math.max(0, oldPos + delta);
  await dbRefPositions.child(grpId).set(newPos);

  // (7) 推送 afterAnswer 事件
  const afterKey = dbRefEvents.push().key;
  await dbRefEvents.child(afterKey).set({
    type: 'afterAnswer',
    groupId: grpId,
    correctCount,
    delta,
    timestamp: Date.now()
  });

  // (8) 切到下一組
  goToNextTurn();
}

// ===========================
// 19. goToNextTurn()
// ===========================
async function goToNextTurn() {
  const turnSnap = await dbRefState.child('turnIndex').get();
  const turnIdx  = turnSnap.val() || 0;
  const nextIdx  = (turnIdx + 1) % groupOrder.length;
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

  // 讀所有玩家
  const allPlayersSnap = await dbRefPlayers.get();
  const allPlayersData = allPlayersSnap.val() || {};
  const ranking = Object.entries(allPlayersData)
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
