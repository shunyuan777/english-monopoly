// client.js

// ------------- 1. 取得所有 DOM Elements -------------
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

// ------------- 2. 全域變數與初始值 -------------
const TOAST_DURATION = 2000;             // Toast 提示持續時間 (ms)
const DICE_TIMEOUT    = 5000;            // 5 秒內沒擲骰就自動擲
const ANSWER_TIMEOUT  = 10000;           // 10 秒內沒答題就算錯
const TOTAL_GAME_TIME = 300;             // 5 分鐘遊戲時間 = 300 秒

// 產生一個隨機 ID 作為「玩家識別碼」，前端存一次即可
const playerId = Math.random().toString(36).substr(2, 8);

// 讓使用者輸入暱稱、房號
let myNick  = '';
let roomId  = '';
let isHost  = false;

// Database References (等建立房間後再寫入)
let dbRefRoom       = null;
let dbRefPlayers    = null;
let dbRefState      = null;
let dbRefGroupOrder = null;
let dbRefEvents     = null;
let dbRefPositions  = null;

// 房間裡的快取資料
let playersData   = {};   // { playerId: { nick, groupId, position, score }, ... }
let groupOrder    = [];   // e.g. ["group3","group1","group5",...]
let positionsData = {};   // { group1: 0, group2: 0, group3: 0, group4: 0, group5: 0, group6: 0 }

// --------------- 3. 輔助工具 (Toast, shuffle, sleep) ---------------
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

// --------------- 4. 建立房間（房主端） ---------------
btnCreate.addEventListener('click', async () => {
  myNick = nickInput.value.trim();
  if (!myNick) {
    return alert('Please enter a nickname');
  }

  // 4-1. 產生一個 5 碼隨機英數大寫字串作為房號，並確保沒有重複
  let newId;
  while (true) {
    newId = Math.random().toString(36).substr(2, 5).toUpperCase();
    const snap = await db.ref(`rooms/${newId}`).get();
    if (!snap.exists()) break;
  }
  roomId = newId;
  isHost = true;

  // 4-2. 建立房間的基本資料結構
  //  預設六組：group1 ... group6
  //  每組初始位置 0、score 0，players 只有自己一筆
  const roomRef = db.ref(`rooms/${roomId}`);
  await roomRef.set({
    players: {
      [playerId]: { nick: myNick, groupId: null, position: 0, score: 0 }
    },
    state: {
      status: 'lobby',          // 'lobby' 或 'playing'
      groupOrder: [],           // 開始遊戲時寫入
      turnIndex: 0,             // 哪一組輪到出題
      questionInProgress: false,
      gameEndTime: 0            // UNIX ms
    },
    positions: {
      group1: 0, group2: 0, group3: 0,
      group4: 0, group5: 0, group6: 0
    },
    events: {}                  // 所有擲骰、答題事件
  });

  setupRoomListeners();
  showRoomInfoUI();
  showToast(`Room created: ${roomId}`);
});

// --------------- 5. 加入房間（玩家端） ---------------
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

// --------------- 6. 顯示房間資訊 & Group 選擇 ---------------
function showRoomInfoUI() {
  document.getElementById('lobby').classList.add('hidden');
  roomInfoDiv.classList.remove('hidden');
  roomIdShow.innerText = roomId;

  // 如果是房主，顯示「Start Game」按鈕
  if (isHost) {
    hostControls.classList.remove('hidden');
  }
}

