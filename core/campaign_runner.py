import asyncio
import json
import os
import uuid
from datetime import datetime, timezone
from typing import List, Optional

import config
from .account_manager import get_active_accounts, _load_accounts
from .auth import _create_client, _proxy_for_phone
from .sender import (
    _distribute_recipients,
    _session_file,
    get_ready_accounts,
    load_recipients,
    send_with_account,
)
from .logger import get_logger

logger = get_logger()


async def _quick_validate_session(phone: str) -> bool:
    """Быстрая проверка: подключается к Telegram и проверяет авторизацию сессии."""
    try:
        proxy = _proxy_for_phone(phone)
        client = await _create_client(phone, proxy=proxy)
        await asyncio.wait_for(client.connect(), timeout=10)
        authorized = await asyncio.wait_for(client.is_user_authorized(), timeout=10)
        await client.disconnect()
        return authorized
    except asyncio.TimeoutError:
        logger.warning('%s: таймаут проверки сессии', phone)
        return False
    except Exception as e:
        logger.warning('%s: ошибка проверки сессии: %s', phone, e)
        return False

CAMPAIGNS_FILE = os.path.join(config.BASE_DIR, 'data', 'campaigns.json')
_running: dict[str, asyncio.Task] = {}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_recipient(raw: str) -> str:
    r = raw.strip()
    if not r or r.startswith('#'):
        return ''
    if r.startswith('@'):
        return r
    if r.replace('-', '').isdigit():
        return r
    return f'@{r}'


def normalize_recipients(items: List[str]) -> List[str]:
    out = []
    for item in items:
        n = normalize_recipient(item)
        if n and n not in out:
            out.append(n)
    return out


def _load_campaigns() -> List[dict]:
    if not os.path.exists(CAMPAIGNS_FILE):
        return []
    with open(CAMPAIGNS_FILE, 'r', encoding='utf-8') as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            return []


def _save_campaigns(items: List[dict]):
    os.makedirs(os.path.dirname(CAMPAIGNS_FILE), exist_ok=True)
    with open(CAMPAIGNS_FILE, 'w', encoding='utf-8') as f:
        json.dump(items, f, ensure_ascii=False, indent=2)


def list_campaigns() -> List[dict]:
    return _load_campaigns()


def get_campaign(campaign_id: str) -> Optional[dict]:
    for c in _load_campaigns():
        if c['id'] == campaign_id:
            return c
    return None


def _update_campaign(campaign_id: str, updater):
    campaigns = _load_campaigns()
    for c in campaigns:
        if c['id'] == campaign_id:
            updater(c)
            _save_campaigns(campaigns)
            return c
    return None


def _add_log(campaign: dict, log_type: str, message: str, account: str = ''):
    campaign['logs'].append({
        'id': str(len(campaign['logs']) + 1),
        'timestamp': datetime.now().strftime('%H:%M:%S'),
        'type': log_type,
        'message': message,
        'account': account,
    })


def campaign_add_log(
    campaign_id: str,
    log_type: str,
    message: str,
    account: str = '',
    count_progress: bool = False,
):
    def upd(c):
        _add_log(c, log_type, message, account)
        if count_progress:
            processed = c.get('recipientsSent', 0) + 1
            c['recipientsSent'] = processed
            total = max(c.get('recipientsTotal', 1), 1)
            c['progress'] = min(99, int(100 * processed / total))

    return _update_campaign(campaign_id, upd)


