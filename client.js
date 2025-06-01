// client.js

// 先取得 HTML 裡的元素
const nickInput       = document.getElementById('nick');
const btnCreate       = document.getElementById('btnCreate');
const roomIdIn        = document.getElementById('roomIdIn');
const btnJoin         = document.getElementById('btnJoin');
const roomInfoDiv     = document.getElementById('roomInfo');
const roomIdShow      = document.getElementById('roomIdShow');
const groupListUl     = document.getElementById('groupList');
const playerListUl    = document.getElementById('playerList');
const selGroup        = document.getElementById('selGroup');
const btnJoinGroup    = document.getElementById('btnJoinGroup');
const hostControls    = document.getElementById('hostControls');
const btnStart        = document.getElementById('btnStart');

const gameDiv         = document.getElementById('game');
const timerSpan       = document.getElementById('timer');
const orderInfo       = document.getElementById('orderInfo');
const turnInfo        = document.getElementById('turnInfo');
const btnRoll         = document.getElementById('btnRoll');
const questionArea    = document.getElementById('questionArea');
const qText           = document.getElementById('qText');
const nonTurnMsg      = document.getElementById('nonTurnMsg');
const choicesList     = document.getElementById('choicesList');
const btnSubmitAns    = document.getElementById('btnSubmitAns');
const questionTimer   = document.getElementById('questionTimer');
const posListUl       = document.getElementById('posList');

const resultDiv       = document.getElementById('result');
const rankListOl      = document.getElementById('rankList');

const TOAST_DURATION  = 2000; // Toast 顯示秒數

// 產生一個隨機 ID 作為玩家識別
const playerId = Math.random().toString(36).substr(2, 8);
let myNick = '';
let roomId = '';
let isHost = false;

// 目前遊戲資料快取
let dbRefRoom = null;
let dbRefPlayers = null;
let dbRefState = null;
let dbRefEvents = null;
let playersData = {};    // 快取 room.players 的資料
let groupsOrder = [];    // _ 後面會存取 state.turnIndex 後決定誰該出題

// ----------------------------
// 1. 建立房間（房主）
// ----------------------------
btnCreate.addEventListener('click', () => {
  myNick = nickInput.value.trim();
  if (!myNick) return alert('請先輸入暱稱');

  // 在 /rooms 下 push 一個新節點，拿到 roomId
  const newRoomRef = db.ref('rooms').push();
  roomId = newRoomRef.key;
  isHost = true;

  // 初始化房間的基本架構
  newRoomRef.set({
    players: {
      [playerId]: { nick: myNick, group: null, position: 0, score: 0 }
    },
    groups: { groupList: ['group1','group2','group3','group4'] }, // 初始分組順序
    state: { started: false, turnIndex: 0, questionInProgress: false },
    positions: { group1: 0, group2: 0, group3: 0, group4: 0 },
    events: {}
  }).then(() => {
    setupRoomListeners();
    showRoomInfoUI();
    showToast('房間已建立，請分享房號給其他人');
  });
});

// ----------------------------
// 2. 加入房間（玩家）
// ----------------------------
btnJoin.addEventListener('click', () => {
  myNick = nickInput.value.trim();
  roomId = roomIdIn.value.trim();
  if (!myNick) return alert('請先輸入暱稱');
  if (!roomId) return alert('請輸入房號');

  // 檢查房間是否存在
  db.ref(`rooms/${roomId}`).get().then(snapshot => {
    if (!snapshot.exists()) {
      return alert('此房間不存在');
    }
    // 加入玩家節點
    const playerRef = db.ref(`rooms/${roomId}/players/${playerId}`);
    playerRef.set({ nick: myNick, group: null, position: 0, score: 0 })
      .then(() => {
        setupRoomListeners();
        showRoomInfoUI();
        showToast('已加入房間');
      });
  });
});