// --------------- 7. 監聽 Database （players / state / positions / events） ---------------
function setupRoomListeners() {
  dbRefRoom       = db.ref(`rooms/${roomId}`);
  dbRefPlayers    = db.ref(`rooms/${roomId}/players`);
  dbRefState      = db.ref(`rooms/${roomId}/state`);
  dbRefGroupOrder = db.ref(`rooms/${roomId}/state/groupOrder`);
  dbRefEvents     = db.ref(`rooms/${roomId}/events`);
  dbRefPositions  = db.ref(`rooms/${roomId}/positions`);

  // 7-1. 監聽 players 變動：更新玩家列表 & 各組人數
  dbRefPlayers.on('value', snap => {
    playersData = snap.val() || {};
    renderPlayersAndGroups();
  });

  // 7-2. 監聽 state.status (lobby → playing)；若狀態變成 playing，跳到遊戲頁
  dbRefState.child('status').on('value', snap => {
    const st = snap.val();
    if (st === 'playing') {
      enterGameUI();
    }
  });

  // 7-3. 監聽 state.groupOrder：誰先後輪
  dbRefGroupOrder.on('value', snap => {
    groupOrder = snap.val() || [];
  });

  // 7-4. 監聽 state.turnIndex：更新 UI 提示「輪到哪一組」
  dbRefState.child('turnIndex').on('value', snap => {
    updateTurnDisplay();
  });

  // 7-5. 監聽 state.questionInProgress：控制是否可以擲骰或答題
  dbRefState.child('questionInProgress').on('value', snap => {
    const inProg = snap.val();
    if (!inProg) {
      // 等待下一回合開始
      btnRoll.classList.add('hidden');
    }
  });

  // 7-6. 監聽 positions：更新各組位置
  dbRefPositions.on('value', snap => {
    positionsData = snap.val() || {};
    renderPositions();
  });

  // 7-7. 監聽所有事件 (events)：擲骰結果、題目下發、答題結果等
  dbRefEvents.on('child_added', snap => {
    const ev = snap.val();
    handleGameEvent(ev);
  });
}

// --------------- 8. 將 playersData 與 group 狀況顯示到畫面 ---------------
function renderPlayersAndGroups() {
  // 清掉兩個列表
  playerListUl.innerHTML = '';
  groupListUl.innerHTML = '';

  // 先把 playersData 轉成：每個 groupId 底下有哪些玩家
  const groupBuckets = {
    group1: [], group2: [], group3: [],
    group4: [], group5: [], group6: []
  };
  Object.entries(playersData).forEach(([pid, info]) => {
    // 列出玩家清單
    const li = document.createElement('li');
    li.innerText = `${info.nick} (${info.groupId || 'No group'})`;
    playerListUl.appendChild(li);

    // 收集組內人數
    if (info.groupId && groupBuckets[info.groupId]) {
      groupBuckets[info.groupId].push(info.nick);
    }
  });

  // 顯示各組底下有哪些玩家（若無人就顯示 “–”）
  Object.entries(groupBuckets).forEach(([grp, names]) => {
    const li = document.createElement('li');
    li.innerText = `${grp}: ${names.length > 0 ? names.join(', ') : '–'}`;
    groupListUl.appendChild(li);
  });
}

// --------------- 9. 玩家選組事件 ---------------
btnJoinGroup.addEventListener('click', () => {
  const chosen = selGroup.value; // e.g. "group3"
  if (!roomId) return;
  // 更新自己在 Firebase 的 players/{playerId}/groupId
  db.ref(`rooms/${roomId}/players/${playerId}/groupId`).set(chosen);
  showToast(`Joined ${chosen}`);
});

// --------------- 10. 房主按 Start Game  ---------------
btnStart.addEventListener('click', async () => {
  // 10-1. 至少要有兩個玩家已分組才可開始
  const assigned = Object.values(playersData)
    .map(p => p.groupId)
    .filter(g => g !== null);
  if (assigned.length < 2) {
    return alert('At least two players must join groups before starting.');
  }

  // 10-2. 把狀態改成 playing
  //       先從 playersData 計算各組底下的 member Id 陣列
  const groupBuckets = {
    group1: [], group2: [], group3: [],
    group4: [], group5: [], group6: []
  };
  Object.entries(playersData).forEach(([pid, info]) => {
    if (info.groupId && groupBuckets[info.groupId]) {
      groupBuckets[info.groupId].push(pid);
    }
  });

  // 10-3. 只保留「有成員」的組別，並隨機排序
  const nonEmpty = Object.entries(groupBuckets)
    .filter(([gid, arr]) => arr.length > 0)
    .map(([gid]) => gid);
  const randomizedOrder = shuffleArray(nonEmpty);

  // 10-4. 遊戲結束時間 = 現在 + TOTAL_GAME_TIME 秒
  const endTs = Date.now() + TOTAL_GAME_TIME * 1000;

  // 10-5. 一次寫入 state: status, groupOrder, turnIndex, questionInProgress, gameEndTime
  await dbRefState.update({
    status: 'playing',
    groupOrder: randomizedOrder,
    turnIndex: 0,
    questionInProgress: false,
    gameEndTime: endTs
  });
});

