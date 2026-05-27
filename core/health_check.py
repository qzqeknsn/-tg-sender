from colorama import Fore, Style
from telethon.errors import FloodWaitError
from .auth import load_existing_session
from .account_manager import get_active_accounts
from .logger import get_logger

logger = get_logger()


async def check_account(phone: str):
    client = await load_existing_session(phone)
    if not client:
        print(f"{Fore.RED}{phone}: НЕ АКТИВЕН (нет сессии или не авторизован){Style.RESET_ALL}")
        logger.warning('%s: health check failed — нет сессии', phone)
        return

    try:
        me = await client.get_me()
        await client.send_message('me', 'health_check')
        print(f"{Fore.GREEN}{phone}: ОК ({me.first_name}){Style.RESET_ALL}")
        logger.info('%s: health check OK (%s)', phone, me.first_name)
    except FloodWaitError as e:
        print(f"{Fore.YELLOW}{phone}: FloodWait {e.seconds} сек{Style.RESET_ALL}")
        logger.warning('%s: FloodWait %s сек', phone, e.seconds)
    except Exception as e:
        print(f"{Fore.RED}{phone}: ошибка {e}{Style.RESET_ALL}")
        logger.error('%s: health check error: %s', phone, e)
    finally:
        await client.disconnect()


async def check_all_accounts():
    accounts = get_active_accounts()
    if not accounts:
        print(f"{Fore.YELLOW}Нет активных аккаунтов для проверки{Style.RESET_ALL}")
        return

    for acc in accounts:
        await check_account(acc['phone'])
