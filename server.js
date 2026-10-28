'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;
const START_CHIPS = 500;
const MIN_BET = 10;
const DEALER_DELAY = 1000;        // ms between dealer actions
const GRACE_MS = 2 * 60 * 1000;   // how long a disconnected player keeps their seat

/* ---------- static file server (just the one page) ---------- */
const INDEX = path.join(__dirname, 'index.html');
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    fs.readFile(INDEX, (err, data) => {
      if (err) { res.writeHead(500); return res.end('Server error'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  } else if (url === '/healthz') {
    res.writeHead(200); res.end('ok');
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

/* ---------- cards ---------- */
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function newShoe() {
  const shoe = [];
  for (let d = 0; d < 4; d++) for (const s of SUITS) for (const r of RANKS) shoe.push({ r, s });
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}

function handValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) {
    if (c.r === 'A') { aces++; total += 11; }
    else if (['K', 'Q', 'J', '10'].includes(c.r)) total += 10;
    else total += parseInt(c.r, 10);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return { total, soft: aces > 0 };
}
const isBlackjack = cards => cards.length === 2 && handValue(cards).total === 21;

/* ---------- rooms ---------- */
const rooms = new Map();

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += letters[crypto.randomInt(letters.length)];
  } while (rooms.has(code));
  return code;
}

function newRoom(solo) {
  return {
    code: makeCode(), solo: !!solo, players: [], phase: 'betting', round: 1,
    dealer: [], shoe: newShoe(), turn: null, timer: null,
  };
}

function newPlayer(name) {
  return {
    id: crypto.randomBytes(3).toString('hex'), token: crypto.randomBytes(16).toString('hex'),
    name, chips: START_CHIPS, bet: 0, hand: [], status: 'waiting', result: null, delta: 0,
    ready: false, rebought: false, connected: false, ws: null, dropTimer: null,
  };
}

const cleanName = n => String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14) || 'Player';
const draw = room => { if (!room.shoe.length) room.shoe = newShoe(); return room.shoe.pop(); };

function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function viewFor(room) {
  const reveal = room.phase === 'dealer' || room.phase === 'results';
  const d = room.dealer;
  let cards = [], total = null, blackjack = false;
  if (d.length) {
    if (reveal) { cards = d; total = handValue(d).total; blackjack = isBlackjack(d); }
    else { cards = d.map((c, i) => (i === 1 ? null : c)); total = handValue([d[0]]).total; }
  }
  return {
    code: room.code, solo: room.solo, phase: room.phase, round: room.round, turn: room.turn,
    dealer: { cards, total, hidden: d.length > 0 && !reveal, blackjack },
    players: room.players.map(p => {
      const v = handValue(p.hand);
      return {
        id: p.id, name: p.name, chips: p.chips, bet: p.bet, hand: p.hand, total: v.total, soft: v.soft,
        status: p.status, result: p.result, delta: p.delta, ready: p.ready,
        connected: p.connected, rebought: p.rebought,
      };
    }),
  };
}

function broadcast(room) {
  const state = viewFor(room);
  for (const p of room.players) if (p.connected) send(p.ws, { type: 'state', you: p.id, state });
}

/* ---------- game flow ---------- */
function startRound(room) {
  clearTimeout(room.timer);
  if (room.shoe.length < 60) room.shoe = newShoe();
  room.round++;
  room.dealer = [];
  room.phase = 'betting';
  room.turn = null;
  for (const p of room.players) {
    p.hand = []; p.bet = 0; p.status = 'waiting'; p.result = null; p.delta = 0; p.ready = false;
    p.rebought = false;
    if (p.chips < MIN_BET) { p.chips = START_CHIPS; p.rebought = true; }
  }
  broadcast(room);
}

function checkAllBet(room) {
  const connected = room.players.filter(p => p.connected);
  const need = room.solo ? 1 : 2;
  if (connected.length >= need && connected.every(p => p.bet > 0)) deal(room);
  else broadcast(room);
}

function checkAllReady(room) {
  const connected = room.players.filter(p => p.connected);
  if (connected.length > 0 && connected.every(p => p.ready)) startRound(room);
  else broadcast(room);
}

function deal(room) {
  room.phase = 'playing';
  const part = room.players.filter(p => p.bet > 0);
  for (let pass = 0; pass < 2; pass++) {
    for (const p of part) p.hand.push(draw(room));
    room.dealer.push(draw(room));
  }
  for (const p of part) p.status = isBlackjack(p.hand) ? 'blackjack' : 'playing';

  if (isBlackjack(room.dealer)) {          // dealer peeks: round ends at once
    room.phase = 'dealer';
    room.turn = null;
    broadcast(room);
    room.timer = setTimeout(() => settle(room), DEALER_DELAY * 1.5);
    return;
  }
  advance(room);
}

// Hand the turn to the next player still playing (or move on to the dealer).
function advance(room) {
  for (;;) {
    const p = room.players.find(x => x.status === 'playing');
    if (!p) return startDealer(room);
    if (!p.connected) { p.status = 'stood'; continue; }   // auto-stand if they dropped
    room.turn = p.id;
    broadcast(room);
    return;
  }
}

function startDealer(room) {
  room.phase = 'dealer';
  room.turn = null;
  broadcast(room);
  const needsDraw = room.players.some(p => p.status === 'stood');
  const step = () => {
    if (needsDraw && handValue(room.dealer).total < 17) {   // dealer stands on all 17s
      room.dealer.push(draw(room));
      broadcast(room);
      room.timer = setTimeout(step, DEALER_DELAY);
    } else {
      room.timer = setTimeout(() => settle(room), DEALER_DELAY * 0.8);
    }
  };
  room.timer = setTimeout(step, DEALER_DELAY);
}

