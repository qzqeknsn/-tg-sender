"""
REST API для веб-панели Telegram Sender Pro.
Запуск: ./venv/bin/uvicorn api_server:app --reload --port 8000
"""
import os
from datetime import datetime, timedelta
from typing import List, Optional


from dotenv import load_dotenv
load_dotenv(override=True)
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import FileResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import config
from core.account_manager import (
    add_account,
    assign_proxies_from_file,
    get_account,
    set_active,
    set_proxy,
    _load_accounts,
    _save_accounts,
)
from core.auth_db import (
    init_db,
    add_user,
    get_user,
    update_user,
    list_users,
    delete_user,
    update_last_login,
    save_auth_session,
    get_auth_session,
    increment_attempts,
    delete_auth_session,
)
from core.auth_flow import cancel_auth, confirm_auth, dashboard_confirm_code, dashboard_send_code, start_auth
from core.jwt_utils import create_token, verify_token
from core.settings_db import get_settings as get_user_settings, update_settings as update_user_settings
from core.campaign_runner import (
    create_campaign_record,
    delete_campaign,
    get_api_accounts,
    get_campaign,
    list_campaigns,
    normalize_recipients,
    restart_campaign,
    save_recipients,
    schedule_campaign,
    stop_campaign,
)
from core.health_check import check_all_accounts, check_account
from core.sender import load_recipients

app = FastAPI(title='Telegram Sender Pro API', version='1.0.0')

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

# Инициализация БД при старте
init_db()

security = HTTPBearer(auto_error=False)


async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    # Авторизация отключена временно
    return {'phone': '+77056550632', 'role': 'admin'}


def require_admin(user=Depends(get_current_user)):
    if user['role'] != 'admin':
        raise HTTPException(status_code=403, detail='Только для администратора')
    return user


WEB_DIR = os.path.join(config.BASE_DIR, 'web', 'demo')


# --- Schemas ---

class AccountCreate(BaseModel):
    phone: str
    tier: int = 2
    notes: str = ''


class AccountPatch(BaseModel):
    tier: Optional[int] = None
    notes: Optional[str] = None
    active: Optional[bool] = None
    proxy: Optional[str] = None


class AuthStart(BaseModel):
    phone: str


class AuthConfirm(BaseModel):
    phone: str
    code: str
    password: Optional[str] = None


class LoginStart(BaseModel):
    phone: str


class LoginConfirm(BaseModel):
    phone: str
    code: str
    password: Optional[str] = None


class ProfileUpdate(BaseModel):
    name: Optional[str] = None
    role: Optional[str] = None


class RecipientsUpdate(BaseModel):
    recipients: List[str]


class CampaignStart(BaseModel):
    name: str
    message: str
    recipients: Optional[List[str]] = None
    account_phones: Optional[List[str]] = None
    min_delay: Optional[int] = None
    max_delay: Optional[int] = None


# --- API ---

@app.get('/api/health')
def api_health():
    return {'ok': True, 'api_id_set': config.API_ID != 123456}


@app.get('/api/dashboard')
def dashboard_stats(user=Depends(get_current_user)):
    accounts = get_api_accounts()
    campaigns = list_campaigns()
    active = [c for c in campaigns if c.get('status') == 'active']
    recipients = load_recipients()
    return {
        'accountsTotal': len(accounts),
        'accountsActive': sum(1 for a in accounts if a['sessionActive']),
        'recipientsCount': len(recipients),
        'campaignsTotal': len(campaigns),
        'campaignsActive': len(active),
    }


@app.get('/api/accounts')
def api_list_accounts(user=Depends(get_current_user)):
    return get_api_accounts()


@app.post('/api/accounts')
def api_add_account(body: AccountCreate, user=Depends(get_current_user)):
    add_account(_normalize_phone(body.phone), tier=body.tier, notes=body.notes)
    return get_api_accounts()


@app.patch('/api/accounts/{phone}')
def api_patch_account(phone: str, body: AccountPatch, user=Depends(get_current_user)):
    phone = _normalize_phone(phone)
    accounts = _load_accounts()
    found = False
    for acc in accounts:
        if acc['phone'] == phone:
            if body.tier is not None:
                acc['tier'] = body.tier
            if body.notes is not None:
                acc['notes'] = body.notes
            if body.active is not None:
                acc['active'] = body.active
            if body.proxy is not None:
                acc['proxy'] = body.proxy
            found = True
            break
    if not found:
        raise HTTPException(404, 'Аккаунт не найден')
    _save_accounts(accounts)
    return get_api_accounts()


