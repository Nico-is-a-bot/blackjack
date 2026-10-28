// Plays several rounds with two simulated clients and checks the rules hold.
const WebSocket = require('ws');
const URL = 'ws://localhost:' + (process.env.PORT || 3456);

function client(name) {
  const ws = new WebSocket(URL);
  const c = { name, ws, state: null, id: null, token: null, code: null, ready: new Promise(r => ws.on('open', r)) };
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type === 'joined') { c.id = m.id; c.code = m.code; c.token = m.token; }
    if (m.type === 'state') { c.id = m.you; c.state = m.state; c.onState && c.onState(); }
    if (m.type === 'error') console.log(name, 'ERROR', m.message);
  });
  c.send = o => ws.send(JSON.stringify(o));
  return c;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } };

(async () => {
  const a = client('Alice'), b = client('Bob');
  await Promise.all([a.ready, b.ready]);
  a.send({ type: 'create', name: 'Alice' });
  await sleep(200);
  assert(a.code && a.code.length === 4, 'room code');

  // Alice bets alone: round must NOT start until Bob joins.
  a.send({ type: 'bet', amount: 50 });
  await sleep(200);
  assert(a.state.phase === 'betting', 'should wait for friend');
  b.send({ type: 'join', code: a.code, name: 'Bob' });
  await sleep(200);
  assert(b.state.players.length === 2, 'bob joined');
  b.send({ type: 'bet', amount: 25 });
  await sleep(300);
  assert(a.state.phase === 'playing' || a.state.phase === 'dealer' || a.state.phase === 'results', 'round started, phase=' + a.state.phase);
  assert(a.state.dealer.cards.length === 2, 'dealer has 2 cards');
  if (a.state.phase === 'playing') assert(a.state.dealer.cards[1] === null, 'hole card hidden');

  const players = [a, b];
  for (let round = 1; round <= 6; round++) {
    // play until results
    for (let i = 0; i < 200 && a.state.phase !== 'results'; i++) {
      for (const p of players) {
        const s = p.state;
        if (s.phase === 'playing' && s.turn === p.id) {
          const me = s.players.find(x => x.id === p.id);
          p.send({ type: me.total < 15 ? 'hit' : 'stand' });
        }
      }
      await sleep(60);
    }
    assert(a.state.phase === 'results', 'reached results in round ' + round);
    const dealerCards = a.state.dealer.cards;
    assert(dealerCards.every(c => c), 'dealer revealed');
    const summary = a.state.players.map(p => `${p.name}:${p.result}(${p.delta >= 0 ? '+' : ''}${p.delta}) $${p.chips}`).join('  ');
    console.log(`round ${round}: dealer ${a.state.dealer.total}  ${summary}`);

    // next round
    a.send({ type: 'ready' }); b.send({ type: 'ready' });
    await sleep(200);
    assert(a.state.phase === 'betting', 'back to betting');
    a.send({ type: 'bet', amount: 10 }); b.send({ type: 'bet', amount: 10 });
    await sleep(300);
  }

  // Reconnect test: Bob drops and rejoins with his token.
  const old = { id: b.id, token: b.token, code: b.code };
  b.ws.close();
  await sleep(300);
  assert(a.state.players.find(p => p.id === old.id).connected === false, 'bob marked disconnected');
  const b2 = client('Bob2');
  await b2.ready;
  b2.send({ type: 'rejoin', code: old.code, token: old.token });
  await sleep(300);
  assert(b2.id === old.id && b2.state, 'bob rejoined same seat');
  assert(a.state.players.find(p => p.id === old.id).connected === true, 'bob marked connected again');

  // Bad inputs shouldn't crash anything.
  b2.send({ type: 'bet', amount: -5 }); b2.send({ type: 'bet', amount: 'abc' }); b2.send({ type: 'nonsense' });
  b2.ws.send('not json');
  await sleep(200);

  console.log('ALL OK');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