// --------------- 11. 進入遊戲介面 ---------------
function enterGameUI() {
  roomInfoDiv.classList.add('hidden');
  gameDiv.classList.remove('hidden');

  startGameLoop();
}

// --------------- 12. 遊戲主循環：倒數計時 & 換回合 ---------------
let gameTimerInterval = null;
async function startGameLoop() {
  // 12-1. 先讀一次 endTime
  const snap = await dbRefState.child('gameEndTime').get();
  const endTs = snap.val() || (Date.now() + TOTAL_GAME_TIME * 1000);

  // 12-2. 每秒更新剩餘時間，若<=0 則結束遊戲
  gameTimerInterval = setInterval(async () => {
    const remain = Math.max(0, Math.floor((endTs - Date.now()) / 1000));
    timerSpan.innerText = remain;
    if (remain <= 0) {
      clearInterval(gameTimerInterval);
      endGame();
    }
  }, 1000);

  // 12-3. 畫出第一次的 turnInfo
  updateTurnDisplay();
}

// --------------- 13. 更新「輪到哪一組」顯示 & 控制擲骰按鈕 ---------------
let diceTimeoutHandle = null;
function updateTurnDisplay() {
  dbRefState.child('turnIndex').get().then(snap => {
    const turnIdx = snap.val() || 0;
    const groupId = (groupOrder[turnIdx % groupOrder.length] || '');
    orderInfo.innerText = `Order: ${groupOrder.join(' → ')}`;
    turnInfo.innerText  = `Current Turn: ${groupId}`;

    // 13-1. 如果是我這一組，顯示「Roll Dice」，否則隱藏
    const myGroup = playersData[playerId]?.groupId;
    if (myGroup === groupId) {
      btnRoll.classList.remove('hidden');
      nonTurnMsg.classList.add('hidden');
    } else {
      btnRoll.classList.add('hidden');
      nonTurnMsg.classList.remove('hidden');
    }

    // 13-2. 只要輪到這組，就啟動 5 秒自動擲骰定時器
    clearTimeout(diceTimeoutHandle);
    if (myGroup === groupId) {
      diceTimeoutHandle = setTimeout(() => {
        rollDiceAndPublish();
      }, DICE_TIMEOUT);
    }
  });
}

// --------------- 14. 玩家按「Roll Dice」事件 ---------------
btnRoll.addEventListener('click', () => {
  rollDiceAndPublish();
});
async function rollDiceAndPublish() {
  // 14-1. 確認目前沒有題目進行中 (questionInProgress = false)
  const snap = await dbRefState.child('questionInProgress').get();
  if (snap.val()) return;

  // 14-2. 計算隨機骰子 1~6
  const dice = Math.floor(Math.random() * 6) + 1;

  // 14-3. 寫入一筆事件到 /rooms/{roomId}/events
  const evKey = dbRefEvents.push().key;
  const myGrp = playersData[playerId]?.groupId;
  const evData = {
    type: 'rollDice',
    groupId: myGrp,
    dice,
    timestamp: Date.now()
  };
  await dbRefEvents.child(evKey).set(evData);

  // 14-4. 先把 questionInProgress 設為 true，避免重複擲骰
  await dbRefState.update({ questionInProgress: true });

  // 14-5. 更新自己這組的 position：之前 playerData 裡取出
  const oldPos = positionsData[myGrp] || 0;
  const newPos = Math.max(0, oldPos + dice);
  await dbRefPositions.child(myGrp).set(newPos);

  // 14-6. 也要在資料庫裡更新所有人的 positions 資料（上方 on 'value' 會自動更新 UI）

  // 14-7. 立刻下發題目 (ask_question)，並啟動 10 秒答題定時器
  //       從 questions.json 隨機挑題（我們假設 questions.json 已經放到 public 底下，可以用 fetch 讀）
  const questions = await fetch('questions.json').then(r => r.json());
  //  隨機抽 1 題
  const q = questions[Math.floor(Math.random() * questions.length)];
  //  選項打亂
  const choices = shuffleArray(q.options.slice());

  //  建立 answerBuffer = {}，先清空
  await dbRefRoom.child('answerBuffer').remove();

  //  設置 10 秒後自動處理答案
  const timeoutKey = setTimeout(() => {
    processAnswers();
  }, ANSWER_TIMEOUT);

  //  存答案事件的 handle，先清空舊的 answerBuffer
  //  並且要把 questionInProgress 繼續保持 true
  //  下發 ask_question
  const questionEventKey = dbRefEvents.push().key;
  await dbRefEvents.child(questionEventKey).set({
    type: 'askQuestion',
    groupId: myGrp,
    question: q.question,
    choices,
    answer: q.answer,    // 之後在處理答案時需要用到
    timestamp: Date.now()
  });
}