// ----------------------------
// 顯示房間相關 UI（房號、玩家名單、分組選擇、開始按鈕）
// ----------------------------
function showRoomInfoUI() {
  document.getElementById('lobby').classList.add('hidden');
  roomInfoDiv.classList.remove('hidden');
  roomIdShow.innerText = roomId;

  // 如果自己是房主，顯示「開始遊戲」按鈕
  if (isHost) {
    hostControls.classList.remove('hidden');
  }
}

// ----------------------------
// 3. 監聽房間變化（players、groups、state、positions）
// ----------------------------
function setupRoomListeners() {
  // 快取基本參考
  dbRefRoom     = db.ref(`rooms/${roomId}`);
  dbRefPlayers  = db.ref(`rooms/${roomId}/players`);
  dbRefState    = db.ref(`rooms/${roomId}/state`);
  dbRefGroups   = db.ref(`rooms/${roomId}/groups/groupList`);
  dbRefEvents   = db.ref(`rooms/${roomId}/events`);
  dbRefPositions= db.ref(`rooms/${roomId}/positions`);

  // 3.1 監聽 players 名單
  dbRefPlayers.on('value', snap => {
    playersData = snap.val() || {};
    renderPlayersList();
    renderGroupsStatus();
  });

  // 3.2 監聽 groups 排序
  dbRefGroups.on('value', snap => {
    groupsOrder = snap.val() || [];
  });

  // 3.3 監聽 state.started，如果開始就切到遊戲介面
  dbRefState.child('started').on('value', snap => {
    const started = snap.val();
    if (started) {
      enterGameUI();
    }
  });

  // 3.4 監聽 events，用來同步擲骰子、答題結果等
  dbRefEvents.on('child_added', snap => {
    const ev = snap.val();
    handleGameEvent(ev);
  });

  // 3.5 監聽 positions，更新各組位置
  dbRefPositions.on('value', snap => {
    const pos = snap.val() || {};
    renderPositions(pos);
  });
}

// ----------------------------
// 4. 畫出玩家列表
// ----------------------------
function renderPlayersList() {
  playerListUl.innerHTML = '';
  groupListUl.innerHTML = '';

  Object.entries(playersData).forEach(([pid, info]) => {
    // 玩家列表
    const li = document.createElement('li');
    li.innerText = `${info.nick} (${info.group || '未分組'})`;
    playerListUl.appendChild(li);

    // 分組狀態（各組有哪些玩家）
    const groupLi = document.createElement('li');
    groupLi.innerText = `${info.nick}: ${info.group || '未分組'}`;
    groupListUl.appendChild(groupLi);
  });
}

// ----------------------------
// 5. 分組機制（玩家點 Join Group）
// ----------------------------
btnJoinGroup.addEventListener('click', () => {
  const chosen = selGroup.value; // 例如 "group1"
  if (!roomId) return;
  db.ref(`rooms/${roomId}/players/${playerId}/group`).set(chosen);
  showToast(`已加入 ${chosen}`);
});

// 畫面上只顯示每個玩家的分組狀態，所以 renderPlayersList() 已涵蓋此部分

// ----------------------------
// 6. 開始遊戲（只有房主可用）
// ----------------------------
btnStart.addEventListener('click', () => {
  // 檢查：至少有 2 個玩家分組完成才可開始
  const assignedGroups = Object.values(playersData)
    .map(p => p.group)
    .filter(g => g !== null);
  if (assignedGroups.length < 2) {
    return alert('至少要兩個玩家完成分組才能開始');
  }
  // 將 state.started 設為 true，遊戲開始
  dbRefState.update({ started: true, turnIndex: 0, questionInProgress: false });
});

// ----------------------------
// 7. 進入遊戲介面
// ----------------------------
function enterGameUI() {
  roomInfoDiv.classList.add('hidden');
  gameDiv.classList.remove('hidden');

  startGameLoop();
}

