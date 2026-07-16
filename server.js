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
  return { users: {}, sessions: {}, rooms: {}, trades: {}, showcases: {}, board: {} };
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
  return { uid:user.uid, loginId:user.loginId || user.email || '', nickname:user.nickname || '', profileCountryId:user.profileCountryId || '', title:user.title || '' };
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
      const { nickname, profileCountryId } = await readBody(req);
      const clean = String(nickname ?? current.user.nickname ?? '').trim();
      if(clean.length < 2 || clean.length > 16) return json(res, 400, { error: '닉네임은 2~16자로 입력하세요' });
      if(Object.values(db.users).some(u=>u.uid !== current.uid && String(u.nickname || '').toLowerCase() === clean.toLowerCase())) return json(res, 409, { error: '이미 사용 중인 닉네임입니다' });
      const profileId=String(profileCountryId ?? current.user.profileCountryId ?? '').trim();
      if(profileId && !(current.user.state?.discovered || []).includes(profileId)) return json(res, 400, { error:'발견한 국가의 국기만 프로필로 사용할 수 있습니다' });
      current.user.nickname = clean;
      current.user.profileCountryId = profileId;
      current.user.updatedAt = Date.now();
      writeDb(db);
      return json(res, 200, { user: publicUser(current.user) });
    }

    if(req.method === 'POST' && url.pathname === '/api/profile/recovery-code'){
      const current=getUser(req,db);
      if(!current) return json(res,401,{error:'로그인이 필요합니다'});
      const code=randomBytes(6).toString('hex').toUpperCase();
      current.user.recoveryHash=createHash('sha256').update(code).digest('hex');
      current.user.updatedAt=Date.now();writeDb(db);
      return json(res,200,{recoveryCode:code});
    }

    if(req.method === 'POST' && url.pathname === '/api/password/reset'){
      const { loginId, recoveryCode, newPassword }=await readBody(req);
      const cleanId=String(loginId||'').trim().toLowerCase();
      const user=Object.values(db.users).find(u=>String(u.loginId||u.email||'').toLowerCase()===cleanId);
      const recoveryHash=createHash('sha256').update(String(recoveryCode||'').trim().toUpperCase()).digest('hex');
      if(!user || !user.recoveryHash || !safeEqual(recoveryHash,user.recoveryHash)) return json(res,401,{error:'아이디 또는 복구 코드가 올바르지 않습니다'});
      if(String(newPassword||'').length<4) return json(res,400,{error:'새 비밀번호는 4자 이상이어야 합니다'});
      user.pass=hashPassword(newPassword);user.recoveryHash='';user.updatedAt=Date.now();
      Object.entries(db.sessions).forEach(([token,uid])=>{if(uid===user.uid)delete db.sessions[token]});
      writeDb(db);return json(res,200,{ok:true});
    }

    if(req.method === 'POST' && url.pathname === '/api/profile/title-coupon'){
      const current=getUser(req,db);
      if(!current) return json(res,401,{error:'로그인이 필요합니다'});
      const { code }=await readBody(req),adminCode=String(process.env.ADMIN_TITLE_CODE || 'ADMIN1337').toUpperCase();
      if(String(code||'').trim().toUpperCase()!==adminCode) return json(res,400,{error:'유효하지 않은 칭호 쿠폰입니다'});
      current.user.title='어드민';current.user.updatedAt=Date.now();writeDb(db);
      return json(res,200,{user:publicUser(current.user)});
    }
    if(req.method === 'GET' && url.pathname === '/api/ranking'){
      const ranking = Object.values(db.users).filter(user=>user.nickname).map(user=>({ ...rankFor(user), nickname:user.nickname, profileCountryId:user.profileCountryId || '', title:user.title || '' }))
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

    if(req.method === 'GET' && url.pathname === '/api/board'){
      const posts = Object.values(db.board).sort((a,b)=>b.createdAt-a.createdAt).slice(0,100).map(post=>({
        ...post,
        authorName:db.users[post.authorUid]?.nickname || '탈퇴한 이용자', authorTitle:db.users[post.authorUid]?.title || '', authorProfileCountryId:db.users[post.authorUid]?.profileCountryId || '',
        comments:(post.comments || []).map(comment=>({ ...comment, authorName:db.users[comment.authorUid]?.nickname || '탈퇴한 이용자', authorTitle:db.users[comment.authorUid]?.title || '', authorProfileCountryId:db.users[comment.authorUid]?.profileCountryId || '' }))
      }));
      return json(res, 200, { posts });
    }

    if(req.method === 'POST' && url.pathname === '/api/board'){
      const current = getUser(req, db);
      if(!current || !current.user.nickname) return json(res, 401, { error:'로그인과 닉네임이 필요합니다' });
      const { title, body } = await readBody(req);
      const cleanTitle=String(title||'').trim().slice(0,40), cleanBody=String(body||'').trim().slice(0,500);
      if(cleanTitle.length<2 || cleanBody.length<2) return json(res, 400, { error:'제목과 내용을 2자 이상 입력하세요' });
      const id=randomBytes(8).toString('hex');
      db.board[id]={ id, authorUid:current.uid, title:cleanTitle, body:cleanBody, createdAt:Date.now(), comments:[] };
      const overflow=Object.values(db.board).sort((a,b)=>b.createdAt-a.createdAt).slice(200);
      overflow.forEach(post=>delete db.board[post.id]);
      writeDb(db); return json(res, 200, { ok:true, id });
    }

    if(req.method === 'POST' && /^\/api\/board\/[^/]+\/comments$/.test(url.pathname)){
      const current=getUser(req,db);
      if(!current || !current.user.nickname) return json(res,401,{error:'로그인과 닉네임이 필요합니다'});
      const id=url.pathname.split('/')[3],post=db.board[id];
      if(!post) return json(res,404,{error:'게시글을 찾을 수 없습니다'});
      const { body }=await readBody(req),clean=String(body||'').trim().slice(0,200);
      if(clean.length<1) return json(res,400,{error:'댓글을 입력하세요'});
      post.comments=post.comments||[];
      post.comments.push({id:randomBytes(6).toString('hex'),authorUid:current.uid,body:clean,createdAt:Date.now()});
      if(post.comments.length>50) post.comments=post.comments.slice(-50);
      writeDb(db);return json(res,200,{ok:true});
    }

    if(req.method === 'POST' && /^\/api\/board\/[^/]+\/delete$/.test(url.pathname)){
      const current=getUser(req,db);
      if(!current) return json(res,401,{error:'로그인이 필요합니다'});
      const id=url.pathname.split('/')[3],post=db.board[id];
      if(!post || post.authorUid!==current.uid) return json(res,403,{error:'내 게시글만 삭제할 수 있습니다'});
      delete db.board[id];writeDb(db);return json(res,200,{ok:true});
    }
    if(req.method === 'GET' && url.pathname === '/api/community'){
      const trades = Object.values(db.trades).map(trade=>({ ...trade, ownerName:db.users[trade.ownerUid]?.nickname || '이름 없음', ownerTitle:db.users[trade.ownerUid]?.title || '', ownerProfileCountryId:db.users[trade.ownerUid]?.profileCountryId || '' })).sort((a,b)=>b.createdAt-a.createdAt);
      const showcases = Object.values(db.showcases).map(show=>({ ...show, nickname:db.users[show.uid]?.nickname || '이름 없음', title:db.users[show.uid]?.title || '', profileCountryId:db.users[show.uid]?.profileCountryId || '' })).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,50);
      return json(res, 200, { trades, showcases });
    }

    if(req.method === 'POST' && url.pathname === '/api/trades'){
      const current = getUser(req, db);
      if(!current || !current.user.nickname) return json(res, 401, { error:'로그인과 닉네임이 필요합니다' });
      const { offerId, wantId, skin } = await readBody(req);
      if(!offerId || !wantId || offerId === wantId) return json(res, 400, { error:'서로 다른 제시 카드와 희망 카드를 선택하세요' });
      const inventory = current.user.state?.inventory || {};
      if((Number(inventory[offerId]) || 0) < 1) return json(res, 400, { error:'제시할 카드를 보유하고 있지 않습니다' });
      inventory[offerId] -= 1;
      if(inventory[offerId] <= 0) delete inventory[offerId];
      const id = randomBytes(8).toString('hex');
      db.trades[id] = { id, ownerUid:current.uid, offerId, wantId, skin:String(skin || 'default'), createdAt:Date.now() };
      current.user.updatedAt = Date.now();
      writeDb(db);
      return json(res, 200, { trade:db.trades[id], state:current.user.state });
    }

    if(req.method === 'POST' && /^\/api\/trades\/[^/]+\/accept$/.test(url.pathname)){
      const current = getUser(req, db);
      if(!current) return json(res, 401, { error:'로그인이 필요합니다' });
      const id = url.pathname.split('/')[3], trade = db.trades[id], owner = trade && db.users[trade.ownerUid];
      if(!trade || !owner) return json(res, 404, { error:'교환 글을 찾을 수 없습니다' });
      if(trade.ownerUid === current.uid) return json(res, 400, { error:'내 교환은 수락할 수 없습니다' });
      const mine = current.user.state?.inventory || {}, theirs = owner.state?.inventory || {};
      if((Number(mine[trade.wantId]) || 0) < 1) return json(res, 400, { error:'상대가 원하는 카드가 없습니다' });
      mine[trade.wantId] -= 1; if(mine[trade.wantId] <= 0) delete mine[trade.wantId];
      mine[trade.offerId] = (Number(mine[trade.offerId]) || 0) + 1;
      theirs[trade.wantId] = (Number(theirs[trade.wantId]) || 0) + 1;
      for(const [user,countryId] of [[current.user,trade.offerId],[owner,trade.wantId]]){
        if(!Array.isArray(user.state.discovered)) user.state.discovered=[];
        if(!user.state.discovered.includes(countryId)) user.state.discovered.push(countryId);
        user.updatedAt=Date.now();
      }
      delete db.trades[id]; writeDb(db);
      return json(res, 200, { state:current.user.state });
    }

    if(req.method === 'POST' && /^\/api\/trades\/[^/]+\/cancel$/.test(url.pathname)){
      const current = getUser(req, db);
      if(!current) return json(res, 401, { error:'로그인이 필요합니다' });
      const id=url.pathname.split('/')[3], trade=db.trades[id];
      if(!trade || trade.ownerUid !== current.uid) return json(res, 404, { error:'취소할 교환 글이 없습니다' });
      const inventory=current.user.state?.inventory || {};
      inventory[trade.offerId]=(Number(inventory[trade.offerId])||0)+1;
      delete db.trades[id]; current.user.updatedAt=Date.now(); writeDb(db);
      return json(res, 200, { state:current.user.state });
    }

    if(req.method === 'POST' && url.pathname === '/api/showcase'){
      const current = getUser(req, db);
      if(!current || !current.user.nickname) return json(res, 401, { error:'로그인과 닉네임이 필요합니다' });
      const { countryId, skin } = await readBody(req);
      if(!countryId || !(current.user.state?.discovered || []).includes(countryId)) return json(res, 400, { error:'발견한 카드만 자랑할 수 있습니다' });
      db.showcases[current.uid]={ uid:current.uid, countryId, skin:String(skin||'default'), updatedAt:Date.now() };
      writeDb(db); return json(res, 200, { showcase:db.showcases[current.uid] });
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
    '.svg': 'image/svg+xml',
    '.xml': 'application/xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8'
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

