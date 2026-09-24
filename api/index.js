const https = require('https');

const FEISHU_APP_ID = process.env.FEISHU_APP_ID || "cli_aa38f910e4781cd0";
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || "6g9umqeojUYerG8iHBMfcgLy06LzM6Jb";
const BITABLE_APP_TOKEN = process.env.BITABLE_APP_TOKEN || "JlEubHXWOaqG1psiDGxcv2cFnGc";
const BITABLE_TABLE_ID = process.env.BITABLE_TABLE_ID || "tblowThhfqq3b9gL";
const FEISHU_BASE = "open.feishu.cn";

let tokenCache = { token: null, expireTime: 0 };

function feishuRequest(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const options = {
      hostname: FEISHU_BASE,
      path: path,
      method: method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (token) options.headers['Authorization'] = 'Bearer ' + token;
    if (postData) options.headers['Content-Length'] = Buffer.byteLength(postData);
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON: ' + data)); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function getTenantAccessToken() {
  const now = Date.now() / 1000;
  if (tokenCache.token && tokenCache.expireTime > now + 60) return tokenCache.token;
  const data = await feishuRequest('POST', '/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET
  });
  if (data.code !== 0) throw new Error('Failed to get tenant token: ' + JSON.stringify(data));
  tokenCache.token = data.tenant_access_token;
  tokenCache.expireTime = now + (data.expire || 7200);
  return tokenCache.token;
}

async function searchBitableResources(keyword) {
  const token = await getTenantAccessToken();
  const keywordLower = keyword.toLowerCase().trim();
  if (!keywordLower) return [];
  const allRecords = [];
  let pageToken = null;
  while (true) {
    const filter = encodeURIComponent(JSON.stringify({
      conjunction: 'and',
      conditions: [{ field_name: 'Status', operator: 'is', value: ['Active'] }]
    }));
    let path = '/open-apis/bitable/v1/apps/' + BITABLE_APP_TOKEN + '/tables/' + BITABLE_TABLE_ID + '/records?filter=' + filter + '&page_size=100';
    if (pageToken) path += '&page_token=' + encodeURIComponent(pageToken);
    const data = await feishuRequest('GET', path, null, token);
    if (data.code !== 0) break;
    allRecords.push.apply(allRecords, (data.data && data.data.items) || []);
    if (!data.data || !data.data.has_more) break;
    pageToken = data.data.page_token;
  }
  const matched = [];
  for (var i = 0; i < allRecords.length; i++) {
    var record = allRecords[i];
    var fields = record.fields || {};
    var keywordsText = String(fields.Keyword || '').toLowerCase();
    var title = String(fields.Title || '').toLowerCase();
    var keywordList = keywordsText.replace(/，/g, ',').split(',').map(function(k) { return k.trim().toLowerCase(); }).filter(function(k) { return k; });
    keywordList.push(title);
    var isMatch = false;
    for (var j = 0; j < keywordList.length; j++) {
      var kw = keywordList[j];
      if (kw && (keywordLower.indexOf(kw) !== -1 || kw.indexOf(keywordLower) !== -1)) {
        isMatch = true; break;
      }
    }
    if (isMatch) {
      matched.push({
        record_id: record.record_id,
        title: fields.Title || '',
        description: fields.Description || '',
        source: fields.Source || '',
        resource_url: fields['Resource URL'] || '',
      });
    }
  }
  console.log("Keyword '" + keyword + "' matched " + matched.length + " resources");
  return matched;
}

async function sendTextMessage(chatId, text) {
  const token = await getTenantAccessToken();
  const data = await feishuRequest('POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', {
    receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: text })
  }, token);
  return data.code === 0;
}

async function sendPostMessage(chatId, title, description, resourceUrl, source) {
  const token = await getTenantAccessToken();
  var content = [];
  if (description) content.push([{ tag: 'text', text: description }]);
  if (source) content.push([{ tag: 'text', text: '\nSource: ' + source }]);
  if (resourceUrl) content.push([{ tag: 'text', text: '\n\n' }, { tag: 'a', text: '🔗 Open full document', href: resourceUrl }]);
  var postContent = { zh_cn: { title: title, content: content } };
  const data = await feishuRequest('POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', {
    receive_id: chatId, msg_type: 'post', content: JSON.stringify(postContent)
  }, token);
  return data.code === 0;
}

async function handleMessage(event) {
  var message = event.message || {};
  var chatId = message.chat_id;
  var msgType = message.message_type;
  var contentStr = message.content || '{}';
  if (!chatId) return;
  if (msgType !== 'text') {
    await sendTextMessage(chatId, "👋 Hi! I'm the Velotric Pricing Bot.\n\nType a keyword to search our knowledge base.");
    return;
  }
  var text = '';
  try { text = JSON.parse(contentStr).text ? JSON.parse(contentStr).text.trim() : ''; }
  catch (e) { text = contentStr.trim(); }
  text = text.replace(/@_user_\d+/g, '').trim();
  console.log("Received message from chat " + chatId + ": '" + text + "'");
  if (!text) {
    await sendTextMessage(chatId, "👋 Hi! Type a keyword to search our pricing & promotions knowledge base.");
    return;
  }
  var resources = await searchBitableResources(text);
  if (resources.length === 0) {
    var hints = ["dealer pricing", "summer pallet", "monthly rebate", "warranty", "shipping policy", "new dealer", "POSM"];
    var hintText = hints.map(function(h) { return "  • " + h; }).join("\n");
    await sendTextMessage(chatId, '🤔 No matching resource found for "' + text + '".\n\nTry one of these keywords:\n' + hintText);
    return;
  }
  if (resources.length === 1) {
    var r = resources[0];
    await sendPostMessage(chatId, r.title, r.description, r.resource_url, r.source);
  } else {
    var resultText = "📋 Found " + resources.length + " resources:\n\n";
    for (var i = 0; i < resources.length; i++) {
      var r2 = resources[i];
      resultText += (i + 1) + ". " + r2.title;
      if (r2.resource_url) resultText += "\n   " + r2.resource_url;
      resultText += "\n\n";
    }
    await sendTextMessage(chatId, resultText);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
  try {
    var body = req.body || {};
    if (body.challenge) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ challenge: body.challenge }));
      return;
    }
    if (req.method === 'GET' && req.url && req.url.indexOf('/health') !== -1) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', bot: 'Velotric Pricing Bot' }));
      return;
    }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/api')) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ name: 'Velotric Pricing Bot', status: 'running' }));
      return;
    }
    if (req.method === 'POST' && req.url && req.url.indexOf('/webhook') !== -1) {
      var header = body.header || {};
      var eventType = header.event_type || '';
      if (eventType === 'im.message.receive_v1') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ code: 0, msg: 'ok' }));
        handleMessage(body.event || {}).catch(function(err) { console.error('Error:', err); });
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code: 0, msg: 'ok' }));
      return;
    }
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (error) {
    console.error('Handler error:', error);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: error.message }));
  }
};
