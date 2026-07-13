import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');
const dataDir = process.env.DATA_DIR ? normalize(process.env.DATA_DIR) : join(root, 'data');
const dbPath = join(dataDir, 'db.json');
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';

mkdirSync(dataDir, { recursive: true });

function defaultDb(){
  return { users: {}, sessions: {}, rooms: {} };
}

function readDb(){
  if(!existsSync(dbPath)) return defaultDb();
  try{
    return { ...defaultDb(), ...JSON.parse(readFileSync(dbPath, 'utf8')) };
  }catch{
    return defaultDb();
  }
}

function writeDb(db){
  writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
}

function json(res, status, body){
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(text);
}

function safeEqual(a, b){
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function hashPassword(password, salt=randomBytes(16).toString('hex')){
  const hash = createHash('sha256').update(`${salt}:${password}`).digest('hex');
  return { salt, hash };
}

function makeToken(){
  return randomBytes(32).toString('hex');
}

function roomCode(){
  return randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
}

async function readBody(req){
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if(!raw) return {};
  return JSON.parse(raw);
}

function getUser(req, db){
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const uid = db.sessions[token];
  return uid ? { token, uid, user: db.users[uid] } : null;
}

function publicUser(user){
  return { uid: user.uid, loginId: user.loginId || user.email || '', nickname: user.nickname || '' };
}
function rankFor(user){
  const state = user.state || {};
  const discovered = Array.isArray(state.discovered) ? state.discovered.length : 0;
  const pulls = Math.max(0, Number(state.totalPulls) || 0);
  const coins = Math.max(0, Number(state.coins) || 0);
  return { discovered, pulls, score: discovered * 10000 + Math.min(pulls, 999999) + Math.floor(Math.log10(coins + 1) * 100) };
}

async function handleApi(req, res){
  const url = new URL(req.url, `http://${req.headers.host}`);
  const db = readDb();

  try{
    if(req.method === 'GET' && url.pathname === '/api/health'){
      return json(res, 200, { ok: true, name: 'country-gacha-online', time: Date.now() });
    }

    if(req.method === 'POST' && url.pathname === '/api/register'){
      const { loginId, password } = await readBody(req);
      const cleanId = String(loginId || '').trim().toLowerCase();
      if(!/^[a-z0-9_]{3,20}$/.test(cleanId) || String(password || '').length < 4) return json(res, 400, { error: '아이디는 영문, 숫자, 밑줄 3~20자이며 비밀번호는 4자 이상이어야 합니다' });
      if(Object.values(db.users).some(u=>String(u.loginId || u.email || '').toLowerCase() === cleanId)) return json(res, 409, { error: '이미 사용 중인 로그인 아이디입니다' });
      const uid = randomBytes(12).toString('hex');
      const pass = hashPassword(password);
      db.users[uid] = { uid, loginId: cleanId, nickname: '', pass, state: null, createdAt: Date.now(), updatedAt: Date.now() };
      const token = makeToken();
      db.sessions[token] = uid;
      writeDb(db);
      return json(res, 200, { token, user: publicUser(db.users[uid]) });
    }

    if(req.method === 'POST' && url.pathname === '/api/login'){
      const { loginId, password } = await readBody(req);
      const cleanId = String(loginId || '').trim().toLowerCase();
      const user = Object.values(db.users).find(u=>String(u.loginId || u.email || '').toLowerCase() === cleanId);
      if(!user) return json(res, 401, { error: 'invalid_login' });
      const pass = hashPassword(password, user.pass.salt);
      if(!safeEqual(pass.hash, user.pass.hash)) return json(res, 401, { error: 'invalid_login' });
      const token = makeToken();
      db.sessions[token] = user.uid;
      writeDb(db);
      return json(res, 200, { token, user: publicUser(user) });
    }

    if(req.method === 'GET' && url.pathname === '/api/me'){
      const current = getUser(req, db);
      if(!current) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, { user: publicUser(current.user) });
    }

    if(req.method === 'POST' && url.pathname === '/api/profile'){
      const current = getUser(req, db);
      if(!current) return json(res, 401, { error: 'unauthorized' });
      const { nickname } = await readBody(req);
      const clean = String(nickname || '').trim();
      if(clean.length < 2 || clean.length > 16) return json(res, 400, { error: '닉네임은 2~16자로 입력하세요' });
      if(Object.values(db.users).some(u=>u.uid !== current.uid && String(u.nickname || '').toLowerCase() === clean.toLowerCase())) return json(res, 409, { error: '이미 사용 중인 닉네임입니다' });
      current.user.nickname = clean;
      current.user.updatedAt = Date.now();
      writeDb(db);
      return json(res, 200, { user: publicUser(current.user) });
    }

    if(req.method === 'GET' && url.pathname === '/api/ranking'){
      const ranking = Object.values(db.users).map(user=>({ ...rankFor(user), nickname:user.nickname || user.loginId || user.email || '이름 없음' }))
        .sort((a,b)=>b.score-a.score || b.discovered-a.discovered || b.pulls-a.pulls).slice(0,100)
        .map((entry,index)=>({ rank:index+1, ...entry }));
      return json(res, 200, { ranking, updatedAt:Date.now() });
    }
    if(req.method === 'POST' && url.pathname === '/api/save'){
      const current = getUser(req, db);
      if(!current) return json(res, 401, { error: 'unauthorized' });
      const { state } = await readBody(req);
      current.user.state = state || null;
      current.user.updatedAt = Date.now();
      writeDb(db);
      return json(res, 200, { ok: true, updatedAt: current.user.updatedAt });
    }

    if(req.method === 'GET' && url.pathname === '/api/save'){
      const current = getUser(req, db);
      if(!current) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, { state: current.user.state, updatedAt: current.user.updatedAt });
    }

    if(req.method === 'POST' && url.pathname === '/api/rooms'){
      const current = getUser(req, db);
      if(!current) return json(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      let code = roomCode();
      while(db.rooms[code]) code = roomCode();
      db.rooms[code] = {
        code,
        hostUid: current.uid,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        state: body.state || { code, round: 1, host: {}, guest: {}, result: '' }
      };
      writeDb(db);
      return json(res, 200, { room: db.rooms[code] });
    }

    if(req.method === 'GET' && url.pathname.startsWith('/api/rooms/')){
      const code = url.pathname.split('/').pop().toUpperCase();
      const room = db.rooms[code];
      if(!room) return json(res, 404, { error: 'room_not_found' });
      return json(res, 200, { room });
    }

    if(req.method === 'POST' && url.pathname.startsWith('/api/rooms/')){
      const current = getUser(req, db);
      if(!current) return json(res, 401, { error: 'unauthorized' });
      const code = url.pathname.split('/').pop().toUpperCase();
      const room = db.rooms[code] || {
        code,
        hostUid: current.uid,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        state: { code, round: 1, host: {}, guest: {}, result: '' }
      };
      const { state } = await readBody(req);
      room.state = state || room.state;
      room.updatedAt = Date.now();
      db.rooms[code] = room;
      writeDb(db);
      return json(res, 200, { room });
    }

    return json(res, 404, { error: 'not_found' });
  }catch(error){
    return json(res, 500, { error: 'server_error', message: error.message });
  }
}

function serveStatic(req, res){
  const url = new URL(req.url, `http://${req.headers.host}`);
  let target = normalize(decodeURIComponent(url.pathname));
  if(target === '\\' || target === '/') target = '/index.html';
  const filePath = join(publicDir, target);
  if(!filePath.startsWith(publicDir) || !existsSync(filePath)){
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
  };
  res.writeHead(200, {
    'content-type': types[extname(filePath)] || 'application/octet-stream',
    'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'pragma': 'no-cache',
    'expires': '0'
  });
  createReadStream(filePath).pipe(res);
}

createServer((req, res)=>{
  if(req.url.startsWith('/api/')) return handleApi(req, res);
  serveStatic(req, res);
}).listen(port, host, ()=>{
  console.log(`Country Gacha Online: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
});

