// client.js

// -------- 1. 取得所有 DOM Elements --------
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
const remainingTime = document.getElementById('remainingTime');
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

// -------- 2. 全域變數與初始值 --------
const TOAST_DURATION = 2000;   // Toast 顯示 2 秒
const DICE_TIMEOUT    = 5000;  // 5 秒內沒擲骰就自動擲
const ANSWER_TIMEOUT  = 10000; // 10 秒內沒答題就自動算錯
const TOTAL_GAME_TIME = 300;   // 5 分鐘遊戲時間 (300 秒)

// 產生一個隨機 ID 作為玩家識別碼 (8 碼隨機字串)
const playerId = Math.random().toString(36).substr(2, 8);

// 使用者輸入暱稱、房號
let myNick  = '';
let roomId  = '';
let isHost  = false;

// Firebase Database References (稍後會指向 rooms/{roomId} 子節點)
let dbRefRoom       = null;
let dbRefPlayers    = null;
let dbRefState      = null;
let dbRefGroupOrder = null;
let dbRefEvents     = null;
let dbRefPositions  = null;

// 暫存後端的資料
let playersData   = {};   // { playerId: {nick, groupId, position, score}, ... }
let groupOrder    = [];   // 例如 ["group3","group1"] (只保留非空組，且隨機排序)
let positionsData = {};   // { group1: 0, group2: 0, ..., group6: 0 }
let gameStartTime = 0;    // 遊戲開始 timestamp (用來過濾舊事件)

// -------- 3. 輔助工具 --------
function showToast(msg) {
  const div = document.createElement('div');
  div.classList.add('toast');
  div.innerText = msg;
  document.body.appendChild(div);
  setTimeout(() => {
    document.body.removeChild(div);
  }, TOAST_DURATION);
}
function shuffleArray(arr) {
  return arr
    .map(v => ({ val: v, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(o => o.val);
}
function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// -------- 4. 建立房間 (房主端) --------
btnCreate.addEventListener('click', async () => {
  myNick = nickInput.value.trim();
  if (!myNick) {
    return alert('Please enter a nickname');
  }

  // 隨機產生 5 碼大寫英數字房號，並確保在資料庫裡不存在
  let newId;
  while (true) {
    newId = Math.random().toString(36).substr(2, 5).toUpperCase();
    const snap = await db.ref(`rooms/${newId}`).get();
    if (!snap.exists()) break;
  }
  roomId = newId;
  isHost = true;

  // 初始化房間結構：players, state, positions, events
  const roomRef = db.ref(`rooms/${roomId}`);
  await roomRef.set({
    players: {
      [playerId]: { nick: myNick, groupId: null, position: 0, score: 0 }
    },
    state: {
      status: 'lobby',      // "lobby" 或 "playing"
      groupOrder: [],       // 開始遊戲時寫入隨機排序的非空組
      turnIndex: 0,
      questionInProgress: false,
      gameEndTime: 0,
      startTime: 0          // 遊戲確切開始的 timestamp，用於過濾舊事件
    },
    positions: {
      group1: 0, group2: 0, group3: 0,
      group4: 0, group5: 0, group6: 0
    },
    events: {}              // 會放所有 rollDice、askQuestion、afterAnswer 事件
  });

  setupRoomListeners();
  showRoomInfoUI();
  showToast(`Room created: ${roomId}`);
});

// -------- 5. 加入房間 (玩家端) --------
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
    // 將自己加入 players
    const playerRef = db.ref(`rooms/${roomId}/players/${playerId}`);
    playerRef.set({ nick: myNick, groupId: null, position: 0, score: 0 })
      .then(() => {
        isHost = false;
        setupRoomListeners();
        showRoomInfoUI();
        showToast(`Joined room: ${roomId}`);
      });
  });
});

// -------- 6. 顯示房間資訊 & Group 選擇 --------
function showRoomInfoUI() {
  document.getElementById('lobby').classList.add('hidden');
  roomInfoDiv.classList.remove('hidden');
  roomIdShow.innerText = roomId;

  // 如果我是房主，就顯示 Start Game 按鈕
  if (isHost) {
    hostControls.classList.remove('hidden');
  }
}

