"""StockAlert API: images are processed server-side; browser keys are never accepted."""
from __future__ import annotations

import base64
import json
import mimetypes
import os
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from openai import AsyncOpenAI
from pydantic import AliasChoices, BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from pywebpush import WebPushException, webpush


PROJECT_ROOT = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=PROJECT_ROOT / '.env', extra='ignore')
    openai_api_key: str = Field(default='', validation_alias=AliasChoices('OPENAI_API_KEY', 'OPENAI_KEY'))
    openai_vision_model: str = 'gpt-5-mini'
    supabase_url: str = Field(default='', validation_alias=AliasChoices('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'))
    supabase_anon_key: str = Field(default='', validation_alias=AliasChoices('SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY'))
    supabase_service_role_key: str = Field(default='', validation_alias=AliasChoices('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'))
    frontend_origin: str = 'http://localhost:4200'
    vapid_private_key: str = ''
    vapid_public_key: str = ''
    vapid_subject: str = 'mailto:hello@example.com'


settings = Settings()
app = FastAPI(title='StockAlert API', version='1.0.0')
app.add_middleware(CORSMiddleware, allow_origins=[settings.frontend_origin], allow_credentials=False, allow_methods=['*'], allow_headers=['*'])
scheduler = AsyncIOScheduler(timezone='UTC')


class ProductDraft(BaseModel):
    name: str = Field(min_length=1, max_length=180)
    brand: str | None = Field(default=None, max_length=120)
    expiration_date: date
    confidence: float = Field(ge=0, le=1)
    date_label: str | None = Field(default=None, max_length=120)
    source_image_path: str = Field(min_length=1, max_length=500)


class Subscription(BaseModel):
    endpoint: str
    keys: dict[str, str]


async def require_user(authorization: str = Header(default='')) -> tuple[str, str]:
    if not authorization.startswith('Bearer '):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Inicia sesión para continuar.')
    token = authorization.removeprefix('Bearer ').strip()
    if not settings.supabase_url or not settings.supabase_anon_key:
        raise HTTPException(status_code=503, detail='Supabase no está configurado.')
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.get(f'{settings.supabase_url}/auth/v1/user', headers={'apikey': settings.supabase_anon_key, 'Authorization': f'Bearer {token}'})
    if response.status_code != 200:
        raise HTTPException(status_code=401, detail='Sesión no válida o caducada.')
    return response.json()['id'], token


