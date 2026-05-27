import asyncio
import os
import random
from typing import Awaitable, Callable, List, Optional, Tuple

OnSendEvent = Optional[Callable[[str, str, str, str], Awaitable[None]]]
# (phone, recipient, event_type, message)  event_type: ok | error | warning | info
from colorama import Fore, Style
from telethon.errors import FloodWaitError, UserPrivacyRestrictedError
import config
from .auth import load_existing_session
from .account_manager import get_active_accounts
from .utils import spintax
from .logger import get_logger

logger = get_logger()


def _session_file(phone: str) -> str:
    return os.path.join(config.SESSIONS_DIR, f"{phone}.session")


def _validate_session_file(phone: str) -> bool:
    """Проверить, что .session файл содержит auth-данные (не пустой/битый)."""
    path = _session_file(phone)
    if not os.path.isfile(path):
        return False
    try:
        import sqlite3
        conn = sqlite3.connect(path)
        row = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()
        conn.close()
        return row is not None and row[0] > 0
    except Exception:
        return False


def get_ready_accounts() -> List[dict]:
    """Активные аккаунты, у которых есть валидный файл сессии."""
    ready = []
    for acc in get_active_accounts():
        phone = acc['phone']
        if not os.path.isfile(_session_file(phone)):
            print(
                f"{Fore.YELLOW}{phone}: пропущен — нет .session "
                f"(меню 1: авторизовать аккаунт){Style.RESET_ALL}"
            )
            logger.warning('%s: нет файла сессии', phone)
            continue
        if not _validate_session_file(phone):
            print(
                f"{Fore.YELLOW}{phone}: .session файл повреждён/невалиден — "
                f"авторизуйте заново{Style.RESET_ALL}"
            )
            logger.warning('%s: .session повреждён', phone)
            continue
        ready.append(acc)
    return ready


def load_recipients() -> List[str]:
    try:
        with open(config.RECIPIENTS_FILE, 'r', encoding='utf-8') as f:
            return [
                line.strip()
                for line in f
                if line.strip() and not line.strip().startswith('#')
            ]
    except FileNotFoundError:
        return []


def _distribute_recipients(recipients: List[str], num_accounts: int) -> List[List[str]]:
    """Круговое распределение: получатель i -> аккаунт i % N."""
    chunks: List[List[str]] = [[] for _ in range(num_accounts)]
    for i, recipient in enumerate(recipients):
        chunks[i % num_accounts].append(recipient)
    return chunks


async def send_with_account(
    phone: str,
    recipients: List[str],
    message: str,
    tier: int,
    on_event: OnSendEvent = None,
) -> Tuple[int, int]:
    client = await load_existing_session(phone)
    if not client:
        print(f"{Fore.RED}{phone}: не могу загрузить сессию{Style.RESET_ALL}")
        logger.error('%s: не удалось загрузить сессию', phone)
        if on_event:
            for recipient in recipients:
                await on_event(phone, recipient, 'error', 'не удалось загрузить сессию (проверьте авторизацию аккаунта)')
        return 0, len(recipients)

    limits = config.TIER_LIMITS.get(tier, config.TIER_LIMITS[2])
    max_msgs = limits['messages_per_day']
    sent = 0
    failed = 0
    batch = recipients[:max_msgs]

    total = len(batch)
    try:
        for idx, recipient in enumerate(batch):
            text = spintax(message) if config.ENABLE_SPINTAX else message
            try:
                await client.send_message(recipient, text)
                sent += 1
                if on_event:
                    await on_event(phone, recipient, 'ok', 'доставлено')
                print(
                    f"{Fore.GREEN}{phone} -> {recipient}: OK "
                    f"({idx + 1}/{total}){Style.RESET_ALL}",
                    flush=True,
                )
                logger.info('%s -> %s: OK', phone, recipient)
            except UserPrivacyRestrictedError:
                failed += 1
                if on_event:
                    await on_event(phone, recipient, 'warning', 'privacy restricted')
                print(
                    f"{Fore.YELLOW}{phone} -> {recipient}: privacy restricted "
                    f"({idx + 1}/{total}){Style.RESET_ALL}",
                    flush=True,
                )
                logger.warning('%s -> %s: privacy restricted', phone, recipient)
            except FloodWaitError as e:
                if on_event:
                    await on_event(phone, recipient, 'error', f'FloodWait {e.seconds} сек')
                print(
                    f"{Fore.RED}{phone}: FloodWait {e.seconds} сек, остановка{Style.RESET_ALL}",
                    flush=True,
                )
                logger.error('%s: FloodWait %s сек', phone, e.seconds)
                break
            except Exception as e:
                failed += 1
                if on_event:
                    await on_event(phone, recipient, 'error', str(e))
                print(
                    f"{Fore.RED}{phone} -> {recipient}: ошибка {e} "
                    f"({idx + 1}/{total}){Style.RESET_ALL}",
                    flush=True,
                )
                logger.error('%s -> %s: %s', phone, recipient, e)

            if idx < total - 1:
                delay = random.uniform(
                    config.CAMPAIGN_MIN_DELAY,
                    config.CAMPAIGN_MAX_DELAY,
                )
                print(
                    f"{Fore.CYAN}{phone}: пауза {delay:.0f} сек "
                    f"перед следующим ({idx + 2}/{total})...{Style.RESET_ALL}",
                    flush=True,
                )
                await asyncio.sleep(delay)
    finally:
        await client.disconnect()

    return sent, failed


async def send_campaign(message: str):
    recipients = load_recipients()
    if not recipients:
        print(f"{Fore.YELLOW}Список получателей пуст (data/recipients.txt){Style.RESET_ALL}")
        return

    accounts = get_ready_accounts()
    if not accounts:
        print(
            f"{Fore.YELLOW}Нет аккаунтов с сессией. "
            f"Пункт меню 1 — авторизовать каждый номер{Style.RESET_ALL}"
        )
        return

    chunks = _distribute_recipients(recipients, len(accounts))
    tasks = []

    logger.info(
        'Старт рассылки: %s получателей, %s аккаунтов (параллельно)',
        len(recipients),
        len(accounts),
    )

    for acc, acc_recipients in zip(accounts, chunks):
        if not acc_recipients:
            continue
        print(
            f"{Fore.CYAN}Аккаунт {acc['phone']} отправит "
            f"{len(acc_recipients)}: {', '.join(acc_recipients)}{Style.RESET_ALL}"
        )
        tasks.append(
            send_with_account(
                acc['phone'],
                acc_recipients,
                message,
                acc.get('tier', 2),
            )
        )

    results = await asyncio.gather(*tasks)
    total_sent = sum(r[0] for r in results)
    total_failed = sum(r[1] for r in results)

    print(f"{Fore.GREEN}ИТОГО: отправлено {total_sent}, ошибок {total_failed}{Style.RESET_ALL}")
    logger.info('Рассылка завершена: sent=%s failed=%s', total_sent, total_failed)