async def _run_campaign(campaign_id: str, message: str, recipients: List[str]):
    campaigns = _load_campaigns()
    campaign = next((c for c in campaigns if c['id'] == campaign_id), None)
    if not campaign:
        return

    campaign['status'] = 'active'
    campaign['recipientsTotal'] = len(recipients)
    campaign['recipientsSent'] = 0
    campaign['progress'] = 0
    _save_campaigns(campaigns)

    accounts = get_ready_accounts()
    phones_filter = set(campaign.get('accounts') or [])
    if phones_filter:
        accounts = [a for a in accounts if a['phone'] in phones_filter]
    if not accounts:
        campaign_add_log(campaign_id, 'error', 'Нет аккаунтов с .session — авторизуйте в разделе Аккаунты')
        _update_campaign(campaign_id, lambda c: c.update({'status': 'failed', 'progress': 100}))
        return

    validated = []
    for acc in accounts:
        valid = await _quick_validate_session(acc['phone'])
        if valid:
            validated.append(acc)
        else:
            campaign_add_log(
                campaign_id, 'warning',
                f'Пропущен: сессия {acc["phone"]} невалидна — авторизуйте заново',
                acc['phone'],
            )
            logger.warning('%s: сессия невалидна, пропущен в кампании %s', acc['phone'], campaign_id)
    accounts = validated
    if not accounts:
        campaign_add_log(campaign_id, 'error', 'Нет аккаунтов с валидной сессией')
        _update_campaign(campaign_id, lambda c: c.update({'status': 'failed', 'progress': 100}))
        return

    min_d = campaign.get('minDelay', config.CAMPAIGN_MIN_DELAY)
    max_d = campaign.get('maxDelay', config.CAMPAIGN_MAX_DELAY)
    old_min, old_max = config.CAMPAIGN_MIN_DELAY, config.CAMPAIGN_MAX_DELAY
    config.CAMPAIGN_MIN_DELAY = min_d
    config.CAMPAIGN_MAX_DELAY = max_d

    chunks = _distribute_recipients(recipients, len(accounts))
    total_sent = 0
    total_failed = 0

    async def on_event(phone, recipient, event_type, msg):
        log_type = 'success' if event_type == 'ok' else event_type
        campaign_add_log(
            campaign_id,
            log_type,
            f'{recipient} — {msg}',
            phone,
            count_progress=True,
        )

    try:
        tasks = []
        active_pairs = [(acc, ch) for acc, ch in zip(accounts, chunks) if ch]
        for acc, chunk in active_pairs:
            campaign_add_log(
                campaign_id, 'info',
                f'Старт: {len(chunk)} получателей',
                acc['phone'],
            )
            tasks.append(
                send_with_account(
                    acc['phone'],
                    chunk,
                    message,
                    acc.get('tier', 2),
                    on_event=on_event,
                )
            )

        results = await asyncio.gather(*tasks, return_exceptions=True)
        for (acc, chunk), res in zip(active_pairs, results):
            if isinstance(res, Exception):
                total_failed += len(chunk)
                campaign_add_log(campaign_id, 'error', str(res), acc['phone'])
            else:
                s, f = res
                total_sent += s
                total_failed += f

        def finish(c):
            c['recipientsSent'] = total_sent + total_failed
            c['recipientsDelivered'] = total_sent
            c['recipientsFailed'] = total_failed
            c['progress'] = 100
            c['status'] = 'completed'
            c['completedAt'] = _now_iso()
            _add_log(
                c, 'success',
                f'Итого: {total_sent} доставлено, {total_failed} ошибок',
            )

        _update_campaign(campaign_id, finish)
    except Exception as e:
        def fail(c):
            c.update({'status': 'failed', 'progress': 100})
            _add_log(c, 'error', str(e))

        _update_campaign(campaign_id, fail)
    finally:
        config.CAMPAIGN_MIN_DELAY = old_min
        config.CAMPAIGN_MAX_DELAY = old_max
        _running.pop(campaign_id, None)


async def schedule_campaign(campaign_id: str, message: str, recipients: List[str]):
    task = asyncio.create_task(_run_campaign(campaign_id, message, recipients))
    _running[campaign_id] = task
    try:
        await task
    except asyncio.CancelledError:
        pass


