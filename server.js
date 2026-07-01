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

async function handleApi(req, res){
  const url = new URL(req.url, `http://${req.headers.host}`);
  const db = readDb();

  try{
    if(req.method === 'GET' && url.pathname === '/api/health'){
      return json(res, 200, { ok: true, name: 'country-gacha-online', time: Date.now() });
    }

    if(req.method === 'POST' && url.pathname === '/api/register'){
      const { email, password } = await readBody(req);
      const cleanEmail = String(email || '').trim().toLowerCase();
      if(!cleanEmail || String(password || '').length < 4) return json(res, 400, { error: 'email_and_password_required' });
      if(Object.values(db.users).some(u=>u.email === cleanEmail)) return json(res, 409, { error: 'email_exists' });
      const uid = randomBytes(12).toString('hex');
      const pass = hashPassword(password);
      db.users[uid] = { uid, email: cleanEmail, pass, state: null, createdAt: Date.now(), updatedAt: Date.now() };
      const token = makeToken();
      db.sessions[token] = uid;
      writeDb(db);
      return json(res, 200, { token, user: { uid, email: cleanEmail } });
    }

    if(req.method === 'POST' && url.pathname === '/api/login'){
      const { email, password } = await readBody(req);
      const cleanEmail = String(email || '').trim().toLowerCase();
      const user = Object.values(db.users).find(u=>u.email === cleanEmail);
      if(!user) return json(res, 401, { error: 'invalid_login' });
      const pass = hashPassword(password, user.pass.salt);
      if(!safeEqual(pass.hash, user.pass.hash)) return json(res, 401, { error: 'invalid_login' });
      const token = makeToken();
      db.sessions[token] = user.uid;
      writeDb(db);
      return json(res, 200, { token, user: { uid: user.uid, email: user.email } });
    }

    if(req.method === 'GET' && url.pathname === '/api/me'){
      const current = getUser(req, db);
      if(!current) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, { user: { uid: current.uid, email: current.user.email } });
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