// -------- 7. 監聽 Database --------
function setupRoomListeners() {
  dbRefRoom       = db.ref(`rooms/${roomId}`);
  dbRefPlayers    = db.ref(`rooms/${roomId}/players`);
  dbRefState      = db.ref(`rooms/${roomId}/state`);
  dbRefGroupOrder = db.ref(`rooms/${roomId}/state/groupOrder`);
  dbRefEvents     = db.ref(`rooms/${roomId}/events`);
  dbRefPositions  = db.ref(`rooms/${roomId}/positions`);

  // 監聽 players 變動 → 更新 playersData + 更新畫面上的玩家與組別狀態
  dbRefPlayers.on('value', snap => {
    playersData = snap.val() || {};
    renderPlayersAndGroups();
  });

  // 監聽 state.status，若變為 "playing" → 進入遊戲畫面
  dbRefState.child('status').on('value', snap => {
    const st = snap.val();
    if (st === 'playing') {
      enterGameUI();
    }
  });

  // 監聽 state.startTime，取得遊戲真正開始的 timestamp
  dbRefState.child('startTime').on('value', snap => {
    gameStartTime = snap.val() || 0;
  });

  // 監聽 state.groupOrder，取得正在比賽的組別清單，並重新畫位置
  dbRefGroupOrder.on('value', snap => {
    groupOrder = snap.val() || [];
    renderPositions();
  });

  // 監聽 state.turnIndex，更新「輪到哪組」及 Roll 按鈕狀態
  dbRefState.child('turnIndex').on('value', snap => {
    updateTurnDisplay();
  });

  // 監聽 state.questionInProgress，若變 false 就隱藏 Roll 按鈕
  dbRefState.child('questionInProgress').on('value', snap => {
    const inProg = snap.val();
    if (!inProg) {
      btnRoll.classList.add('hidden');
    }
  });

  // 監聽 positions，更新 positionsData + 重新畫位置
  dbRefPositions.on('value', snap => {
    positionsData = snap.val() || {};
    renderPositions();
  });

  // 監聽 events，但只處理 timestamp >= gameStartTime 的新事件
  dbRefEvents.on('child_added', snap => {
    const ev = snap.val();
    // 如果事件的 timestamp < gameStartTime → 跳過，不處理（舊事件不再觸發）
    if (gameStartTime && ev.timestamp < gameStartTime) {
      return;
    }
    handleGameEvent(ev);
  });
}

// -------- 8. 顯示 players & group 狀況 --------
function renderPlayersAndGroups() {
  playerListUl.innerHTML = '';
  groupListUl.innerHTML = '';

  // 六個 bucket
  const groupBuckets = {
    group1: [], group2: [], group3: [],
    group4: [], group5: [], group6: []
  };
  Object.entries(playersData).forEach(([pid, info]) => {
    // 玩家清單
    const li = document.createElement('li');
    li.innerText = `${info.nick} (${info.groupId || 'No group'})`;
    playerListUl.appendChild(li);

    // 加到對應 bucket
    if (info.groupId && groupBuckets[info.groupId]) {
      groupBuckets[info.groupId].push(info.nick);
    }
  });

  // 顯示每組底下有哪些玩家 (如果沒人則顯示 “–”)
  Object.entries(groupBuckets).forEach(([grp, names]) => {
    const li = document.createElement('li');
    li.innerText = `${grp}: ${names.length > 0 ? names.join(', ') : '–'}`;
    groupListUl.appendChild(li);
  });
}

// -------- 9. 玩家按 Join Group --------
btnJoinGroup.addEventListener('click', () => {
  const chosen = selGroup.value; // 例如 "group3"
  if (!roomId) return;
  db.ref(`rooms/${roomId}/players/${playerId}/groupId`).set(chosen);
  showToast(`Joined ${chosen}`);
});