// --------------- 15. 收到 /rooms/{roomId}/events 新事件時，依 type 處理  ---------------
async function handleGameEvent(ev) {
  if (ev.type === 'rollDice') {
    // 別人擲骰的結果已經更新在 positions 裡了，我們只需要顯示一段提示
    showToast(`Group ${ev.groupId} rolled: ${ev.dice}`);
    // 這時 UI 應該把 「Roll Dice」按鈕隱藏
    btnRoll.classList.add('hidden');
  }

  else if (ev.type === 'askQuestion') {
    // 15-1. 下達題目給「特定組別」
    const currentGrp = groupOrder[ await dbRefState.child('turnIndex').get().then(s => s.val()) ];
    if (ev.groupId !== currentGrp) return;
    // 進入題目畫面
    showQuestionUI(ev.question, ev.choices, ev.answer);
  }

  else if (ev.type === 'afterAnswer') {
    // 15-2. 處理答題結果後的顯示 (答對人數、分數/位置變化) → 我們直接透過 positions 資料綁定 UI
    showToast(`Group ${ev.groupId} answer processed: Δ=${ev.delta}`);
    // 之後就讓下一組繼續 turn
    goToNextTurn();
  }
}

// --------------- 16. 顯示題目介面 & 等待玩家 submit Answer  ---------------
let questionCountdown = null;
let correctAnswer = '';
function showQuestionUI(questionText, choices, answerKey) {
  questionArea.classList.remove('hidden');
  btnSubmitAns.classList.remove('hidden');
  nonTurnMsg.classList.add('hidden');

  qText.innerText = questionText;
  correctAnswer = answerKey.trim().toUpperCase();

  // 16-1. 顯示選項 (radio buttons)
  choicesList.innerHTML = '';
  choices.forEach((opt, idx) => {
    const label = document.createElement('label');
    label.innerHTML = `<input type="radio" name="choice" value="${opt.charAt(0)}" /> ${opt}`;
    choicesList.appendChild(label);
  });

  // 16-2. 啟動 10 秒倒數
  let timeLeft = ANSWER_TIMEOUT / 1000;
  questionTimer.innerText = timeLeft;
  questionCountdown = setInterval(() => {
    timeLeft--;
    questionTimer.innerText = timeLeft;
    if (timeLeft <= 0) {
      clearInterval(questionCountdown);
      submitAnswer(null);  // 超時算作沒選 => 錯誤
    }
  }, 1000);

  // 16-3. 綁定送出按鈕
  btnSubmitAns.onclick = () => {
    const checked = document.querySelector('input[name="choice"]:checked');
    const selected = checked ? checked.value.trim().toUpperCase() : null;
    clearInterval(questionCountdown);
    submitAnswer(selected);
  };
}

