"""Авторизация через API (без input в консоли)."""
import asyncio
from typing import Dict, Optional

from telethon.errors import (
    FloodWaitError,
    PhoneCodeInvalidError,
    SessionPasswordNeededError,
)

import config
from .account_manager import add_account
from .auth import _create_client, _proxy_for_phone
from .logger import get_logger

logger = get_logger()

# phone -> {client, phone_code_hash}
_pending: Dict[str, dict] = {}


async def start_auth(phone: str) -> dict:
    # Если код уже был отправлен и не подтверждён — возвращаем статус
    existing = _pending.get(phone)
    if existing:
        return {'status': 'code_sent', 'phone': phone, 'hash': existing.get('phone_code_hash', '')[:8], 'reused': True}

    # Отменяем старые висящие соединения
    cancel = _pending.pop(phone, None)
    if cancel:
        try:
            await cancel['client'].disconnect()
        except Exception:
            pass

    try:
        proxy = _proxy_for_phone(phone)
        client = await _create_client(phone, proxy=proxy)
        await asyncio.wait_for(client.connect(), timeout=15)
    except asyncio.TimeoutError:
        return {'status': 'error', 'message': 'Таймаут подключения к Telegram'}
    except Exception as e:
        return {'status': 'error', 'message': f'Ошибка подключения: {e}'}

    try:
        auth = await asyncio.wait_for(client.is_user_authorized(), timeout=10)
    except asyncio.TimeoutError:
        await client.disconnect()
        return {'status': 'error', 'message': 'Таймаут проверки авторизации'}
    except Exception as e:
        await client.disconnect()
        return {'status': 'error', 'message': str(e)}

    if auth:
        me = await client.get_me()
        await client.disconnect()
        return {
            'status': 'already_authorized',
            'phone': phone,
            'username': me.username,
            'first_name': me.first_name,
        }

    try:
        sent = await asyncio.wait_for(client.send_code_request(phone), timeout=20)
        _pending[phone] = {
            'client': client,
            'phone_code_hash': sent.phone_code_hash,
        }
        sent_type = str(getattr(sent, 'type', 'unknown'))
        sent_timeout = getattr(sent, 'timeout', 0)
        logger.info('Auth code sent to %s (hash=%s, type=%s, timeout=%s)', phone, sent.phone_code_hash[:8], sent_type, sent_timeout)
        return {
            'status': 'code_sent',
            'phone': phone,
            'hash': sent.phone_code_hash[:8],
            'type': sent_type,
            'timeout': sent_timeout,
        }
    except asyncio.TimeoutError:
        await client.disconnect()
        return {'status': 'error', 'message': 'Таймаут отправки кода'}
    except FloodWaitError as e:
        await client.disconnect()
        return {'status': 'flood_wait', 'seconds': e.seconds}
    except Exception as e:
        await client.disconnect()
        return {'status': 'error', 'message': str(e)}


async def confirm_auth(phone: str, code: str, password: Optional[str] = None) -> dict:
    entry = _pending.get(phone)
    if not entry:
        return {'status': 'error', 'message': 'Сначала запросите код (send-code)'}

    client = entry['client']
    try:
        try:
            await client.sign_in(phone, code)
        except SessionPasswordNeededError:
            if not password:
                return {'status': 'need_password', 'phone': phone}
            await client.sign_in(password=password)
    except PhoneCodeInvalidError:
        return {'status': 'invalid_code'}
    except FloodWaitError as e:
        return {'status': 'flood_wait', 'seconds': e.seconds}
    except Exception as e:
        await client.disconnect()
        _pending.pop(phone, None)
        return {'status': 'error', 'message': str(e)}

    me = await client.get_me()
    await client.disconnect()
    _pending.pop(phone, None)
    add_account(phone, tier=2, notes='added via web')
    logger.info('Web auth OK: %s (@%s)', phone, me.username)
    return {
        'status': 'ok',
        'phone': phone,
        'username': me.username,
        'first_name': me.first_name,
    }


async def dashboard_send_code(phone: str) -> dict:
    """Отправить код подтверждения для входа в дашборд.
    Использует временную сессию, не конфликтует с существующей."""
    existing = _pending.pop(phone, None)
    if existing:
        try:
            await existing['client'].disconnect()
        except Exception:
            pass

    try:
        proxy = _proxy_for_phone(phone)
        from telethon import TelegramClient
        import config as cfg
        from .auth import _device_params
        client = TelegramClient(
            f'{cfg.SESSIONS_DIR}/_login_{phone.replace("+","")}',
            cfg.API_ID,
            cfg.API_HASH,
            **_device_params(),
        )
        if proxy:
            client.set_proxy(proxy)
        await asyncio.wait_for(client.connect(), timeout=15)
    except asyncio.TimeoutError:
        return {'status': 'error', 'message': 'Таймаут подключения к Telegram'}
    except Exception as e:
        return {'status': 'error', 'message': f'Ошибка подключения: {e}'}

    try:
        sent = await asyncio.wait_for(client.send_code_request(phone), timeout=20)
        _pending[phone] = {
            'client': client,
            'phone_code_hash': sent.phone_code_hash,
        }
        sent_type = str(getattr(sent, 'type', 'unknown'))
        sent_timeout = getattr(sent, 'timeout', 0)
        return {
            'status': 'code_sent',
            'phone': phone,
            'hash': sent.phone_code_hash[:8],
            'type': sent_type,
            'timeout': sent_timeout,
        }
    except asyncio.TimeoutError:
        await client.disconnect()
        return {'status': 'error', 'message': 'Таймаут отправки кода'}
    except FloodWaitError as e:
        await client.disconnect()
        return {'status': 'flood_wait', 'seconds': e.seconds}
    except Exception as e:
        await client.disconnect()
        return {'status': 'error', 'message': str(e)}


async def dashboard_confirm_code(phone: str, code: str, password: Optional[str] = None) -> dict:
    """Подтвердить код для входа в дашборд.
    В отличие от confirm_auth — НЕ добавляет телефон как аккаунт для рассылок."""
    entry = _pending.get(phone)
    if not entry:
        return {'status': 'error', 'message': 'Сначала запросите код (send-code)'}

    client = entry['client']
    try:
        try:
            await client.sign_in(phone, code)
        except SessionPasswordNeededError:
            if not password:
                return {'status': 'need_password', 'phone': phone}
            await client.sign_in(password=password)
    except PhoneCodeInvalidError:
        return {'status': 'invalid_code'}
    except FloodWaitError as e:
        return {'status': 'flood_wait', 'seconds': e.seconds}
    except Exception as e:
        await client.disconnect()
        _pending.pop(phone, None)
        return {'status': 'error', 'message': str(e)}

    me = await client.get_me()
    await client.disconnect()
    _pending.pop(phone, None)
    # Удаляем временный session файл
    import os
    session_path = client.session.filename
    if session_path:
        for p in (session_path, session_path + '-journal'):
            if os.path.isfile(p):
                os.remove(p)
    logger.info('Dashboard login OK: %s (@%s)', phone, me.username)
    return {
        'status': 'ok',
        'phone': phone,
        'username': me.username,
        'first_name': me.first_name,
    }


async def cancel_auth(phone: str):
    entry = _pending.pop(phone, None)
    if entry:
        await entry['client'].disconnect()
