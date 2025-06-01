// client.js

// -------- 1. Grab all DOM elements --------
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

// -------- 2. Constants & Global State --------
const TOAST_DURATION = 2000;   // Toast shows for 2 seconds
const DICE_TIMEOUT    = 5000;  // 5s auto-roll if no click
const ANSWER_TIMEOUT  = 10000; // 10s auto-submit if no answer
const TOTAL_GAME_TIME = 300;   // 5 minutes total game

// Generate a random 8-character ID for this player
const playerId = Math.random().toString(36).substr(2, 8);

let myNick  = '';
let roomId  = '';
let isHost  = false;

// Firebase Refs (will point to /rooms/{roomId} subtree)
let dbRefRoom       = null;
let dbRefPlayers    = null;
let dbRefState      = null;
let dbRefGroupOrder = null;
let dbRefEvents     = null;
let dbRefPositions  = null;

// Cached data from database
let playersData   = {};    // { playerId: {nick, groupId, position, score}, … }
let groupOrder    = [];    // e.g. [ "group3", "group1", … ]  (only non-empty groups, shuffled)
let positionsData = {};    // { group1: 0, group2: 0, …, group6: 0 }
let gameStartTime = 0;     // timestamp when game truly started

// -------- 3. Utility Functions --------
function showToast(msg) {
  const div = document.createElement('div');
  div.classList.add('toast');
  div.innerText = msg;
  document.body.appendChild(div);
  setTimeout(() => { div.remove(); }, TOAST_DURATION);
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

// -------- 4. “Create Room” Button Handler --------
btnCreate.addEventListener('click', async () => {
  myNick = nickInput.value.trim();
  if (!myNick) {
    return alert('Please enter a nickname');
  }

  // Generate a 5-character uppercase roomId, ensure uniqueness
  let newId;
  while (true) {
    newId = Math.random().toString(36).substr(2, 5).toUpperCase();
    const snap = await db.ref(`rooms/${newId}`).get();
    if (!snap.exists()) break;
  }
  roomId = newId;
  isHost = true;

  // Initialize room structure:
  // players, state, positions, events
  const roomRef = db.ref(`rooms/${roomId}`);
  await roomRef.set({
    players: {
      [playerId]: { nick: myNick, groupId: null, position: 0, score: 0 }
    },
    state: {
      status: 'lobby',       // "lobby" or "playing"
      groupOrder: [],        // will be set at game start
      turnIndex: 0,
      questionInProgress: false,
      gameEndTime: 0,
      startTime: 0           // exact timestamp when game begins
    },
    positions: {
      group1: 0, group2: 0, group3: 0,
      group4: 0, group5: 0, group6: 0
    },
    events: {},              // all roll/ask/after events will live here
    answerBuffer: {}         // temporary answers per player during each question
  });

  setupRoomListeners();
  showRoomInfoUI();
  showToast(`Room created: ${roomId}`);
});

// -------- 5. “Join Room” Button Handler --------
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
    // Add player into players
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

// -------- 6. Show Room Info & Group Selection UI --------
function showRoomInfoUI() {
  document.getElementById('lobby').classList.add('hidden');
  roomInfoDiv.classList.remove('hidden');
  roomIdShow.innerText = roomId;

  // If I'm the host, show the Start Game button
  if (isHost) {
    hostControls.classList.remove('hidden');
  }
}

// -------- 7. Setup Firebase Listeners for /rooms/{roomId} --------
function setupRoomListeners() {
  dbRefRoom       = db.ref(`rooms/${roomId}`);
  dbRefPlayers    = db.ref(`rooms/${roomId}/players`);
  dbRefState      = db.ref(`rooms/${roomId}/state`);
  dbRefGroupOrder = db.ref(`rooms/${roomId}/state/groupOrder`);
  dbRefEvents     = db.ref(`rooms/${roomId}/events`);
  dbRefPositions  = db.ref(`rooms/${roomId}/positions`);

  // 7.1 Listen to players → update local cache + refresh lobby display
  dbRefPlayers.on('value', snap => {
    playersData = snap.val() || {};
    renderPlayersAndGroups();
  });

  // 7.2 Listen to state.status → if changes to "playing", enter game UI
  dbRefState.child('status').on('value', snap => {
    const st = snap.val();
    if (st === 'playing') {
      enterGameUI();
    }
  });

  // 7.3 Listen to state.startTime → store the timestamp locally
  dbRefState.child('startTime').on('value', snap => {
    gameStartTime = snap.val() || 0;
  });

  // 7.4 Listen to state.groupOrder → update local groupOrder + redraw positions
  dbRefGroupOrder.on('value', snap => {
    groupOrder = snap.val() || [];
    renderPositions();
  });

  // 7.5 Listen to state.turnIndex → update turn display + possibly auto-roll
  dbRefState.child('turnIndex').on('value', snap => {
    updateTurnDisplay();
  });

  // 7.6 Listen to state.questionInProgress → if false, hide roll button
  dbRefState.child('questionInProgress').on('value', snap => {
    const inProg = snap.val();
    if (!inProg) {
      btnRoll.classList.add('hidden');
    }
  });

  // 7.7 Listen to positions → update local positionsData + redraw positions
  dbRefPositions.on('value', snap => {
    positionsData = snap.val() || {};
    renderPositions();
  });

  // 7.8 Listen to events child_added → only handle events with timestamp ≥ gameStartTime
  dbRefEvents.on('child_added', snap => {
    const ev = snap.val();
    if (gameStartTime && ev.timestamp < gameStartTime) {
      return; // ignore old leftover events
    }
    handleGameEvent(ev);
  });
}

// -------- 8. Render Players + Group Status in Lobby --------
function renderPlayersAndGroups() {
  playerListUl.innerHTML = '';
  groupListUl.innerHTML  = '';

  // Prepare 6 buckets for group1..group6
  const groupBuckets = {
    group1: [], group2: [], group3: [],
    group4: [], group5: [], group6: []
  };
  Object.entries(playersData).forEach(([pid, info]) => {
    // show player list
    const li = document.createElement('li');
    li.innerText = `${info.nick} (${info.groupId || 'No group'})`;
    playerListUl.appendChild(li);

    // add to bucket
    if (info.groupId && groupBuckets[info.groupId]) {
      groupBuckets[info.groupId].push(info.nick);
    }
  });

  // show each group's members; if empty show “–”
  Object.entries(groupBuckets).forEach(([grp, names]) => {
    const li = document.createElement('li');
    li.innerText = `${grp}: ${names.length > 0 ? names.join(', ') : '–'}`;
    groupListUl.appendChild(li);
  });
}

// -------- 9. “Join Group” Button Handler --------
btnJoinGroup.addEventListener('click', () => {
  const chosen = selGroup.value; // e.g. "group3"
  if (!roomId) return;
  db.ref(`rooms/${roomId}/players/${playerId}/groupId`).set(chosen);
  showToast(`Joined ${chosen}`);
});

// -------- 10. Host Clicks “Start Game” --------
btnStart.addEventListener('click', async () => {
  // 10.1 Require at least two players assigned to groups
  const assigned = Object.values(playersData)
    .map(p => p.groupId)
    .filter(g => g !== null);
  if (assigned.length < 2) {
    return alert('At least two players must join groups before starting.');
  }

  // 10.2 Build 6 buckets: collect socketIds per group
  const groupBuckets = {
    group1: [], group2: [], group3: [],
    group4: [], group5: [], group6: []
  };
  Object.entries(playersData).forEach(([pid, info]) => {
    if (info.groupId && groupBuckets[info.groupId]) {
      groupBuckets[info.groupId].push(pid);
    }
  });

  // 10.3 Keep only non-empty groups, then shuffle
  const nonEmpty = Object.entries(groupBuckets)
    .filter(([gid, arr]) => arr.length > 0)
    .map(([gid]) => gid);
  const randomizedOrder = shuffleArray(nonEmpty);

  // 10.4 Compute gameEndTime & startTime
  const nowTs = Date.now();
  const endTs = nowTs + TOTAL_GAME_TIME * 1000;

  // 10.5 **Clear all old events** under `/rooms/{roomId}/events`
  await dbRefRoom.child('events').remove();
  // Also clear old answerBuffer
  await dbRefRoom.child('answerBuffer').remove();

  // 10.6 Update state with status="playing", groupOrder, turnIndex, questionInProgress, gameEndTime, startTime
  await dbRefState.update({
    status: 'playing',
    groupOrder: randomizedOrder,
    turnIndex: 0,
    questionInProgress: false,
    gameEndTime: endTs,
    startTime: nowTs
  });
});

// -------- 11. Enter Game UI --------
function enterGameUI() {
  roomInfoDiv.classList.add('hidden');
  gameDiv.classList.remove('hidden');
  startGameLoop();
}

// -------- 12. Main Game Loop: countdown & initial turn --------
let gameTimerInterval = null;
async function startGameLoop() {
  // 12.1 Fetch endTime
  const snap = await dbRefState.child('gameEndTime').get();
  const endTs = snap.val() || (Date.now() + TOTAL_GAME_TIME * 1000);

  // 12.2 Every second update remaining time; when <= 0, endGame
  gameTimerInterval = setInterval(async () => {
    const remain = Math.max(0, Math.floor((endTs - Date.now()) / 1000));
    timerSpan.innerText = remain;
    if (remain <= 0) {
      clearInterval(gameTimerInterval);
      endGame();
    }
  }, 1000);

  // 12.3 Draw initial turn
  updateTurnDisplay();
}

// -------- 13. Update Turn Display & possibly auto-roll --------
let diceTimeoutHandle = null;
function updateTurnDisplay() {
  dbRefState.child('turnIndex').get().then(snap => {
    const turnIdx = snap.val() || 0;
    const groupId = groupOrder[turnIdx % groupOrder.length] || '';
    orderInfo.innerText = `Order: ${groupOrder.join(' → ')}`;
    turnInfo.innerText  = `Current Turn: ${groupId}`;

    // If it's my group's turn, show Roll button; otherwise hide
    const myGroup = playersData[playerId]?.groupId;
    if (myGroup === groupId) {
      btnRoll.classList.remove('hidden');
      nonTurnMsg.classList.add('hidden');
    } else {
      btnRoll.classList.add('hidden');
      nonTurnMsg.classList.remove('hidden');
    }

    // 5s auto-roll if it's my group and I haven’t clicked
    clearTimeout(diceTimeoutHandle);
    if (myGroup === groupId) {
      diceTimeoutHandle = setTimeout(() => {
        rollDiceAndPublish();
        showToast('5s timeout → auto-rolled');
      }, DICE_TIMEOUT);
    }
  });
}

// -------- 14. Roll Dice Event --------
btnRoll.addEventListener('click', () => {
  rollDiceAndPublish();
});
async function rollDiceAndPublish() {
  // 14.1 Ensure no question is currently in progress
  const snap = await dbRefState.child('questionInProgress').get();
  if (snap.val()) return;

  // 14.2 Random 1~6
  const dice = Math.floor(Math.random() * 6) + 1;

  // 14.3 Push a rollDice event into /rooms/{roomId}/events
  const evKey = dbRefEvents.push().key;
  const myGrp = playersData[playerId]?.groupId;
  const evData = {
    type: 'rollDice',
    groupId: myGrp,
    dice,
    timestamp: Date.now()
  };
  await dbRefEvents.child(evKey).set(evData);

  // 14.4 Set questionInProgress = true so no duplicate rolls
  await dbRefState.update({ questionInProgress: true });

  // 14.5 Update this group's position immediately (oldPos + dice)
  const oldPos = positionsData[myGrp] || 0;
  const newPos = Math.max(0, oldPos + dice);
  await dbRefPositions.child(myGrp).set(newPos);

  // 14.6 Pick a random question from questions.json client-side
  const questions = await fetch('questions.json').then(r => r.json());
  const q = questions[Math.floor(Math.random() * questions.length)];
  const choices = shuffleArray(q.options.slice());

  // 14.7 Clear answerBuffer
  await dbRefRoom.child('answerBuffer').remove();

  // 14.8 Schedule auto-answer processing in 10s
  setTimeout(() => {
    processAnswers();
  }, ANSWER_TIMEOUT);

  // 14.9 Push an askQuestion event into /rooms/{roomId}/events
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

// -------- 15. Handle any new event under /rooms/{roomId}/events --------
async function handleGameEvent(ev) {
  // Filter out old events (timestamp < gameStartTime)
  if (gameStartTime && ev.timestamp < gameStartTime) {
    return;
  }

  if (ev.type === 'rollDice') {
    // Show toast: “Group X rolled Y”
    showToast(`Group ${ev.groupId} rolled: ${ev.dice}`);
    btnRoll.classList.add('hidden');
  }
  else if (ev.type === 'askQuestion') {
    // Only the group whose turn it is sees the question pop up
    const turnIdx    = await dbRefState.child('turnIndex').get().then(s => s.val());
    const currentGrp = groupOrder[turnIdx % groupOrder.length];
    if (ev.groupId !== currentGrp) return;
    showQuestionUI(ev.question, ev.choices, ev.answer);
  }
  else if (ev.type === 'afterAnswer') {
    // Show toast: “Group X processed answer, Δ = +2 (or -4 etc.)”
    showToast(`Group ${ev.groupId} Δ = ${ev.delta}`);
    goToNextTurn();
  }
}

// -------- 16. Show Question UI & Start 10s Countdown --------
let questionCountdown = null;
let correctAnswer = '';
function showQuestionUI(questionText, choices, answerKey) {
  questionArea.classList.remove('hidden');
  btnSubmitAns.classList.remove('hidden');
  nonTurnMsg.classList.add('hidden');

  qText.innerText = questionText;
  correctAnswer = answerKey.trim().toUpperCase();

  // Render choices
  choicesList.innerHTML = '';
  choices.forEach((opt, idx) => {
    const label = document.createElement('label');
    label.innerHTML = `
      <input type="radio" name="choice" value="${opt.charAt(0)}" />
      ${opt}`;
    choicesList.appendChild(label);
  });

  // 10s countdown
  let timeLeft = ANSWER_TIMEOUT / 1000;
  questionTimer.innerText = timeLeft;
  clearInterval(questionCountdown);
  questionCountdown = setInterval(() => {
    timeLeft--;
    questionTimer.innerText = timeLeft;
    if (timeLeft <= 0) {
      clearInterval(questionCountdown);
      submitAnswer(null); // timed out → incorrect
    }
  }, 1000);

  // Bind Submit Answer click
  btnSubmitAns.onclick = () => {
    const checked = document.querySelector('input[name="choice"]:checked');
    const selected = checked ? checked.value.trim().toUpperCase() : null;
    clearInterval(questionCountdown);
    submitAnswer(selected);
  };
}

// -------- 17. submitAnswer: write into answerBuffer & maybe early process --------
async function submitAnswer(answer) {
  questionArea.classList.add('hidden');
  btnSubmitAns.classList.add('hidden');

  // Write to /rooms/{roomId}/answerBuffer/{playerId}
  await dbRefRoom.child(`answerBuffer/${playerId}`).set(answer || '');

  // Count how many in my group have answered
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

// -------- 18. processAnswers: compute delta & push afterAnswer --------
async function processAnswers() {
  // 18.1 Reset questionInProgress = false
  await dbRefState.update({ questionInProgress: false });

  // 18.2 Get current turnIndex & that groupId
  const turnIdx = await dbRefState.child('turnIndex').get().then(s => s.val());
  const grpId   = groupOrder[turnIdx % groupOrder.length];

  // 18.3 Read all answers in answerBuffer
  const snapBuf = await db.ref(`rooms/${roomId}/answerBuffer`).get();
  const bufData = snapBuf.val() || {};

  // 18.4 Count group size & how many correct
  const members = Object.entries(playersData)
    .filter(([, info]) => info.groupId === grpId)
    .map(([pid]) => pid);

  let correctCount = 0;
  members.forEach(pid => {
    const ans = (bufData[pid] || '').toString().trim().toUpperCase();
    if (ans === correctAnswer) correctCount++;
  });
  const groupSize = members.length;

  // 18.5 Compute delta: if all correct +2; if less than half, −(size×2); else 0
  let delta = 0;
  if (correctCount === groupSize) {
    delta = +2;
  } else if (correctCount < groupSize / 2) {
    delta = -(groupSize * 2);
  } else {
    delta = 0;
  }

  // 18.6 Update that group's position
  const oldPos = positionsData[grpId] || 0;
  const newPos = Math.max(0, oldPos + delta);
  await dbRefPositions.child(grpId).set(newPos);

  // 18.7 Push an afterAnswer event
  const afterKey = dbRefEvents.push().key;
  await dbRefEvents.child(afterKey).set({
    type: 'afterAnswer',
    groupId: grpId,
    correctCount,
    delta,
    timestamp: Date.now()
  });

  // 18.8 Move to next turn
  goToNextTurn();
}

// -------- 19. Go to Next Turn (update turnIndex) --------
async function goToNextTurn() {
  const turnIdx = await dbRefState.child('turnIndex').get().then(s => s.val());
  const nextIdx = (turnIdx + 1) % groupOrder.length;
  await dbRefState.update({ turnIndex: nextIdx });
}

// -------- 20. Render Positions (only for active groups in groupOrder) --------
function renderPositions() {
  posListUl.innerHTML = '';
  // Only show groups that are in groupOrder (these are non-empty)
  groupOrder.forEach(grp => {
    if (positionsData.hasOwnProperty(grp)) {
      const li = document.createElement('li');
      li.innerText = `${grp}: ${positionsData[grp]}`;
      posListUl.appendChild(li);
    }
  });
}

// -------- 21. End Game: show result --------
async function endGame() {
  gameDiv.classList.add('hidden');
  resultDiv.classList.remove('hidden');

  // Ranking by final position (positionsData)
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

// -------- 22. Also listen to gameEndTime once, to auto end game if time runs out --------
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