// ----------------------------
// 8. 遊戲主要流程循環
// ----------------------------
let gameTimerInterval = null;
let totalGameTime = 300; // 5 分鐘 = 300 秒
function startGameLoop() {
  // (1) 啟動倒數計時
  timerSpan.innerText = totalGameTime;
  gameTimerInterval = setInterval(() => {
    totalGameTime--;
    timerSpan.innerText = totalGameTime;
    if (totalGameTime <= 0) {
      clearInterval(gameTimerInterval);
      endGame();
    }
  }, 1000);

  // (2) 顯示當前輪到哪一組出題
  updateTurnDisplay();

  // (3) 綁定「擲骰子」按鈕
  btnRoll.addEventListener('click', () => {
    rollDiceAndPublish();
  });
}

// 更新當前出題組別文字
function updateTurnDisplay() {
  dbRefState.child('turnIndex').get().then(snap => {
    const turnIndex = snap.val() || 0;
    const currentGroup = groupsOrder[turnIndex % groupsOrder.length];
    turnInfo.innerText = `⏳ 現在輪到：${currentGroup}`;
    orderInfo.innerText = '出題順序：' + groupsOrder.join(' → ');
    // 只有「輪到我的組別」才能看到「擲骰子」按鈕
    if (playersData[playerId] && playersData[playerId].group === currentGroup) {
      btnRoll.classList.remove('hidden');
      nonTurnMsg.classList.add('hidden');
    } else {
      btnRoll.classList.add('hidden');
      nonTurnMsg.classList.remove('hidden');
    }
  });
}

// ----------------------------
// 9. 擲骰子並把事件寫到 Firebase
// ----------------------------
function rollDiceAndPublish() {
  // 如果已有題目進行中，就不能再擲骰子
  dbRefState.child('questionInProgress').get().then(snap => {
    if (snap.val()) return;
    const dice = Math.floor(Math.random() * 6) + 1;
    // 推送事件到 /rooms/{roomId}/events
    const evKey = dbRefEvents.push().key;
    const evData = {
      type: 'rollDice',
      group: playersData[playerId].group,
      value: dice,
      timestamp: Date.now()
    };
    dbRefEvents.child(evKey).set(evData);
    // 同時把 questionInProgress 設為 true
    dbRefState.update({ questionInProgress: true });
  });
}

// ----------------------------
// 10. 處理所有遊戲事件（events）
// ----------------------------
function handleGameEvent(ev) {
  if (ev.type === 'rollDice') {
    showToast(`組別 ${ev.group} 擲出 ${ev.value}`);
    // 先把自己組的按鈕隱藏
    btnRoll.classList.add('hidden');
    nonTurnMsg.classList.remove('hidden');

    // 根據骰子點數，顯示題目區塊
    showQuestionForGroup(ev.group, ev.value);
  }

  else if (ev.type === 'answerResult') {
    // ev.payload: { group, correct, newPosition, scoreDelta }
    const { group, correct, newPosition, scoreDelta } = ev.payload;
    showToast(`組別 ${group} ${correct ? '答對' : '答錯'}`);
    // 更新該組位置及分數
    db.ref(`rooms/${roomId}/positions/${group}`).set(newPosition);
    db.ref(`rooms/${roomId}/players`)
      .orderByChild('group')
      .equalTo(group)
      .once('value', snap => {
        const dict = snap.val();
        if (!dict) return;
        const pid = Object.keys(dict)[0];
        const oldScore = dict[pid].score || 0;
        db.ref(`rooms/${roomId}/players/${pid}/score`).set(oldScore + scoreDelta);
      });

    // 把 questionInProgress 設回 false，並切到下一組
    dbRefState.update({ questionInProgress: false });
    goToNextTurn();
  }

  // 如果有更多事件型態，可加在這裡
}

