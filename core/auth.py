import random
from typing import Optional

from telethon import TelegramClient
from telethon.errors import (
    SessionPasswordNeededError,
    PhoneCodeInvalidError,
    FloodWaitError,
)
from colorama import Fore, Style

import config
from .account_manager import get_account
from .proxy_utils import parse_proxy
from .logger import get_logger

logger = get_logger()


def _device_params():
    return {
        'device_model': random.choice(config.DEVICE_MODELS),
        'system_version': random.choice(config.SYSTEM_VERSIONS),
        'app_version': random.choice(config.APP_VERSIONS),
        'lang_code': 'ru',
    }


def _proxy_for_phone(phone_number: str) -> Optional[tuple]:
    acc = get_account(phone_number)
    if not acc or not acc.get('proxy'):
        return None
    try:
        return parse_proxy(acc['proxy'])
    except ValueError as e:
        logger.warning('%s: прокси не применён: %s', phone_number, e)
        print(f"{Fore.YELLOW}{phone_number}: прокси пропущен ({e}){Style.RESET_ALL}")
        return None


async def _create_client(phone_number: str, proxy=None) -> TelegramClient:
    session_name = f"{config.SESSIONS_DIR}/{phone_number}"
    kwargs = _device_params()
    if proxy:
        kwargs['proxy'] = proxy

    return TelegramClient(
        session_name,
        config.API_ID,
        config.API_HASH,
        **kwargs,
    )


async def create_new_session(phone_number: str):
    """Первичная авторизация, создаёт .session файл."""
    proxy = _proxy_for_phone(phone_number)
    client = await _create_client(phone_number, proxy=proxy)
    await client.connect()

    if not await client.is_user_authorized():
        print(f"{Fore.YELLOW}Отправка кода на {phone_number}...{Style.RESET_ALL}")
        try:
            await client.send_code_request(phone_number)
            code = input(f"{Fore.CYAN}Введите код из Telegram: {Style.RESET_ALL}")
            try:
                await client.sign_in(phone_number, code)
            except SessionPasswordNeededError:
                pwd = input(f"{Fore.CYAN}Введите пароль 2FA: {Style.RESET_ALL}")
                await client.sign_in(password=pwd)
        except PhoneCodeInvalidError:
            print(f"{Fore.RED}Неверный код!{Style.RESET_ALL}")
            logger.error('%s: неверный код авторизации', phone_number)
            await client.disconnect()
            return None
        except FloodWaitError as e:
            print(f"{Fore.RED}FloodWait {e.seconds} сек{Style.RESET_ALL}")
            logger.error('%s: FloodWait %s сек при авторизации', phone_number, e.seconds)
            await client.disconnect()
            return None

    me = await client.get_me()
    print(f"{Fore.GREEN}Авторизован: {me.first_name} (@{me.username}){Style.RESET_ALL}")
    logger.info('Авторизован %s (@%s)', phone_number, me.username)
    return client


async def load_existing_session(phone_number: str):
    """Загрузка существующей сессии с прокси из accounts.json."""
    proxy = _proxy_for_phone(phone_number)
    client = await _create_client(phone_number, proxy=proxy)
    await client.connect()

    if not await client.is_user_authorized():
        print(f"{Fore.RED}Сессия не авторизована: {phone_number}{Style.RESET_ALL}")
        logger.warning('Сессия не авторизована: %s', phone_number)
        await client.disconnect()
        return None

    return client
