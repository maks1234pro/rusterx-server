const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

// ============ СЕРВЕРИ ============
const SERVERS = {
  nolimit: {
    id: 'nolimit',
    name: 'No Limit',
    wipeInterval: 30 * 24 * 60 * 60 * 1000, // 30 днів
    lastWipe: Date.now(),
    multiplier: 1,
    pvp: false,
    players: new Map(),
    buildings: [],
    enemies: [],
    worldSeed: Date.now()
  },
  x5: {
    id: 'x5',
    name: '5x Speed',
    wipeInterval: 7 * 24 * 60 * 60 * 1000, // 7 днів
    lastWipe: Date.now(),
    multiplier: 5,
    pvp: true,
    players: new Map(),
    buildings: [],
    enemies: [],
    worldSeed: Date.now() + 1
  }
};

// ============ HTTP (health + статика) ============
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      servers: Object.values(SERVERS).map(s => ({
        id: s.id,
        name: s.name,
        online: s.players.size,
        multiplier: s.multiplier,
        pvp: s.pvp,
        nextWipe: s.lastWipe + s.wipeInterval,
        msUntilWipe: Math.max(0, s.lastWipe + s.wipeInterval - Date.now()),
        wipeInterval: s.wipeInterval
      }))
    }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`RusterX Server OK\nPlayers: ${
    Object.values(SERVERS).map(s => `${s.id}=${s.players.size}`).join(', ')
  }`);
});

// ============ WEBSOCKET ============
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  ws.id = Math.random().toString(36).slice(2, 10);
  ws.server = null;
  ws.name = 'Guest';
  ws.lastPos = { x: 0, z: 0 };
  ws.lastMoveTime = Date.now();

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      handleMessage(ws, msg);
    } catch (e) {}
  });

  ws.on('close', () => {
    if (ws.server && SERVERS[ws.server]) {
      SERVERS[ws.server].players.delete(ws.id);
      broadcastToServer(ws.server, {
        type: 'player_leave',
        id: ws.id,
        name: ws.name
      }, ws);
    }
  });

  ws.on('error', () => {});
});

// ============ ОБРОБНИКИ ============
function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'join': return handleJoin(ws, msg);
    case 'move': return handleMove(ws, msg);
    case 'mine': return handleMine(ws, msg);
    case 'place': return handlePlace(ws, msg);
    case 'attack': return handleAttack(ws, msg);
    case 'servers_info': return sendServersInfo(ws);
    case 'ping': return ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
  }
}

function handleJoin(ws, msg) {
  const srv = SERVERS[msg.server];
  if (!srv) return ws.send(JSON.stringify({ type: 'error', msg: 'Server not found' }));

  // Автовайп якщо прострочено
  if (Date.now() >= srv.lastWipe + srv.wipeInterval) {
    performWipe(srv.id);
  }

  ws.server = srv.id;
  ws.name = (msg.name || 'Guest').slice(0, 16).replace(/[<>]/g, '');

  const player = {
    id: ws.id,
    name: ws.name,
    x: (Math.random() - 0.5) * 20,
    z: (Math.random() - 0.5) * 20,
    yaw: 0,
    health: 100,
    kills: 0,
    wood: 0, stone: 0, metal: 0
  };
  srv.players.set(ws.id, player);

  ws.send(JSON.stringify({
    type: 'welcome',
    id: ws.id,
    server: srv.id,
    multiplier: srv.multiplier,
    pvp: srv.pvp,
    player,
    worldSeed: srv.worldSeed,
    nextWipe: srv.lastWipe + srv.wipeInterval,
    wipeInterval: srv.wipeInterval,
    players: Array.from(srv.players.values()).filter(p => p.id !== ws.id),
    buildings: srv.buildings,
    enemies: srv.enemies
  }));

  broadcastToServer(srv.id, { type: 'player_join', player }, ws);
  console.log(`[${srv.id}] ${ws.name} joined (${srv.players.size})`);
}

function handleMove(ws, msg) {
  if (!ws.server) return;
  const srv = SERVERS[ws.server];
  const p = srv.players.get(ws.id);
  if (!p) return;

  // Античіт (телепорт)
  const now = Date.now();
  const dt = (now - ws.lastMoveTime) / 1000;
  if (dt > 0.05) {
    const dist = Math.hypot(msg.x - ws.lastPos.x, msg.z - ws.lastPos.z);
    if (dist / dt > 15) return;
    ws.lastPos = { x: msg.x, z: msg.z };
    ws.lastMoveTime = now;
  }

  p.x = msg.x; p.z = msg.z; p.yaw = msg.yaw;

  broadcastToServer(ws.server, {
    type: 'player_move',
    id: ws.id, x: msg.x, z: msg.z, yaw: msg.yaw
  }, ws);
}