// --------------- 17. 提交答案，寫回 answerBuffer，並嘗試觸發 processAnswers  ---------------
async function submitAnswer(answer) {
  questionArea.classList.add('hidden');
  btnSubmitAns.classList.add('hidden');

  // 17-1. 記錄自己的答案到 /rooms/{roomId}/answerBuffer/{playerId}
  await dbRefRoom.child(`answerBuffer/${playerId}`).set(answer || '');

  // 17-2. 檢查這組有多少人已送答案，若等於該組成員數，立刻處理答案（取消 10 秒定時）
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

// --------------- 18. 處理該組所有答案：統計答對人數 & 計算位置增減  ---------------
async function processAnswers() {
  // 18-1. 先把 questionInProgress 設回 false（允許下一組擲骰）
  await dbRefState.update({ questionInProgress: false });

  // 18-2. 取得剛才的 turnIndex 及那一組 ID
  const turnIdx = await dbRefState.child('turnIndex').get().then(s => s.val());
  const grpId   = groupOrder[turnIdx % groupOrder.length];

  // 18-3. 讀取 answerBuffer 裡所有該組成員送來的答案
  const snapBuf = await db.ref(`rooms/${roomId}/answerBuffer`).get();
  const bufData = snapBuf.val() || {};

  // 18-4. 計算該組成員的人數、以及答對人數
  const members = Object.entries(playersData)
    .filter(([, info]) => info.groupId === grpId)
    .map(([pid]) => pid);

  let correctCount = 0;
  members.forEach(pid => {
    const ans = (bufData[pid] || '').toString().trim().toUpperCase();
    if (ans === correctAnswer) correctCount++;
  });
  const groupSize = members.length;

  // 18-5. 計算位置增減：  
  //       如果答對人數 == 全組人數 → +2  
  //       如果答對人數 < 半組人數 → 退 (組員數 × 2)  
  //       其他情況 → 不動
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

  // 18-7. 發一筆 afterAnswer 事件，讓所有人都能收到提示
  const afterKey = dbRefEvents.push().key;
  await dbRefEvents.child(afterKey).set({
    type: 'afterAnswer',
    groupId: grpId,
    correctCount,
    delta,
    timestamp: Date.now()
  });

  // 18-8. 下一組 turn
  goToNextTurn();
}

// --------------- 19. 下一組 Turn (更新 turnIndex)  ---------------
async function goToNextTurn() {
  const turnIdx = await dbRefState.child('turnIndex').get().then(s => s.val());
  const nextIdx = (turnIdx + 1) % groupOrder.length;
  await dbRefState.update({ turnIndex: nextIdx });
}

// --------------- 20. 顯示所有組別位置 ---------------
function renderPositions() {
  posListUl.innerHTML = '';
  Object.entries(positionsData).forEach(([grp, pos]) => {
    const li = document.createElement('li');
    li.innerText = `${grp}: at ${pos}`;
    posListUl.appendChild(li);
  });
}

// --------------- 21. 遊戲結束：倒數結束或 TurnIndex 處理完畢  ---------------
async function endGame() {
  // 21-1. 隱藏遊戲頁面，顯示結果頁面
  gameDiv.classList.add('hidden');
  resultDiv.classList.remove('hidden');

  // 21-2. 從 playersData 讀分數（這裡把「位置」當作分數）
  const ranking = Object.entries(playersData)
    .map(([, info]) => ({ nick: info.nick, score: positionsData[info.groupId] || 0 }))
    .sort((a, b) => b.score - a.score);

  rankListOl.innerHTML = '';
  ranking.forEach((p, idx) => {
    const li = document.createElement('li');
    li.innerText = `${idx + 1}. ${p.nick} (Position: ${p.score})`;
    rankListOl.appendChild(li);
  });
}

// --------------- 22. 在 state.gameEndTime 到時或倒數結束時自動呼叫 endGame  ---------------
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

// --------------- 23. 已在 Start Game 階段過濾掉空組，無需額外處理  ---------------
// 只要 groupOrder 裡面當初就沒有放「成員為 0」的組別，Start Game 完成後就不會再出現空組。

// --------------- 結束 ---------------