// -------- 10. 房主按 Start Game --------
btnStart.addEventListener('click', async () => {
  // 10-1. 至少要有兩位玩家已分組
  const assigned = Object.values(playersData)
    .map(p => p.groupId)
    .filter(g => g !== null);
  if (assigned.length < 2) {
    return alert('At least two players must join groups before starting.');
  }

  // 10-2. 建立 六個 bucket，把同組玩家的 IDs 收集
  const groupBuckets = {
    group1: [], group2: [], group3: [],
    group4: [], group5: [], group6: []
  };
  Object.entries(playersData).forEach(([pid, info]) => {
    if (info.groupId && groupBuckets[info.groupId]) {
      groupBuckets[info.groupId].push(pid);
    }
  });

  // 10-3. 只保留「有成員」的組別，隨機排序
  const nonEmpty = Object.entries(groupBuckets)
    .filter(([gid, arr]) => arr.length > 0)
    .map(([gid]) => gid);
  const randomizedOrder = shuffleArray(nonEmpty);

  // 10-4. 計算遊戲結束時間、開始時間
  const nowTs = Date.now();
  const endTs = nowTs + TOTAL_GAME_TIME * 1000;

  // 10-5. **在開始遊戲前先清空舊的 events**，避免舊事件亂觸發
  await dbRefRoom.child('events').remove();

  // 10-6. 更新 state：status, groupOrder, turnIndex, questionInProgress, gameEndTime, startTime
  await dbRefState.update({
    status: 'playing',
    groupOrder: randomizedOrder,
    turnIndex: 0,
    questionInProgress: false,
    gameEndTime: endTs,
    startTime: nowTs
  });
});

// -------- 11. 進入遊戲介面 --------
function enterGameUI() {
  roomInfoDiv.classList.add('hidden');
  gameDiv.classList.remove('hidden');
  startGameLoop();
}

// -------- 12. 遊戲主循環：倒數 & 觸發第一次 turn --------
let gameTimerInterval = null;
async function startGameLoop() {
  // 12-1. 讀取結束時間
  const snap = await dbRefState.child('gameEndTime').get();
  const endTs = snap.val() || (Date.now() + TOTAL_GAME_TIME * 1000);

  // 12-2. 每秒更新剩餘秒數，若 <= 0 就結束
  gameTimerInterval = setInterval(async () => {
    const remain = Math.max(0, Math.floor((endTs - Date.now()) / 1000));
    timerSpan.innerText = remain;
    if (remain <= 0) {
      clearInterval(gameTimerInterval);
      endGame();
    }
  }, 1000);

  // 12-3. 畫出第一次 turn 狀態
  updateTurnDisplay();
}

// -------- 13. 更新 turn、控制 5 秒自動擲骰 --------
let diceTimeoutHandle = null;
function updateTurnDisplay() {
  dbRefState.child('turnIndex').get().then(snap => {
    const turnIdx = snap.val() || 0;
    const groupId = groupOrder[turnIdx % groupOrder.length] || '';
    orderInfo.innerText = `Order: ${groupOrder.join(' → ')}`;
    turnInfo.innerText  = `Current Turn: ${groupId}`;

    // 如果輪到我這組，就顯示 Roll 按鈕；否則隱藏
    const myGroup = playersData[playerId]?.groupId;
    if (myGroup === groupId) {
      btnRoll.classList.remove('hidden');
      nonTurnMsg.classList.add('hidden');
    } else {
      btnRoll.classList.add('hidden');
      nonTurnMsg.classList.remove('hidden');
    }

    // 5 秒自動擲骰（若輪到我但 5 秒沒按，系統自動擲一次）
    clearTimeout(diceTimeoutHandle);
    if (myGroup === groupId) {
      diceTimeoutHandle = setTimeout(() => {
        rollDiceAndPublish();
      }, DICE_TIMEOUT);
    }
  });
}