function handleMine(ws, msg) {
  if (!ws.server) return;
  const srv = SERVERS[ws.server];
  const p = srv.players.get(ws.id);
  if (!p) return;

  const gain = 3 * srv.multiplier;
  if (msg.resourceType === 'tree') p.wood += gain;
  else p.stone += gain;

  ws.send(JSON.stringify({
    type: 'resource_gain',
    wood: p.wood, stone: p.stone, metal: p.metal,
    gained: { type: msg.resourceType, amount: gain }
  }));
}

function handlePlace(ws, msg) {
  if (!ws.server) return;
  const srv = SERVERS[ws.server];
  const p = srv.players.get(ws.id);
  if (!p) return;

  const type = msg.buildType;
  const cost = type === 'wall' ? { wood: 3, stone: 2 } : { wood: 5, stone: 5 };
  if (p.wood < cost.wood || p.stone < cost.stone) {
    return ws.send(JSON.stringify({ type: 'error', msg: 'Not enough resources' }));
  }

  p.wood -= cost.wood;
  p.stone -= cost.stone;

  const building = {
    id: 'b_' + Math.random().toString(36).slice(2, 8),
    type, x: msg.x, z: msg.z, yaw: msg.yaw || 0,
    owner: ws.id, ownerName: ws.name,
    hp: type === 'wall' ? 100 : 50
  };
  srv.buildings.push(building);

  broadcastToServer(ws.server, { type: 'building_placed', building });
  ws.send(JSON.stringify({
    type: 'resources_update',
    wood: p.wood, stone: p.stone, metal: p.metal
  }));
}

function handleAttack(ws, msg) {
  if (!ws.server) return;
  const srv = SERVERS[ws.server];
  const attacker = srv.players.get(ws.id);
  if (!attacker) return;

  if (msg.targetType === 'enemy') {
    const enemy = srv.enemies.find(e => e.id === msg.targetId);
    if (!enemy) return;
    if (Math.hypot(enemy.x - attacker.x, enemy.z - attacker.z) > 5) return;
    enemy.hp -= 1;
    if (enemy.hp <= 0) {
      srv.enemies = srv.enemies.filter(e => e.id !== enemy.id);
      attacker.kills++;
      broadcastToServer(ws.server, {
        type: 'enemy_killed',
        enemyId: enemy.id,
        killerName: ws.name
      });
    }
  }
}

function sendServersInfo(ws) {
  ws.send(JSON.stringify({
    type: 'servers_info',
    servers: Object.values(SERVERS).map(s => ({
      id: s.id, name: s.name,
      online: s.players.size,
      multiplier: s.multiplier, pvp: s.pvp,
      nextWipe: s.lastWipe + s.wipeInterval,
      msUntilWipe: Math.max(0, s.lastWipe + s.wipeInterval - Date.now()),
      wipeInterval: s.wipeInterval
    }))
  }));
}

function broadcastToServer(serverId, msg, excludeWs) {
  const srv = SERVERS[serverId];
  if (!srv) return;
  const data = JSON.stringify(msg);
  wss.clients.forEach(c => {
    if (c !== excludeWs && c.readyState === WebSocket.OPEN && c.server === serverId) {
      c.send(data);
    }
  });
}

// ============ ВАЙП ============
function performWipe(serverId) {
  const srv = SERVERS[serverId];
  if (!srv) return;

  console.log(`🔄 WIPE on ${srv.id}`);

  srv.buildings = [];
  srv.enemies = [];
  srv.worldSeed = Date.now();
  srv.lastWipe = Date.now();

  srv.players.forEach(p => {
    p.wood = 0; p.stone = 0; p.metal = 0;
    p.kills = 0; p.health = 100;
    p.x = (Math.random() - 0.5) * 20;
    p.z = (Math.random() - 0.5) * 20;
  });

  broadcastToServer(srv.id, {
    type: 'wipe',
    lastWipe: srv.lastWipe,
    nextWipe: srv.lastWipe + srv.wipeInterval,
    worldSeed: srv.worldSeed,
    message: `ВАЙП на ${srv.name}!`
  });

  console.log(`✅ Wipe complete on ${srv.id}`);
}

// Перевірка кожні 60с
setInterval(() => {
  const now = Date.now();
  Object.values(SERVERS).forEach(srv => {
    if (now >= srv.lastWipe + srv.wipeInterval) {
      performWipe(srv.id);
    }
  });
}, 60000);

// ============ СТАРТ ============
server.listen(PORT, () => {
  console.log(`🎮 RusterX Server on ${PORT}`);
  Object.values(SERVERS).forEach(s => {
    const days = s.wipeInterval / 86400000;
    console.log(`   ${s.name}: wipe every ${days} days`);
  });
});
