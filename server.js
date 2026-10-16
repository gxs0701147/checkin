const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname, { index: 'index.html' }));

const SB_URL = process.env.SB_URL;
const SB_KEY = process.env.SB_KEY;
const USE_SB = !!(SB_URL && SB_KEY);
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const USE_AI = !!DEEPSEEK_KEY;

const DB_FILE = path.join(__dirname, 'data.json');

const sbH = () => ({
  apikey: SB_KEY,
  Authorization: 'Bearer ' + SB_KEY,
  'Content-Type': 'application/json',
});

async function getRecords() {
  if (USE_SB) {
    const r = await fetch(
      SB_URL + '/rest/v1/records?select=date,note,created_at&order=date.asc',
      { headers: sbH() }
    );
    if (!r.ok) throw new Error('云端读取失败');
    return await r.json();
  }
  if (!fs.existsSync(DB_FILE)) return [];
  const raw = fs.readFileSync(DB_FILE, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed && parsed.records) ? parsed.records : [];
  } catch (e) {
    const backup = DB_FILE + '.broken-' + Date.now();
    try { fs.copyFileSync(DB_FILE, backup); } catch (x) {}
    console.error('data.json 损坏，已备份到 ' + backup);
    throw new Error('本地数据文件损坏');
  }
}

let writeLock = Promise.resolve();

