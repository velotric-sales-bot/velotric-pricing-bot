const FEISHU_APP_ID = process.env.FEISHU_APP_ID || "";
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || "";
const BITABLE_APP_TOKEN = process.env.BITABLE_APP_TOKEN || "JlEubHXWOaqG1psiDGxcv2cFnGc";
const BITABLE_TABLE_ID = process.env.BITABLE_TABLE_ID || "tblowThhfqq3b9gL";
const FEISHU_BASE_URL = "https://open.feishu.cn/open-apis";

let tokenCache = { token: null, expireTime: 0 };

async function getTenantAccessToken() {
  const now = Date.now() / 1000;
  if (tokenCache.token && tokenCache.expireTime > now + 60) {
    return tokenCache.token;
  }
  const res = await fetch(`${FEISHU_BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error("Failed to get tenant token");
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
    const params = new URLSearchParams({
      filter: JSON.stringify({
        conjunction: "and",
        conditions: [{ field_name: "Status", operator: "is", value: ["Active"] }]
      }),
      page_size: "100",
    });
    if (pageToken) params.append("page_token", pageToken);
    const res = await fetch(
      `${FEISHU_BASE_URL}/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${BITABLE_TABLE_ID}/records?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    if (data.code !== 0) break;
    allRecords.push(...(data.data?.items || []));
    if (!data.data?.has_more) break;
    pageToken = data.data.page_token;
  }
  const matched = [];
  for (const record of allRecords) {
    const fields = record.fields || {};
    const keywordsText = String(fields.Keyword || "").toLowerCase();
    const title = String(fields.Title || "").toLowerCase();
    const keywordList = keywordsText.replace(/，/g, ",").split(",").map(k => k.trim().toLowerCase()).filter(k => k);
    keywordList.push(title);
    let isMatch = false;
    for (const kw of keywordList) {
      if (kw && (keywordLower.includes(kw) || kw.includes(keywordLower))) {
        isMatch = true; break;
      }
    }
    if (isMatch) {
      matched.push({
        record_id: record.record_id,
        title: fields.Title || "",
        description: fields.Description || "",
        source: fields.Source || "",
        resource_url: fields["Resource URL"] || "",
      });
    }
  }
  console.log(`Keyword '${keyword}' matched ${matched.length} resources`);
  return matched;
}

async function sendTextMessage(chatId, text) {
  const token = await getTenantAccessToken();
  const res = await fetch(`${FEISHU_BASE_URL}/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) }),
  });
  const data = await res.json();
  return data.code === 0;
}

async function sendPostMessage(chatId, title, description, resourceUrl = "", source = "") {
  const token = await getTenantAccessToken();
  const content = [];
  if (description) content.push([{ tag: "text", text: description }]);
  if (source) content.push([{ tag: "text", text: `\nSource: ${source}` }]);
  if (resourceUrl) content.push([{ tag: "text", text: "\n\n" }, { tag: "a", text: "🔗 Open full document", href: resourceUrl }]);
  const postContent = { zh_cn: { title, content } };
  const res = await fetch(`${FEISHU_BASE_URL}/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ receive_id: chatId, msg_type: "post", content: JSON.stringify(postContent) }),
  });
  const data = await res.json();
  return data.code === 0;
}

async function handleMessage(event) {
  const message = event.message || {};
  const chatId = message.chat_id;
  const msgType = message.message_type;
  const contentStr = message.content || "{}";
  if (!chatId) return;
  if (msgType !== "text") {
    await sendTextMessage(chatId, "👋 Hi! I'm the Velotric Pricing Bot.\n\nType a keyword to search our knowledge base.");
    return;
  }
  let text = "";
  try { text = JSON.parse(contentStr).text?.trim() || ""; } catch { text = contentStr.trim(); }
  text = text.replace(/@_user_\d+/g, "").trim();
  console.log(`Received message from chat ${chatId}: '${text}'`);
  if (!text