// -------- 14. Roll Dice 事件 --------
btnRoll.addEventListener('click', () => {
  rollDiceAndPublish();
});
async function rollDiceAndPublish() {
  // 14-1. 確認目前沒有題目正在進行 (questionInProgress === false)
  const snap = await dbRefState.child('questionInProgress').get();
  if (snap.val()) return;

  // 14-2. 隨機產生 1~6 點
  const dice = Math.floor(Math.random() * 6) + 1;

  // 14-3. 寫入 rollDice 事件到 /rooms/{roomId}/events
  const evKey = dbRefEvents.push().key;
  const myGrp = playersData[playerId]?.groupId;
  const evData = {
    type: 'rollDice',
    groupId: myGrp,
    dice,
    timestamp: Date.now()
  };
  await dbRefEvents.child(evKey).set(evData);

  // 14-4. 設 questionInProgress = true，以免重複擲骰
  await dbRefState.update({ questionInProgress: true });

  // 14-5. 更新這組位置 (oldPos + dice)
  const oldPos = positionsData[myGrp] || 0;
  const newPos = Math.max(0, oldPos + dice);
  await dbRefPositions.child(myGrp).set(newPos);

  // 14-6. 立即下達 askQuestion 事件
  const questions = await fetch('questions.json').then(r => r.json());
  const q = questions[Math.floor(Math.random() * questions.length)];
  const choices = shuffleArray(q.options.slice());

  // 14-7. 清空答案緩衝 (answerBuffer)
  await dbRefRoom.child('answerBuffer').remove();

  // 14-8. 10 秒後自動執行 processAnswers()
  setTimeout(() => {
    processAnswers();
  }, ANSWER_TIMEOUT);

  // 14-9. 寫入 askQuestion 事件到 /rooms/{roomId}/events
  const questionEventKey = dbRefEvents.push().key;
  await dbRefEvents.child(questionEventKey).set({
    type: 'askQuestion',
    groupId: myGrp,
    question: q.question,
    choices,
    answer: q.answer,
    timestamp: Date.now()
  });
}

// -------- 15. 處理 /rooms/{roomId}/events 新事件 (rollDice, askQuestion, afterAnswer) --------
async function handleGameEvent(ev) {
  // 先篩掉旧事件 (timestamp < gameStartTime)
  if (gameStartTime && ev.timestamp < gameStartTime) {
    return;
  }

  if (ev.type === 'rollDice') {
    // 別組擲骰的提示
    showToast(`Group ${ev.groupId} rolled: ${ev.dice}`);
    btnRoll.classList.add('hidden');
  }
  else if (ev.type === 'askQuestion') {
    // 只有輪到的那組才顯示題目
    const turnIdx   = await dbRefState.child('turnIndex').get().then(s => s.val());
    const currentGrp = groupOrder[turnIdx % groupOrder.length];
    if (ev.groupId !== currentGrp) return;
    showQuestionUI(ev.question, ev.choices, ev.answer);
  }
  else if (ev.type === 'afterAnswer') {
    // 顯示答題後分數變動的提示
    showToast(`Group ${ev.groupId} answer processed: Δ=${ev.delta}`);
    goToNextTurn();
  }
}

// -------- 16. 顯示題目界面 & 等待 Submit --------
let questionCountdown = null;
let correctAnswer = '';
function showQuestionUI(questionText, choices, answerKey) {
  questionArea.classList.remove('hidden');
  btnSubmitAns.classList.remove('hidden');
  nonTurnMsg.classList.add('hidden');

  qText.innerText = questionText;
  correctAnswer = answerKey.trim().toUpperCase();

  // 顯示選項 (radio)
  choicesList.innerHTML = '';
  choices.forEach((opt, idx) => {
    const label = document.createElement('label');
    label.innerHTML = `<input type="radio" name="choice" value="${opt.charAt(0)}" /> ${opt}`;
    choicesList.appendChild(label);
  });

  // 10 秒倒數
  let timeLeft = ANSWER_TIMEOUT / 1000;
  questionTimer.innerText = timeLeft;
  questionCountdown = setInterval(() => {
    timeLeft--;
    questionTimer.innerText = timeLeft;
    if (timeLeft <= 0) {
      clearInterval(questionCountdown);
      submitAnswer(null); // 超時算錯
    }
  }, 1000);

  // 綁定 Submit Answer
  btnSubmitAns.onclick = () => {
    const checked = document.querySelector('input[name="choice"]:checked');
    const selected = checked ? checked.value.trim().toUpperCase() : null;
    clearInterval(questionCountdown);
    submitAnswer(selected);
  };
}