@app.delete('/api/accounts/{phone}')
def api_delete_account(phone: str, user=Depends(get_current_user)):
    phone = _normalize_phone(phone)
    accounts = _load_accounts()
    accounts = [a for a in accounts if a['phone'] != phone]
    _save_accounts(accounts)
    session = os.path.join(config.SESSIONS_DIR, f'{phone}.session')
    for path in (session, session + '-journal'):
        if os.path.isfile(path):
            os.remove(path)
    return {'ok': True}


def _normalize_phone(raw: str) -> str:
    digits = ''.join(c for c in raw if c.isdigit())
    if len(digits) == 11 and digits[0] in ('7', '8'):
        return '+7' + digits[1:]
    if len(digits) == 10:
        return '+7' + digits
    return '+' + digits if digits else raw


@app.delete('/api/accounts/{phone}/session')
def api_delete_session(phone: str, user=Depends(get_current_user)):
    phone = _normalize_phone(phone)
    session = os.path.join(config.SESSIONS_DIR, f'{phone}.session')
    removed = False
    for path in (session, session + '-journal'):
        if os.path.isfile(path):
            os.remove(path)
            removed = True
    return {'ok': True, 'removed': removed}


@app.post('/api/accounts/auth/send-code')
async def api_auth_send_code(body: AuthStart):
    return await start_auth(_normalize_phone(body.phone))


@app.post('/api/accounts/auth/confirm')
async def api_auth_confirm(body: AuthConfirm):
    return await confirm_auth(_normalize_phone(body.phone), body.code, body.password)


@app.delete('/api/accounts/auth/{phone}')
async def api_auth_cancel(phone: str):
    await cancel_auth(phone)
    return {'ok': True}


@app.post('/api/accounts/health-check')
async def api_health_all(user=Depends(get_current_user)):
    await check_all_accounts()
    return get_api_accounts()


@app.post('/api/accounts/{phone}/health-check')
async def api_health_one(phone: str, user=Depends(get_current_user)):
    await check_account(phone)
    return get_api_accounts()


@app.post('/api/accounts/assign-proxies')
def api_assign_proxies(user=Depends(get_current_user)):
    assign_proxies_from_file()
    return get_api_accounts()


@app.get('/api/recipients')
def api_get_recipients(user=Depends(get_current_user)):
    return {'recipients': load_recipients()}


@app.put('/api/recipients')
def api_put_recipients(body: RecipientsUpdate, user=Depends(get_current_user)):
    save_recipients(body.recipients)
    return {'recipients': normalize_recipients(body.recipients)}


@app.get('/api/campaigns')
def api_list_campaigns(user=Depends(get_current_user)):
    return list_campaigns()


@app.get('/api/campaigns/{campaign_id}')
def api_get_campaign(campaign_id: str, user=Depends(get_current_user)):
    c = get_campaign(campaign_id)
    if not c:
        raise HTTPException(404, 'Кампания не найдена')
    return c


@app.post('/api/campaigns/start')
async def api_start_campaign(body: CampaignStart, bg: BackgroundTasks, user=Depends(get_current_user)):
    try:
        recipients = normalize_recipients(body.recipients or load_recipients())
        camp = create_campaign_record(
            name=body.name,
            message=body.message,
            recipients=recipients,
            min_delay=body.min_delay,
            max_delay=body.max_delay,
            account_phones=body.account_phones,
        )
        save_recipients(recipients)
        bg.add_task(schedule_campaign, camp['id'], body.message, recipients)
        return camp
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete('/api/campaigns/{campaign_id}')
def api_delete_campaign(campaign_id: str, user=Depends(get_current_user)):
    if not delete_campaign(campaign_id):
        raise HTTPException(404, 'Кампания не найдена')
    return {'ok': True}


@app.post('/api/campaigns/{campaign_id}/stop')
def api_stop_campaign(campaign_id: str, user=Depends(get_current_user)):
    if not stop_campaign(campaign_id):
        raise HTTPException(404, 'Кампания не найдена или уже завершена')
    return {'ok': True}


@app.post('/api/campaigns/{campaign_id}/restart')
async def api_restart_campaign(campaign_id: str, bg: BackgroundTasks, user=Depends(get_current_user)):
    campaign = restart_campaign(campaign_id)
    if not campaign:
        raise HTTPException(404, 'Кампания не найдена или не содержит данных')
    recipients = load_recipients()
    if not recipients:
        raise HTTPException(400, 'Список получателей пуст (recipients.txt)')
    message = campaign.get('message', '')
    if not message.strip():
        raise HTTPException(400, 'Текст сообщения пуст')
    bg.add_task(schedule_campaign, campaign_id, message, recipients)
    return get_campaign(campaign_id)