function settle(room) {
  const dv = handValue(room.dealer).total;
  const dealerBJ = isBlackjack(room.dealer);
  for (const p of room.players) {
    if (p.bet <= 0 || !p.hand.length) continue;
    const pv = handValue(p.hand).total;
    let result, payout;
    if (p.status === 'busted') { result = 'bust'; payout = 0; }
    else if (p.status === 'blackjack') {
      if (dealerBJ) { result = 'push'; payout = p.bet; }
      else { result = 'blackjack'; payout = p.bet + Math.floor(p.bet * 1.5); }
    }
    else if (dealerBJ) { result = 'lose'; payout = 0; }
    else if (dv > 21 || pv > dv) { result = 'win'; payout = p.bet * 2; }
    else if (pv === dv) { result = 'push'; payout = p.bet; }
    else { result = 'lose'; payout = 0; }
    p.chips += payout;
    p.delta = payout - p.bet;
    p.result = result;
  }
  room.phase = 'results';
  room.turn = null;
  for (const p of room.players) p.ready = false;
  broadcast(room);
}

function act(room, p, msg) {
  switch (msg.type) {
    case 'bet': {
      const amt = Number(msg.amount);
      if (room.phase !== 'betting' || p.bet > 0) return;
      if (!Number.isInteger(amt) || amt < MIN_BET || amt > p.chips) return send(p.ws, { type: 'error', message: 'Invalid bet.' });
      p.chips -= amt; p.bet = amt; p.status = 'betPlaced';
      return checkAllBet(room);
    }
    case 'hit': case 'stand': case 'double': {
      if (room.phase !== 'playing' || room.turn !== p.id || p.status !== 'playing') return;
      if (msg.type === 'stand') {
        p.status = 'stood';
      } else if (msg.type === 'hit') {
        p.hand.push(draw(room));
        const v = handValue(p.hand).total;
        if (v > 21) p.status = 'busted'; else if (v === 21) p.status = 'stood';
      } else {
        if (p.hand.length !== 2 || p.chips < p.bet) return send(p.ws, { type: 'error', message: "You can't double right now." });
        p.chips -= p.bet; p.bet *= 2;
        p.hand.push(draw(room));
        p.status = handValue(p.hand).total > 21 ? 'busted' : 'stood';
      }
      if (p.status === 'playing') broadcast(room); else advance(room);
      return;
    }
    case 'ready':
      if (room.phase !== 'results') return;
      p.ready = true;
      return checkAllReady(room);
  }
}

/* ---------- connections ---------- */
function afterPresenceChange(room) {
  if (room.phase === 'betting') checkAllBet(room);
  else if (room.phase === 'playing') advance(room);
  else if (room.phase === 'results') checkAllReady(room);
  else broadcast(room);
}

function removePlayer(room, p) {
  clearTimeout(p.dropTimer);
  room.players = room.players.filter(x => x !== p);
  if (!room.players.length) { clearTimeout(room.timer); rooms.delete(room.code); return; }
  afterPresenceChange(room);
}

function onDisconnect(room, p, ws) {
  if (p.ws !== ws) return;   // they already reconnected on another socket
  p.ws = null; p.connected = false;
  p.dropTimer = setTimeout(() => removePlayer(room, p), GRACE_MS);
  afterPresenceChange(room);
}

function attach(ws, room, p) {
  clearTimeout(p.dropTimer);
  if (p.ws && p.ws !== ws) { const old = p.ws; p.ws = null; try { old.close(); } catch (e) {} }
  p.ws = ws; p.connected = true; ws.ctx = { room, player: p };
  send(ws, { type: 'joined', code: room.code, token: p.token, id: p.id });
}

function handle(ws, msg) {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'create' && !ws.ctx) {
    const room = newRoom(msg.solo);
    const p = newPlayer(cleanName(msg.name));
    room.players.push(p); rooms.set(room.code, room);
    attach(ws, room, p); broadcast(room);
    return;
  }
  if (msg.type === 'join' && !ws.ctx) {
    const room = rooms.get(String(msg.code || '').toUpperCase().trim());
    if (!room) return send(ws, { type: 'error', message: 'No table with that code.' });
    if (room.players.length >= MAX_PLAYERS) return send(ws, { type: 'error', message: 'That table is full.' });
    const p = newPlayer(cleanName(msg.name));
    room.players.push(p);
    attach(ws, room, p);
    if (room.phase === 'betting') checkAllBet(room); else broadcast(room);
    return;
  }
  if (msg.type === 'rejoin' && !ws.ctx) {
    const room = rooms.get(String(msg.code || '').toUpperCase());
    const p = room && room.players.find(x => x.token === msg.token);
    if (!p) return send(ws, { type: 'rejoinFailed' });
    attach(ws, room, p);
    broadcast(room);
    return;
  }
  if (ws.ctx) act(ws.ctx.room, ws.ctx.player, msg);
}

const wss = new WebSocketServer({ server, maxPayload: 4096 });
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.ctx = null;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    try { handle(ws, msg); } catch (e) { console.error(e); }
  });
  ws.on('close', () => { if (ws.ctx) onDisconnect(ws.ctx.room, ws.ctx.player, ws); });
});

// Heartbeat: keeps connections alive through proxies and detects dead ones.
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => console.log(`Blackjack running on http://localhost:${PORT}`));