// ----------------------------
// 11. 顯示題目、計時並等待提交答案
// ----------------------------
let questionCountdown = null;
function showQuestionForGroup(group, diceValue) {
  questionArea.classList.remove('hidden');
  btnSubmitAns.classList.remove('hidden');
  nonTurnMsg.classList.add('hidden');

  // TODO: 根據 diceValue 或 group 來決定題目
  const question = selectQuestion(); // 自行實作題庫、題目選擇
  qText.innerText = question.text;

  // 題目選項
  choicesList.innerHTML = '';
  question.choices.forEach((txt, idx) => {
    const label = document.createElement('label');
    label.innerHTML = `<input type="radio" name="choice" value="${idx}" /> ${txt}`;
    choicesList.appendChild(label);
  });

  // 啟動 10秒倒數
  let timeLeft = 10;
  questionTimer.innerText = timeLeft;
  questionCountdown = setInterval(() => {
    timeLeft--;
    questionTimer.innerText = timeLeft;
    if (timeLeft <= 0) {
      clearInterval(questionCountdown);
      submitAnswer(null, question); // 超時視為未選答案
    }
  }, 1000);

  // 綁定送出答案按鈕
  btnSubmitAns.onclick = () => {
    // 取得選中的 radio
    const checked = document.querySelector('input[name="choice"]:checked');
    const selectedIdx = checked ? Number(checked.value) : null;
    clearInterval(questionCountdown);
    submitAnswer(selectedIdx, question);
  };
}

// 範例：題庫與選題函式（請自行改成真實題目）
function selectQuestion() {
  // TODO: 真實題庫可以放在另一個 JS 檔或從後端抓
  const samplePool = [
    { text: "Apple is a ___?", choices: ["動詞", "名詞", "形容詞"], answer: 1 },
    { text: "Cat is a ___?", choices: ["動物", "顏色", "地點"], answer: 0 },
    // ...
  ];
  const idx = Math.floor(Math.random() * samplePool.length);
  return samplePool[idx];
}

// ----------------------------
// 12. 提交答案並寫回 Firebase
// ----------------------------
function submitAnswer(selectedIdx, question) {
  questionArea.classList.add('hidden');

  // 判斷是否答對
  const correct = (selectedIdx === question.answer);
  // 計算新的位置：若答對 + diceValue 格，否則不動或 -1 格
  // TODO: 這裡可以自己定義規則，以下僅示範「答對往前 1 格，答錯不動」
  const currentGroup = playersData[playerId].group;
  const oldPos = playersData[playerId].position || 0;
  const newPos = correct ? oldPos + 1 : oldPos;
  const scoreDelta = correct ? 10 : 0; // 答對 +10 分

  // 推送 answerResult 事件
  const evKey = dbRefEvents.push().key;
  dbRefEvents.child(evKey).set({
    type: 'answerResult',
    payload: { group: currentGroup, correct, newPosition: newPos, scoreDelta },
    timestamp: Date.now()
  });
}

// ----------------------------
// 13. 切換到下一組出題
// ----------------------------
function goToNextTurn() {
  dbRefState.child('turnIndex').get().then(snap => {
    const idx = (snap.val() || 0) + 1;
    dbRefState.update({ turnIndex: idx });
    updateTurnDisplay();
  });
}

// ----------------------------
// 14. 顯示各組位置
// ----------------------------
function renderPositions(posObj) {
  posListUl.innerHTML = '';
  Object.entries(posObj).forEach(([grp, cellIdx]) => {
    const li = document.createElement('li');
    li.innerText = `${grp}: 在 ${cellIdx} 號格`;
    posListUl.appendChild(li);
  });
}

// ----------------------------
// 15. 遊戲結束，計算排名並顯示
// ----------------------------
function endGame() {
  gameDiv.classList.add('hidden');
  resultDiv.classList.remove('hidden');

  // 依照分數高低排序
  const ranking = Object.values(playersData)
    .map(p => ({ nick: p.nick, score: p.score || 0 }))
    .sort((a, b) => b.score - a.score);

  rankListOl.innerHTML = '';
  ranking.forEach((p, idx) => {
    const li = document.createElement('li');
    li.innerText = `${idx+1}. ${p.nick} (${p.score} 分)`;
    rankListOl.appendChild(li);
  });
}

// ----------------------------
// 16. Toast 簡易提示
// ----------------------------
function showToast(msg) {
  const div = document.createElement('div');
  div.classList.add('toast');
  div.innerText = msg;
  document.body.appendChild(div);
  setTimeout(() => {
    document.body.removeChild(div);
  }, TOAST_DURATION);
}