async function addRecord(date, note) {
  if (USE_SB) {
    const r = await fetch(SB_URL + '/rest/v1/records', {
      method: 'POST',
      headers: Object.assign({}, sbH(), { Prefer: 'return=minimal' }),
      body: JSON.stringify({ date: date, note: note }),
    });
    if (r.status === 409) return false;
    if (!r.ok) throw new Error('云端写入失败 ' + r.status);
    return true;
  }
  return await new Promise(function (resolve, reject) {
    writeLock = writeLock.then(async function () {
      try {
        const records = await getRecords();
        if (records.some(function (x) { return x.date === date; })) {
          resolve(false);
          return;
        }
        records.push({ date: date, note: note, created_at: new Date().toISOString() });
        fs.writeFileSync(DB_FILE, JSON.stringify({ records: records }, null, 2));
        resolve(true);
      } catch (e) { reject(e); }
    }).catch(function (e) { console.error('[writeLock]', e); });
  });
}

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}
function todayOf() { return new Date().toISOString().slice(0, 10); }
function shift(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function calcStreak(set, today) {
  let n = 0, cur = today;
  if (!set.has(cur)) cur = shift(cur, -1);
  while (set.has(cur)) { n++; cur = shift(cur, -1); }
  return n;
}
function calcMaxStreak(set) {
  const arr = Array.from(set).sort();
  let max = 0, run = 0, prev = null;
  for (const d of arr) {
    run = (prev && shift(prev, 1) === d) ? run + 1 : 1;
    if (run > max) max = run;
    prev = d;
  }
  return max;
}
function monthView(set, today) {
  const parts = today.split('-').map(Number);
  const y = parts[0], m = parts[1], d = parts[2];
  const total = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const prefix = y + '-' + String(m).padStart(2, '0') + '-';
  const days = [];
  let hit = 0;
  for (let i = 1; i <= total; i++) {
    const key = prefix + String(i).padStart(2, '0');
    const checked = set.has(key);
    if (checked && i <= d) hit++;
    days.push({ day: i, checked: checked, future: i > d });
  }
  return {
    year: y, month: m, days: days,
    rate: d > 0 ? Math.round(hit / d * 100) : 0,
    hit: hit, upto: d, total: total
  };
}

app.get('/api/status', async function (req, res) {
  try {
    const today = isDate(req.query.date) ? req.query.date : todayOf();
    const records = await getRecords();
    const set = new Set(records.map(function (r) { return r.date; }));
    res.json({
      today: today,
      checked: set.has(today),
      streak: calcStreak(set, today),
      maxStreak: calcMaxStreak(set),
      total: set.size,
      totalCount: records.length,
      month: monthView(set, today),
      recent: records.slice(-20).reverse().map(function (r) {
        return { date: r.date, note: r.note || '', time: r.created_at || '' };
      }),
      storage: USE_SB ? 'supabase' : 'file',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/punch', async function (req, res) {
  try {
    const date = isDate(req.body && req.body.date) ? req.body.date : todayOf();
    const raw = String((req.body && req.body.note) || '');
    const note = Array.from(raw).slice(0, 200).join('');
    const ok = await addRecord(date, note);
    const records = await getRecords();
    const set = new Set(records.map(function (r) { return r.date; }));
    res.json({
      ok: ok,
      msg: ok ? '打卡成功' : '今天已经打过啦',
      streak: calcStreak(set, date),
      total: set.size,
    });
  } catch (e) { res.status(500).json({ ok: false, msg: e.message }); }
});

app.post('/api/ai-summary', async function (req, res) {
  try {
    const today = isDate(req.body && req.body.date) ? req.body.date : todayOf();
    const records = await getRecords();
    const set = new Set(records.map(function (r) { return r.date; }));
    const streak = calcStreak(set, today);
    const maxStreak = calcMaxStreak(set);
    const month = monthView(set, today);
    const notes = records.filter(function (r) { return r.note; }).slice(-30)
      .map(function (r) { return r.date + '：' + r.note; }).join('\n');
    const stats = '总打卡 ' + set.size + ' 天，当前连续 ' + streak + ' 天，最长连续 ' + maxStreak + ' 天，本月 ' + month.hit + '/' + month.upto + ' 天（' + month.rate + '%）。';

    if (!USE_AI) {
      return res.json({
        ai: false, reason: 'no-key',
        text: stats + '\n\n最近备注：\n' + (notes || '（暂无）'),
      });
    }
    if (set.size === 0) {
      return res.json({ ai: false, reason: 'no-data', text: '还没有任何打卡记录，先打一次卡再来看看总结吧。' });
    }

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(function () { ctrl.abort(); }, 28000);
      let text;
      try {
        const r = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + DEEPSEEK_KEY,
          },
          body: JSON.stringify({
            model: DEEPSEEK_MODEL,
            messages: [
              { role: 'system', content: '你是一个打卡助手，用中文回复。语气自然、简洁，不客套、不煽情、不列数据清单。基于用户提供的数据写 2-3 句点评，可以指出规律、亮点或温和提醒。直接给点评，不要重复数据。' },
              { role: 'user', content: '数据：' + stats + '\n\n最近备注（倒序）：\n' + (notes || '（无备注）') },
            ],
            temperature: 0.75,
            max_tokens: 220,
          }),
          signal: ctrl.signal,
        });
        if (r.status === 401) throw new Error('API Key 无效');
        if (r.status === 429) throw new Error('请求太频繁');
        if (!r.ok) throw new Error('DeepSeek ' + r.status);
        const data = await r.json();
        text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!text) throw new Error('返回为空');
        text = text.trim();
      } finally { clearTimeout(timer); }
      res.json({ ai: true, text: text });
    } catch (e) {
      const msg = e.name === 'AbortError' ? '响应超时' : e.message;
      res.json({
        ai: false, reason: 'api-error', error: msg,
        text: stats + '\n\n最近备注：\n' + (notes || '（暂无）'),
      });
    }
  } catch (e) {
    res.status(500).json({ ai: false, error: e.message, text: '服务异常' });
  }
});

app.get('/manifest.json', function (req, res) {
  res.type('application/json').send(JSON.stringify({
    name: '每日打卡', short_name: '打卡',
    start_url: '/', scope: '/',
    display: 'standalone', orientation: 'portrait',
    background_color: '#0b0d12', theme_color: '#0b0d12',
    lang: 'zh-CN',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }]
  }));
});
app.get('/icon.svg', function (req, res) {
  res.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#2563eb"/><path d="M148 264l72 72 144-156" stroke="#fff" stroke-width="44" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>');
});

app.use(function (req, res) { res.status(404).json({ error: 'Not Found' }); });
app.use(function (err, req, res, next) {
  console.error('[未捕获错误]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: '服务器内部错误' });
});
process.on('unhandledRejection', function (r) { console.error('[未处理拒绝]', r); });
process.on('uncaughtException', function (e) { console.error('[未捕获异常]', e); });

app.listen(PORT, '0.0.0.0', function () {
  console.log('打卡服务已启动，端口 ' + PORT);
  console.log('存储：' + (USE_SB ? 'Supabase' : '本地文件'));
  console.log('AI：' + (USE_AI ? '已配置' : '未配置'));
});
