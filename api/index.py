"""
Velotric Pricing Bot - Feishu IM Bot Backend (Vercel Serverless)
"""

import os
import json
import logging
import time
import re
from typing import List, Dict, Any

import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse
from mangum import Mangum

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

FEISHU_APP_ID = os.getenv("FEISHU_APP_ID", "")
FEISHU_APP_SECRET = os.getenv("FEISHU_APP_SECRET", "")
BITABLE_APP_TOKEN = os.getenv("BITABLE_APP_TOKEN", "JlEubHXWOaqG1psiDGxcv2cFnGc")
BITABLE_TABLE_ID = os.getenv("BITABLE_TABLE_ID", "tblowThhfqq3b9gL")
FEISHU_BASE_URL = "https://open.feishu.cn/open-apis"

app = FastAPI(title="Velotric Pricing Bot")

_token_cache = {"token": None, "expire_time": 0}


def get_tenant_access_token() -> str:
    now = time.time()
    if _token_cache["token"] and _token_cache["expire_time"] > now + 60:
        return _token_cache["token"]
    
    resp = httpx.post(
        f"{FEISHU_BASE_URL}/auth/v3/tenant_access_token/internal",
        json={"app_id": FEISHU_APP_ID, "app_secret": FEISHU_APP_SECRET},
        timeout=10
    )
    data = resp.json()
    if data.get("code") != 0:
        logger.error(f"Failed to get tenant token: {data}")
        raise HTTPException(status_code=500, detail="Failed to get tenant token")
    
    _token_cache["token"] = data["tenant_access_token"]
    _token_cache["expire_time"] = now + data.get("expire", 7200)
    return _token_cache["token"]


def search_bitable_resources(keyword: str) -> List[Dict[str, Any]]:
    token = get_tenant_access_token()
    keyword_lower = keyword.lower().strip()
    
    if not keyword_lower:
        return []
    
    all_records = []
    page_token = None
    
    while True:
        params = {
            "filter": json.dumps({
                "conjunction": "and",
                "conditions": [
                    {"field_name": "Status", "operator": "is", "value": ["Active"]}
                ]
            }),
            "page_size": 100,
        }
        if page_token:
            params["page_token"] = page_token
        
        resp = httpx.get(
            f"{FEISHU_BASE_URL}/bitable/v1/apps/{BITABLE_APP_TOKEN}/tables/{BITABLE_TABLE_ID}/records",
            headers={"Authorization": f"Bearer {token}"},
            params=params,
            timeout=15
        )
        data = resp.json()
        if data.get("code") != 0:
            logger.error(f"Failed to fetch bitable records: {data}")
            break
        
        items = data.get("data", {}).get("items", [])
        all_records.extend(items)
        
        has_more = data.get("data", {}).get("has_more", False)
        page_token = data.get("data", {}).get("page_token")
        if not has_more or not page_token:
            break
    
    matched = []
    for record in all_records:
        fields = record.get("fields", {})
        keywords_text = str(fields.get("Keyword", "")).lower()
        title = str(fields.get("Title", "")).lower()
        
        keyword_list = [k.strip().lower() for k in keywords_text.replace("，", ",").split(",") if k.strip()]
        keyword_list.append(title)
        
        is_match = False
        for kw in keyword_list:
            if kw and (keyword_lower in kw or kw in keyword_lower):
                is_match = True
                break
        
        if is_match:
            matched.append({
                "record_id": record.get("record_id"),
                "title": fields.get("Title", ""),
                "description": fields.get("Description", ""),
                "source": fields.get("Source", ""),
                "resource_url": fields.get("Resource URL", ""),
                "resource_pic": fields.get("Resource Pic", []),
            })
    
    logger.info(f"Keyword '{keyword}' matched {len(matched)} resources")
    return matched


def send_text_message(chat_id: str, text: str) -> bool:
    token = get_tenant_access_token()
    content = json.dumps({"text": text})
    
    resp = httpx.post(
        f"{FEISHU_BASE_URL}/im/v1/messages",
        headers={"Authorization": f"Bearer {token}"},
        params={"receive_id_type": "chat_id"},
        json={
            "receive_id": chat_id,
            "msg_type": "text",
            "content": content,
        },
        timeout=15
    )
    data = resp.json()
    if data.get("code") != 0:
        logger.error(f"Failed to send message: {data}")
        return False
    return True


def send_post_message(chat_id: str, title: str, description: str,
                     resource_url: str = "", source: str = "") -> bool:
    token = get_tenant_access_token()
    
    post_content = {
        "zh_cn": {
            "title": title,
            "content": []
        }
    }
    
    if description:
        post_content["zh_cn"]["content"].append([
            {"tag": "text", "text": description}
        ])
    
    if source:
        post_content["zh_cn"]["content"].append([
            {"tag": "text", "text": f"\nSource: {source}"}
        ])
    
    if resource_url:
        post_content["zh_cn"]["content"].append([
            {"tag": "text", "text": "\n\n"},
            {"tag": "a", "text": "🔗 Open full document", "href": resource_url}
        ])
    
    content = json.dumps(post_content)
    
    resp = httpx.post(
        f"{FEISHU_BASE_URL}/im/v1/messages",
        headers={"Authorization": f"Bearer {token}"},
        params={"receive_id_type": "chat_id"},
        json={
            "receive_id": chat_id,
            "msg_type": "post",
            "content": content,
        },
        timeout=15
    )
    data = resp.json()
    if data.get("code") != 0:
        logger.error(f"Failed to send post message: {data}")
        return False
    return True


def handle_message_sync(event: Dict[str, Any]) -> None:
    message = event.get("message", {})
    chat_id = message.get("chat_id")
    msg_type = message.get("message_type")
    content_str = message.get("content", "{}")
    
    if not chat_id:
        return
    
    if msg_type != "text":
        send_text_message(
            chat_id,
            "👋 Hi! I'm the Velotric Pricing Bot.\n\n"
            "Type a keyword to search our knowledge base.\n"
            "Try: dealer pricing, monthly rebate, summer pallet, shipping policy, warranty..."
        )
        return
    
    try:
        content = json.loads(content_str)
        text = content.get("text", "").strip()
    except json.JSONDecodeError:
        text = content_str.strip()
    
    text = re.sub(r'@_user_\d+', '', text).strip()
    
    logger.info(f"Received message from chat {chat_id}: '{text}'")
    
    if not text:
        send_text_message(
            chat_id,
            "👋 Hi! Type a keyword to search our pricing & promotions knowledge base.\n\n"
            "Try: dealer pricing, monthly rebate, summer pallet, shipping policy, warranty, POSM..."
        )
        return
    
    resources = search_bitable_resources(text)
    
    if not resources:
        hints = "\n".join([
            "  • dealer pricing / price list",
            "  • summer pallet / breeze pallet / discover2",
            "  • monthly rebate / rebate policy",
            "  • warranty / warranty registration",
            "  • shipping policy / shipping cost",
            "  • new dealer / dealer incentive",
            "  • POSM / marketing",
            "