// -------- 17. submitAnswer：寫入 answerBuffer 並嘗試提早 processAnswers --------
async function submitAnswer(answer) {
  questionArea.classList.add('hidden');
  btnSubmitAns.classList.add('hidden');

  // 存到 /rooms/{roomId}/answerBuffer/{playerId}
  await dbRefRoom.child(`answerBuffer/${playerId}`).set(answer || '');

  // 檢查同組人員答題數量
  const myGrp = playersData[playerId]?.groupId;
  if (!myGrp) return;

  const members = Object.entries(playersData)
    .filter(([, info]) => info.groupId === myGrp)
    .map(([pid]) => pid);

  const snap = await db.ref(`rooms/${roomId}/answerBuffer`).get();
  const buf = snap.val() || {};
  const answeredCount = members.filter(pid => buf[pid] !== undefined).length;
  if (answeredCount >= members.length) {
    clearInterval(questionCountdown);
    processAnswers();
  }
}

// -------- 18. 處理答案：計算 delta & 下達 afterAnswer --------
async function processAnswers() {
  // 18-1. 先把 questionInProgress 設回 false
  await dbRefState.update({ questionInProgress: false });

  // 18-2. 取得當前 turnIndex & 該組 ID
  const turnIdx = await dbRefState.child('turnIndex').get().then(s => s.val());
  const grpId   = groupOrder[turnIdx % groupOrder.length];

  // 18-3. 讀取該組所有在 answerBuffer 中的答案
  const snapBuf = await db.ref(`rooms/${roomId}/answerBuffer`).get();
  const bufData = snapBuf.val() || {};

  // 18-4. 計算組員總人數 & 答對人數
  const members = Object.entries(playersData)
    .filter(([, info]) => info.groupId === grpId)
    .map(([pid]) => pid);

  let correctCount = 0;
  members.forEach(pid => {
    const ans = (bufData[pid] || '').toString().trim().toUpperCase();
    if (ans === correctAnswer) correctCount++;
  });
  const groupSize = members.length;

  // 18-5. 計算 delta：全對 +2；< 半組退 (size*2)；其他 0
  let delta = 0;
  if (correctCount === groupSize) {
    delta = +2;
  } else if (correctCount < groupSize / 2) {
    delta = -(groupSize * 2);
  } else {
    delta = 0;
  }

  // 18-6. 更新該組位置
  const oldPos = positionsData[grpId] || 0;
  const newPos = Math.max(0, oldPos + delta);
  await dbRefPositions.child(grpId).set(newPos);

  // 18-7. 下達 afterAnswer 事件
  const afterKey = dbRefEvents.push().key;
  await dbRefEvents.child(afterKey).set({
    type: 'afterAnswer',
    groupId: grpId,
    correctCount,
    delta,
    timestamp: Date.now()
  });

  // 18-8. 下一組
  goToNextTurn();
}

// -------- 19. 下一組 Turn (更新 turnIndex) --------
async function goToNextTurn() {
  const turnIdx = await dbRefState.child('turnIndex').get().then(s => s.val());
  const nextIdx = (turnIdx + 1) % groupOrder.length;
  await dbRefState.update({ turnIndex: nextIdx });
}

// -------- 20. 顯示「正在比賽的組別」位置 (只照 groupOrder 排序) --------
function renderPositions() {
  posListUl.innerHTML = '';
  // 只顯示 groupOrder 裡的組別 (這些組都是非空組)
  groupOrder.forEach(grp => {
    if (positionsData.hasOwnProperty(grp)) {
      const li = document.createElement('li');
      li.innerText = `${grp}: at ${positionsData[grp]}`;
      posListUl.appendChild(li);
    }
  });
}

// -------- 21. 遊戲結束：顯示結果 --------
async function endGame() {
  gameDiv.classList.add('hidden');
  resultDiv.classList.remove('hidden');

  // 用「位置」當作分數依據，排序
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

// -------- 22. 監聽 gameEndTime，到時自動 endGame --------
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
// -------- 23. 完整結束 --------
