// ======================================
// client.js
// Multiplayer English Game – Firebase 版本
// － 答題時間改為 15 秒 (ANSWER_TIMEOUT = 15000 ms)
// － 加入 console.log 以便排查「某組被永久跳過」的問題
// ======================================

// ===========================
// 1. 取得所有 DOM 元素
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
const TOAST_DURATION = 2000;    // Toast 顯示 2 秒
const DICE_TIMEOUT    = 5000;   // 5 秒自動擲骰
const ANSWER_TIMEOUT  = 15000;  // <— 答題時間改為 15 秒
const TOTAL_GAME_TIME = 300;    // 300 秒 (5 分鐘)

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

// 本機緩存（多數情況下可用，但關鍵 askQuestion / submitAnswer 還是要從 Firebase 重新讀）
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

  // 準備六個 bucket (group1 ~ group6)
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

  // 顯示各組底下有哪些玩家；若空則顯示 “–”
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
//     – 強制 group3 放在第一順位，其他組別隨機排列
// ===========================
btnStart.addEventListener('click', async () => {
  // (1) 至少要有兩位玩家分組
  const assignedCount = Object.values(playersData)
    .map(p => p.groupId)
    .filter(g => g !== null).length;
  if (assignedCount < 2) {
    return alert('At least two players must join groups to start.');
  }

  // (2) 建立六個桶子，把同一組的 pid 收集
  const groupBuckets = {
    group1: [], group2: [], group3: [],
    group4: [], group5: [], group6: []
  };
  Object.entries(playersData).forEach(([pid, info]) => {
    if (info.groupId && groupBuckets[info.groupId]) {
      groupBuckets[info.groupId].push(pid);
    }
  });

  // (3) 過濾掉沒有人的組，得到所有「非空」的 group ID
  const nonEmptyGroups = Object.entries(groupBuckets)
    .filter(([gid, arr]) => arr.length > 0)
    .map(([gid]) => gid);

  // (4) 強制把 group3 放在第一，如果 group3 本身就存在於 nonEmptyGroups
  let randomizedOrder = [];
  if (nonEmptyGroups.includes('group3')) {
    // 把 group3 放第一
    randomizedOrder.push('group3');
    // 其餘組別
    const others = nonEmptyGroups.filter(g => g !== 'group3');
    // 對「其餘組別」做隨機排序
    const shuffledOthers = shuffleArray(others);
    // 合併成最終排序
    randomizedOrder = randomizedOrder.concat(shuffledOthers);
  } else {
    // 如果 nonEmptyGroups 沒有 group3，就全部隨機排序
    randomizedOrder = shuffleArray(nonEmptyGroups);
  }

  // (5) 計算現在時間與結束時間 (300s 後)
  const nowTs = Date.now();
  const endTs = nowTs + TOTAL_GAME_TIME * 1000;

  // (6) 清除舊的 events 和 answerBuffer
  await dbRefRoom.child('events').remove();
  await dbRefRoom.child('answerBuffer').remove();

  // (7) 一次更新 state
  await dbRefState.update({
    status: 'playing',
    groupOrder: randomizedOrder,  // ← 將最終順序寫入
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
//     (2) 重新從 Firebase 讀取 turnIndex & groupOrder  
//     (3) 更新「Current Turn」顯示  
//     (4) 再從 Firebase 讀「我的 groupId」，判斷要不要顯示 Roll 按鈕  
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

  // (2) 重新從 Firebase 讀取最新的 turnIndex & groupOrder
  Promise.all([
    dbRefState.child('turnIndex').get(),
    dbRefGroupOrder.get()
  ]).then(([turnSnap, orderSnap]) => {
    const turnIdx       = turnSnap.val() || 0;
    const latestOrder   = orderSnap.val() || [];
    groupOrder = latestOrder; 
    const currentGrp    = latestOrder[turnIdx % latestOrder.length] || '';

    orderInfo.innerText = `Order: ${latestOrder.join(' → ')}`;
    turnInfo.innerText  = `Current Turn: ${currentGrp}`;

    console.log(`[DEBUG] updateTurnDisplay → turnIndex=${turnIdx}, groupOrder=[${latestOrder}], currentGrp=${currentGrp}`);

    // (3) 再從 Firebase 取得自己最新的 groupId
    dbRefPlayers.child(playerId).child('groupId').get().then(myGrpSnap => {
      const myGroup = myGrpSnap.val();
      console.log(`[DEBUG]   myGroup=${myGroup}`);
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
      // 如果讀不到自己的 groupId，就當作不是輪到自己
      nonTurnMsg.classList.remove('hidden');
    });
  });
}

// ===========================
// 14. rollDiceAndPublish()
//     (1) 重新從 Firebase 讀「我的 groupId」避免本機快取落後  
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

  console.log(`[DEBUG] rollDiceAndPublish → myGrp=${myGrp}, dice=${dice}`);

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
//     (2) askQuestion → 從 Firebase 重新讀 turnIndex & groupOrder；確認「ev.groupId === currentGrp」；  
//         → 再從 Firebase 讀取「自己的 groupId」；  
//         → 只有當三者都相符才呼叫 showQuestionUI()  
//     (3) afterAnswer → 顯示 Toast + 切到下一組  
// ===========================
async function handleGameEvent(ev) {
  // (0) 過濾掉遊戲開始前的舊事件
  if (gameStartTime && ev.timestamp < gameStartTime) return;

  if (ev.type === 'rollDice') {
    showToast(`Group ${ev.groupId} rolled: ${ev.dice}`);
    btnRoll.classList.add('hidden');
  }
  else if (ev.type === 'askQuestion') {
    // (1) 從 Firebase 同步讀最新的 turnIndex & groupOrder
    const [turnSnap, orderSnap] = await Promise.all([
      dbRefState.child('turnIndex').get(),
      dbRefState.child('groupOrder').get()
    ]);
    const turnIdx       = turnSnap.val() || 0;
    const latestOrder   = orderSnap.val() || [];
    groupOrder = latestOrder; 
    const currentGrp    = latestOrder[turnIdx % latestOrder.length];

    console.log(`[DEBUG] handleGameEvent(askQuestion) → turnIndex=${turnIdx}, groupOrder=[${latestOrder}], currentGrp=${currentGrp}, ev.groupId=${ev.groupId}`);

    // (2) 若 ev.groupId !== currentGrp → return
    if (ev.groupId !== currentGrp) {
      console.log(`[DEBUG]   askQuestion skipped because ev.groupId (${ev.groupId}) ≠ currentGrp (${currentGrp})`);
      return;
    }

    // (3) 再從 Firebase 讀「我的 groupId」
    const myGrpSnap = await dbRefPlayers.child(playerId).child('groupId').get();
    const myGroup   = myGrpSnap.val();
    console.log(`[DEBUG]   myGroup from Firebase = ${myGroup}`);
    if (myGroup !== currentGrp) {
      console.log(`[DEBUG]   askQuestion skipped because myGroup (${myGroup}) ≠ currentGrp (${currentGrp})`);
      return;
    }

    // (4) 只有輪到我的組才顯示題目
    showQuestionUI(ev.question, ev.choices, ev.answer);
  }
  else if (ev.type === 'afterAnswer') {
    showToast(`Group ${ev.groupId} Δ = ${ev.delta}`);
    goToNextTurn();
  }
}

// ===========================
// 16. showQuestionUI(question, choices, answerKey)
//     (1) 先從 Firebase 讀 questionInProgress；若已 false → return  
//     (2) 顯示題目，動態插入 radio 選項  
//     (3) 啟動 15 秒倒數 & auto-submit  
// ===========================
async function showQuestionUI(questionText, choices, answerKey) {
  // (1) 如果 questionInProgress 已為 false，就 return
  const inProg = await dbRefState.child('questionInProgress').get().then(s => s.val());
  if (!inProg) {
    console.log('[DEBUG] showQuestionUI skipped because questionInProgress = false');
    return;
  }

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

  // (3) 啟動 15 秒倒數 & auto-submit
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
//     (1) 重新從 Firebase 讀取 turnIndex & groupOrder → 計算 currentGrp  
//     (2) 重新從 Firebase 讀取「我的 groupId」 → 若 myGroup ≠ currentGrp → return  
//     (3) 讀 questionInProgress；若已 false → return  
//     (4) 寫答案到 answerBuffer，檢查本組所有成員是否都已回答 → 若是 → processAnswers()  
// ===========================
async function submitAnswer(answer) {
  // (1) 重新從 Firebase 讀取 turnIndex & groupOrder
  const [turnSnap, orderSnap] = await Promise.all([
    dbRefState.child('turnIndex').get(),
    dbRefState.child('groupOrder').get()
  ]);
  const turnIdx       = turnSnap.val() || 0;
  const latestOrder   = orderSnap.val() || [];
  groupOrder = latestOrder; 
  const currentGrp    = latestOrder[turnIdx % latestOrder.length];

  // (2) 重新從 Firebase 讀取「我的 groupId」
  const myGrpSnap = await dbRefPlayers.child(playerId).child('groupId').get();
  const myGroup   = myGrpSnap.val();
  if (myGroup !== currentGrp) {
    console.log(`[DEBUG] submitAnswer skipped because myGroup (${myGroup}) ≠ currentGrp (${currentGrp})`);
    return;
  }

  // (3) 讀 questionInProgress；若已 false → 本輪已處理完 → return
  const inProg = await dbRefState.child('questionInProgress').get().then(s => s.val());
  if (!inProg) {
    console.log('[DEBUG] submitAnswer skipped because questionInProgress = false');
    return;
  }

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
  // (1) 將 questionInProgress 設為 false
  await dbRefState.update({ questionInProgress: false });

  // (2) 重新從 Firebase 讀取 turnIndex & groupOrder
  const [turnSnap, orderSnap] = await Promise.all([
    dbRefState.child('turnIndex').get(),
    dbRefState.child('groupOrder').get()
  ]);
  const turnIdx     = turnSnap.val() || 0;
  const latestOrder = orderSnap.val() || [];
  groupOrder = latestOrder; 
  const grpId       = latestOrder[turnIdx % latestOrder.length];

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