@app.get('/api/campaigns/{campaign_id}/download')
def api_download_campaign(campaign_id: str, request: Request, _format: str = 'csv', token: str = None):
    """Скачать CSV. Авторизация отключена временно."""
    campaign = get_campaign(campaign_id)
    if not campaign:
        raise HTTPException(404, 'Кампания не найдена')

    import csv
    import io

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(['Тип', 'Время', 'Получатель', 'Статус', 'Ошибка'])
    for log in campaign.get('logs', []):
        msg = log.get('message', '')
        parts = msg.split(' — ', 1)
        recipient = parts[0] if ' — ' in msg else ''
        error = parts[1] if ' — ' in msg else msg
        writer.writerow([
            log.get('type', ''),
            log.get('timestamp', ''),
            recipient,
            log.get('type', ''),
            error
        ])

    filename = f"campaign_{campaign_id}.csv"
    return Response(
        output.getvalue(),
        media_type='text/csv',
        headers={'Content-Disposition': f'attachment; filename="{filename}"'}
    )


@app.get('/api/stats')
def api_stats(user=Depends(get_current_user)):
    accounts = get_api_accounts()
    campaigns = list_campaigns()
    now = datetime.utcnow()
    today_prefix = now.strftime('%Y-%m-%d')
    sent_today = 0
    total_delivered = 0
    total_failed = 0
    for c in campaigns:
        created = c.get('createdAt', '')
        is_today = created.startswith(today_prefix) if created else False
        for log in c.get('logs', []):
            if log.get('type') == 'success':
                total_delivered += 1
                if is_today:
                    sent_today += 1
            elif log.get('type') == 'error':
                total_failed += 1
    active_camps = [c for c in campaigns if c.get('status') == 'active']
    return {
        'accounts_count': len(accounts),
        'sent_today': sent_today,
        'sent_today_delta_pct': 0,
        'active_campaigns_count': len(active_camps),
        'active_campaigns_delta': 0,
        'total_delivered': total_delivered,
        'total_failed': total_failed,
        'total_campaigns': len(campaigns),
    }


@app.get('/api/chart/delivery')
def api_chart_delivery(user=Depends(get_current_user)):
    campaigns = list_campaigns()
    hours = {str(h): {'sent': 0, 'delivered': 0} for h in range(24)}
    for c in campaigns:
        for log in c.get('logs', []):
            ts = log.get('timestamp', '')
            try:
                hour = ts.split(':')[0]
                if hour in hours:
                    if log.get('type') == 'success':
                        hours[hour]['delivered'] += 1
                        hours[hour]['sent'] += 1
                    elif log.get('type') == 'info':
                        pass
                    else:
                        hours[hour]['sent'] += 1
            except (IndexError, ValueError):
                pass
    return [{'hour': int(k), 'sent': v['sent'], 'delivered': v['delivered']} for k, v in sorted(hours.items(), key=lambda x: int(x[0]))]


@app.get('/api/logs')
def api_logs(campaign_id: Optional[str] = None, limit: int = 50, user=Depends(get_current_user)):
    campaigns = list_campaigns()
    if campaign_id:
        campaigns = [c for c in campaigns if c['id'] == campaign_id]
    all_logs = []
    for c in campaigns:
        for log in c.get('logs', []):
            all_logs.append({
                'time': log.get('timestamp', ''),
                'username': log.get('message', '').split(' — ')[0] if ' — ' in log.get('message', '') else '',
                'status': log.get('type', ''),
                'error': log.get('message', '').split(' — ')[1] if ' — ' in log.get('message', '') else log.get('message', ''),
                'campaign_id': c['id'],
                'campaign_name': c.get('name', ''),
            })
    all_logs.sort(key=lambda x: x.get('time', ''), reverse=True)
    return all_logs[:limit]


class CampaignCreate(BaseModel):
    name: str
    message: str
    recipients: Optional[List[str]] = None
    account_phones: Optional[List[str]] = None
    min_delay: Optional[int] = None
    max_delay: Optional[int] = None


@app.post('/api/campaigns/create')
async def api_create_campaign(body: CampaignCreate, bg: BackgroundTasks, user=Depends(get_current_user)):
    try:
        recipients = normalize_recipients(body.recipients or load_recipients())
        camp = create_campaign_record(
            name=body.name,
            message=body.message,
            recipients=recipients,
            min_delay=body.min_delay,
            max_delay=body.max_delay,
            account_phones=body.account_phones,
        )
        save_recipients(recipients)
        return camp
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get('/api/config')
def api_config(user=Depends(get_current_user)):
    return {
        'campaignMinDelay': config.CAMPAIGN_MIN_DELAY,
        'campaignMaxDelay': config.CAMPAIGN_MAX_DELAY,
        'enableSpintax': config.ENABLE_SPINTAX,
        'tierLimits': config.TIER_LIMITS,
    }


# --- Auth endpoints (dashboard login) ---