def user_headers(token: str, prefer: str | None = None) -> dict[str, str]:
    headers = {'apikey': settings.supabase_anon_key, 'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
    if prefer: headers['Prefer'] = prefer
    return headers


async def rest(method: str, resource: str, token: str, *, params: dict[str, str] | None = None, body: Any = None, prefer: str | None = None) -> Any:
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.request(method, f'{settings.supabase_url}/rest/v1/{resource}', headers=user_headers(token, prefer), params=params, json=body)
    if response.status_code >= 400:
        raise HTTPException(status_code=502, detail='No se ha podido guardar la información.')
    return response.json() if response.content else None


async def get_image(image: UploadFile) -> tuple[bytes, str]:
    if image.content_type not in {'image/jpeg', 'image/png', 'image/webp'}:
        raise HTTPException(415, detail='Solo se admiten imágenes JPG, PNG o WebP.')
    content = await image.read()
    if not content or len(content) > 5 * 1024 * 1024:
        raise HTTPException(413, detail='La imagen debe tener entre 1 byte y 5 MB.')
    return content, image.content_type


async def extract_product(content: bytes, content_type: str) -> dict[str, Any]:
    if not settings.openai_api_key:
        raise HTTPException(503, detail='La integración de lectura de imágenes no está configurada.')
    schema = {'type': 'object', 'properties': {'name': {'type': 'string'}, 'brand': {'type': ['string', 'null']}, 'expiration_date': {'type': ['string', 'null'], 'description': 'Fecha ISO YYYY-MM-DD; null si no se lee con certeza.'}, 'confidence': {'type': 'number', 'minimum': 0, 'maximum': 1}, 'date_label': {'type': ['string', 'null']}}, 'required': ['name', 'brand', 'expiration_date', 'confidence', 'date_label'], 'additionalProperties': False}
    data_url = f'data:{content_type};base64,{base64.b64encode(content).decode()}'
    client = AsyncOpenAI(api_key=settings.openai_api_key)
    response = await client.responses.create(model=settings.openai_vision_model, input=[{'role': 'user', 'content': [{'type': 'input_text', 'text': 'Identifica el alimento o producto y su fecha de caducidad. Devuelve la fecha como YYYY-MM-DD. Si la fecha no se ve con certeza, devuelve null; nunca inventes una fecha.'}, {'type': 'input_image', 'image_url': data_url, 'detail': 'high'}]}], text={'format': {'type': 'json_schema', 'name': 'expiry_product', 'strict': True, 'schema': schema}})
    result = json.loads(response.output_text)
    if not result['expiration_date']:
        raise HTTPException(422, detail='No hemos podido leer la fecha con suficiente certeza. Haz otra foto más nítida.')
    try:
        date.fromisoformat(result['expiration_date'])
    except ValueError as exc:
        raise HTTPException(422, detail='La fecha detectada no es válida.') from exc
    if not result['name'].strip():
        raise HTTPException(422, detail='No hemos podido identificar el producto.')
    return result


async def upload_image(owner_id: str, token: str, content: bytes, content_type: str) -> str:
    extension = mimetypes.guess_extension(content_type) or '.jpg'
    path = f'{owner_id}/{uuid.uuid4()}{extension}'
    headers = {'apikey': settings.supabase_anon_key, 'Authorization': f'Bearer {token}', 'Content-Type': content_type, 'x-upsert': 'false'}
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(f'{settings.supabase_url}/storage/v1/object/product-images/{path}', headers=headers, content=content)
    if response.status_code >= 400:
        raise HTTPException(502, detail='No se ha podido guardar la foto de forma segura.')
    return path


@app.get('/health')
async def health() -> dict[str, str]: return {'status': 'ok'}


@app.get('/api/client-config')
async def client_config() -> dict[str, str]:
    """Only return values designed to be public in the browser."""
    return {
        'supabaseUrl': settings.supabase_url,
        'supabasePublishableKey': settings.supabase_anon_key,
        'vapidPublicKey': settings.vapid_public_key,
    }


@app.get('/api/products')
async def list_products(archived: bool = False, identity: tuple[str, str] = Depends(require_user)) -> Any:
    _, token = identity
    state = 'eq.archived' if archived else 'eq.active'
    return await rest('GET', 'products', token, params={'select': 'id,name,brand,expiration_date,confidence,status,created_at', 'status': state, 'order': 'expiration_date.asc'})


@app.post('/api/products/analyze')
async def analyze_product(image: UploadFile = File(...), identity: tuple[str, str] = Depends(require_user)) -> dict[str, Any]:
    owner_id, token = identity
    content, content_type = await get_image(image)
    parsed, path = await extract_product(content, content_type), await upload_image(owner_id, token, content, content_type)
    return {**parsed, 'source_image_path': path}


@app.post('/api/products', status_code=201)
async def create_product(draft: ProductDraft, identity: tuple[str, str] = Depends(require_user)) -> Any:
    owner_id, token = identity
    data = draft.model_dump(mode='json') | {'owner_id': owner_id, 'status': 'active'}
    rows = await rest('POST', 'products', token, body=data, prefer='return=representation')
    return rows[0]


@app.patch('/api/products/{product_id}/consume')
async def consume_product(product_id: uuid.UUID, identity: tuple[str, str] = Depends(require_user)) -> Any:
    _, token = identity
    rows = await rest('PATCH', 'products', token, params={'id': f'eq.{product_id}', 'status': 'eq.active'}, body={'status': 'archived', 'consumed_at': datetime.now(timezone.utc).isoformat()}, prefer='return=representation')
    if not rows: raise HTTPException(404, detail='Producto no encontrado.')
    return rows[0]


@app.post('/api/products/{product_id}/replace')
async def replace_product(product_id: uuid.UUID, image: UploadFile = File(...), identity: tuple[str, str] = Depends(require_user)) -> Any:
    owner_id, token = identity
    original = await rest('GET', 'products', token, params={'id': f'eq.{product_id}', 'status': 'eq.active', 'select': 'id,expiration_date,source_image_path'})
    if not original: raise HTTPException(404, detail='Producto no encontrado.')
    content, content_type = await get_image(image)
    parsed, new_path = await extract_product(content, content_type), await upload_image(owner_id, token, content, content_type)
    await rest('POST', 'product_versions', token, body={'product_id': str(product_id), 'owner_id': owner_id, 'previous_expiration_date': original[0]['expiration_date'], 'previous_image_path': original[0]['source_image_path'], 'replacement_image_path': new_path})
    rows = await rest('PATCH', 'products', token, params={'id': f'eq.{product_id}'}, body={'name': parsed['name'], 'brand': parsed['brand'], 'expiration_date': parsed['expiration_date'], 'confidence': parsed['confidence'], 'date_label': parsed['date_label'], 'source_image_path': new_path}, prefer='return=representation')
    return rows[0]


@app.post('/api/notifications/subscriptions', status_code=201)
async def save_subscription(subscription: Subscription, identity: tuple[str, str] = Depends(require_user)) -> dict[str, bool]:
    owner_id, token = identity
    await rest('POST', 'web_push_subscriptions', token, params={'on_conflict': 'owner_id,endpoint'}, body={'owner_id': owner_id, 'endpoint': subscription.endpoint, 'p256dh': subscription.keys.get('p256dh'), 'auth': subscription.keys.get('auth')}, prefer='resolution=merge-duplicates')
    return {'ok': True}


async def send_expiry_notifications() -> None:
    if not all([settings.supabase_url, settings.supabase_service_role_key, settings.vapid_private_key]): return
    headers = {'apikey': settings.supabase_service_role_key, 'Authorization': f'Bearer {settings.supabase_service_role_key}', 'Content-Type': 'application/json'}
    cutoff = (date.today() + timedelta(days=10)).isoformat()
    async with httpx.AsyncClient(timeout=30) as client:
        products = (await client.get(f'{settings.supabase_url}/rest/v1/products', headers=headers, params={'select': 'id,owner_id,name,expiration_date', 'status': 'eq.active', 'expiration_date': f'lte.{cutoff}'})).json()
        for product in products:
            remaining = (date.fromisoformat(product['expiration_date']) - date.today()).days
            if remaining not in {10, 5, 1, 0}: continue
            exists = (await client.get(f'{settings.supabase_url}/rest/v1/notification_log', headers=headers, params={'select': 'id', 'product_id': f'eq.{product["id"]}', 'milestone_days': f'eq.{remaining}'})).json()
            if exists: continue
            subscriptions = (await client.get(f'{settings.supabase_url}/rest/v1/web_push_subscriptions', headers=headers, params={'select': 'endpoint,p256dh,auth', 'owner_id': f'eq.{product["owner_id"]}'})).json()
            label = 'caduca hoy' if remaining == 0 else f'caduca en {remaining} día' + ('s' if remaining > 1 else '')
            for sub in subscriptions:
                try:
                    webpush(subscription_info={'endpoint': sub['endpoint'], 'keys': {'p256dh': sub['p256dh'], 'auth': sub['auth']}}, data=json.dumps({'title': 'StockAlert', 'body': f"{product['name']} {label}.", 'url': '/'}), vapid_private_key=settings.vapid_private_key, vapid_claims={'sub': settings.vapid_subject})
                except WebPushException:
                    pass
            await client.post(f'{settings.supabase_url}/rest/v1/notification_log', headers={**headers, 'Prefer': 'return=minimal'}, json={'product_id': product['id'], 'owner_id': product['owner_id'], 'milestone_days': remaining})


@app.on_event('startup')
async def start_scheduler() -> None:
    scheduler.add_job(send_expiry_notifications, 'cron', hour=8, minute=0, id='expiry-notifications', replace_existing=True)
    scheduler.start()


@app.on_event('shutdown')
async def stop_scheduler() -> None:
    scheduler.shutdown(wait=False)