def stop_campaign(campaign_id: str) -> bool:
    task = _running.pop(campaign_id, None)
    if task:
        task.cancel()
        _update_campaign(campaign_id, lambda c: c.update({
            'status': 'paused', 'progress': 100,
        }))
        campaigns = _load_campaigns()
        for c in campaigns:
            if c['id'] == campaign_id:
                c['status'] = 'paused'
                c['progress'] = 100
                _add_log(c, 'info', 'Рассылка остановлена пользователем')
                break
        _save_campaigns(campaigns)
        return True
    campaigns = _load_campaigns()
    for c in campaigns:
        if c['id'] == campaign_id and c.get('status') in ('pending',):
            c['status'] = 'paused'
            c['progress'] = 100
            _add_log(c, 'info', 'Рассылка остановлена пользователем')
            _save_campaigns(campaigns)
            return True
    return False


def restart_campaign(campaign_id: str) -> Optional[dict]:
    campaign = get_campaign(campaign_id)
    if not campaign:
        return None
    recipients = load_recipients()
    if not recipients:
        return None
    message = campaign.get('message', '')
    if not message:
        return None
    def reset(c):
        c['status'] = 'pending'
        c['recipientsSent'] = 0
        c['recipientsDelivered'] = 0
        c['recipientsFailed'] = 0
        c['progress'] = 0
        c['logs'] = []
        c.pop('completedAt', None)
    _update_campaign(campaign_id, reset)
    return get_campaign(campaign_id)


def create_campaign_record(
    name: str,
    message: str,
    recipients: Optional[List[str]] = None,
    min_delay: Optional[int] = None,
    max_delay: Optional[int] = None,
    account_phones: Optional[List[str]] = None,
) -> dict:
    recipients = normalize_recipients(recipients or load_recipients())
    if not recipients:
        raise ValueError('Список получателей пуст')

    if not message.strip():
        raise ValueError('Текст сообщения пуст')

    campaign_id = str(uuid.uuid4())[:8]
    accounts = get_active_accounts()
    if account_phones:
        accounts = [a for a in accounts if a['phone'] in account_phones]

    ready = [a['phone'] for a in accounts if os.path.isfile(_session_file(a['phone']))]
    if not ready:
        raise ValueError('Нет аккаунтов с сессией. Аккаунты → Войти')

    campaign = {
        'id': campaign_id,
        'name': name,
        'status': 'pending',
        'recipientsTotal': len(recipients),
        'recipientsSent': 0,
        'recipientsDelivered': 0,
        'recipientsFailed': 0,
        'createdAt': _now_iso(),
        'message': message,
        'accounts': ready,
        'minDelay': min_delay or config.CAMPAIGN_MIN_DELAY,
        'maxDelay': max_delay or config.CAMPAIGN_MAX_DELAY,
        'logs': [],
        'progress': 0,
    }

    items = _load_campaigns()
    items.insert(0, campaign)
    _save_campaigns(items)
    return campaign


def delete_campaign(campaign_id: str) -> bool:
    campaigns = _load_campaigns()
    filtered = [c for c in campaigns if c['id'] != campaign_id]
    if len(filtered) == len(campaigns):
        return False
    _save_campaigns(filtered)
    return True


def save_recipients(recipients: List[str]):
    normalized = normalize_recipients(recipients)
    with open(config.RECIPIENTS_FILE, 'w', encoding='utf-8') as f:
        f.write('\n'.join(normalized) + '\n')


def account_to_api(acc: dict, idx: int) -> dict:
    phone = acc['phone']
    has_session = os.path.isfile(_session_file(phone))
    tier = acc.get('tier', 2)
    limit_max = config.TIER_LIMITS.get(tier, config.TIER_LIMITS[2])['messages_per_day']
    status = 'active' if acc.get('active', True) and has_session else 'waiting'
    if not acc.get('active', True):
        status = 'paused'
    return {
        'id': str(idx + 1),
        'phone': phone,
        'status': status,
        'tier': tier,
        'limitToday': 0,
        'limitMax': limit_max,
        'sessionActive': has_session,
        'proxy': acc.get('proxy', ''),
        'notes': acc.get('notes', ''),
    }


def get_api_accounts() -> List[dict]:
    accounts = _load_accounts()
    return [account_to_api(a, i) for i, a in enumerate(accounts)]