@app.post('/api/auth/send-code')
async def auth_send_code(body: LoginStart):
    """Отправить код в Telegram. Доступно только для разрешённых номеров."""
    phone = body.phone.strip()
    if not phone.startswith('+'):
        phone = '+' + phone
    user = get_user(phone)
    if not user:
        raise HTTPException(status_code=403, detail='Этот номер не имеет доступа к панели')
    result = await dashboard_send_code(phone)
    if result.get('status') == 'error':
        raise HTTPException(status_code=400, detail=result.get('message', 'Ошибка отправки кода'))
    if result.get('status') == 'flood_wait':
        secs = result.get('seconds', 60)
        raise HTTPException(status_code=429, detail=f'Слишком много запросов. Подождите {secs} сек')
    code_hash = result.get('phone_code_hash', '')
    expires_at = (datetime.utcnow() + timedelta(minutes=10)).isoformat()
    save_auth_session(phone, code_hash, expires_at)
    return {'ok': True, 'message': 'Код отправлен в Telegram'}


@app.post('/api/auth/confirm')
async def auth_confirm(body: LoginConfirm):
    """Подтвердить код и получить JWT токен"""
    phone = body.phone.strip()
    if not phone.startswith('+'):
        phone = '+' + phone
    user = get_user(phone)
    if not user:
        raise HTTPException(status_code=403, detail='Доступ запрещён')
    session = get_auth_session(phone)
    if not session:
        raise HTTPException(status_code=400, detail='Сначала запросите код')
    if session['attempts'] >= 5:
        raise HTTPException(status_code=429, detail='Слишком много попыток. Запросите код заново')
    expires = datetime.fromisoformat(session['expires_at'])
    if datetime.utcnow() > expires:
        delete_auth_session(phone)
        raise HTTPException(status_code=400, detail='Код истёк. Запросите новый')
    increment_attempts(phone)
    result = await dashboard_confirm_code(phone, body.code, body.password)
    if result.get('status') == 'error':
        raise HTTPException(status_code=400, detail=result.get('message', 'Ошибка подтверждения'))
    if result.get('status') == 'invalid_code':
        raise HTTPException(status_code=400, detail='Неверный код')
    if result.get('status') == 'need_password':
        return {'ok': False, 'need_password': True, 'message': 'Требуется пароль двухфакторной аутентификации'}
    if result.get('status') == 'flood_wait':
        secs = result.get('seconds', 60)
        raise HTTPException(status_code=429, detail=f'Слишком много запросов. Подождите {secs} сек')
    delete_auth_session(phone)
    update_last_login(phone)
    token = create_token(phone, user['role'])
    return {
        'ok': True,
        'token': token,
        'user': {'phone': phone, 'role': user['role'], 'name': user.get('name', '')},
    }


@app.get('/api/auth/me')
async def auth_me(user=Depends(get_current_user)):
    db_user = get_user(user['phone'])
    return db_user or user


@app.post('/api/auth/logout')
async def auth_logout(user=Depends(get_current_user)):
    return {'ok': True}


@app.put('/api/auth/profile')
async def auth_update_profile(body: ProfileUpdate, user=Depends(get_current_user)):
    """Обновить имя и/или роль текущего пользователя"""
    update_user(user['phone'], name=body.name, role=body.role)
    db_user = get_user(user['phone'])
    return {'ok': True, 'user': db_user}


@app.get('/api/settings')
async def api_get_settings(user=Depends(get_current_user)):
    """Получить настройки пользователя"""
    return get_user_settings(user['phone'])


class SettingsUpdate(BaseModel):
    language: Optional[str] = None
    theme: Optional[str] = None
    timezone: Optional[str] = None
    default_speed: Optional[str] = None
    two_fa_enabled: Optional[bool] = None
    auto_pause_flood: Optional[bool] = None
    flood_wait_threshold: Optional[int] = None
    notifications: Optional[dict] = None
    webhook_url: Optional[str] = None


@app.put('/api/settings')
async def api_update_settings(body: SettingsUpdate, user=Depends(get_current_user)):
    """Обновить настройки пользователя"""
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    return update_user_settings(user['phone'], updates)


# --- User management (admin only) ---

@app.get('/api/users')
def api_list_users(user=Depends(require_admin)):
    return list_users()


@app.post('/api/users')
def api_add_user(body: AccountCreate, user=Depends(require_admin)):
    add_user(body.phone, role=getattr(body, 'notes', 'viewer'), name='')
    return list_users()


@app.delete('/api/users/{phone}')
def api_delete_user(phone: str, user=Depends(require_admin)):
    delete_user(phone)
    return {'ok': True}


# --- Login page ---

@app.get('/login')
def login_page():
    return FileResponse(os.path.join(WEB_DIR, 'login.html'))


# Фронтенд: telegram-mass-sender/web/
if os.path.isdir(WEB_DIR):
    app.mount('/', StaticFiles(directory=WEB_DIR, html=True), name='web')
