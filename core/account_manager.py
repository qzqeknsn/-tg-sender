import json
import os
from typing import List, Dict, Optional
from colorama import Fore, Style
import config
from .proxy_utils import load_proxy_list
from .logger import get_logger

logger = get_logger()


def _load_accounts() -> List[Dict]:
    if not os.path.exists(config.ACCOUNTS_JSON):
        return []
    with open(config.ACCOUNTS_JSON, 'r', encoding='utf-8') as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            return []


def _save_accounts(accounts: List[Dict]):
    with open(config.ACCOUNTS_JSON, 'w', encoding='utf-8') as f:
        json.dump(accounts, f, ensure_ascii=False, indent=2)


def get_account(phone: str) -> Optional[Dict]:
    for acc in _load_accounts():
        if acc['phone'] == phone:
            return acc
    return None


def add_account(phone: str, tier: int = 2, notes: str = ""):
    accounts = _load_accounts()
    for acc in accounts:
        if acc['phone'] == phone:
            print(f"{Fore.YELLOW}Аккаунт уже есть в базе{Style.RESET_ALL}")
            return

    acc = {
        "phone": phone,
        "tier": tier,
        "notes": notes,
        "proxy": "",
        "active": True
    }
    accounts.append(acc)
    _save_accounts(accounts)
    print(f"{Fore.GREEN}Аккаунт добавлен в базу: {phone}{Style.RESET_ALL}")
    logger.info('Добавлен аккаунт %s (tier %s)', phone, tier)


def list_accounts():
    from tabulate import tabulate
    accounts = _load_accounts()
    if not accounts:
        print(f"{Fore.YELLOW}Нет аккаунтов в базе{Style.RESET_ALL}")
        return

    table = []
    for acc in accounts:
        table.append([
            acc['phone'],
            acc.get('tier', 2),
            'ON' if acc.get('active', True) else 'OFF',
            acc.get('proxy', '') or '—',
            acc.get('notes', '')
        ])
    print(tabulate(
        table,
        headers=['Phone', 'Tier', 'Active', 'Proxy', 'Notes'],
        tablefmt='grid'
    ))


def get_active_accounts() -> List[Dict]:
    accounts = _load_accounts()
    return [a for a in accounts if a.get('active', True)]


def set_proxy(phone: str, proxy_str: str):
    accounts = _load_accounts()
    found = False
    for acc in accounts:
        if acc['phone'] == phone:
            acc['proxy'] = proxy_str.strip()
            found = True
            break
    if found:
        _save_accounts(accounts)
        print(f"{Fore.GREEN}Прокси обновлен для {phone}{Style.RESET_ALL}")
        logger.info('Прокси для %s: %s', phone, proxy_str)
    else:
        print(f"{Fore.RED}Аккаунт не найден: {phone}{Style.RESET_ALL}")


def set_active(phone: str, active: bool):
    accounts = _load_accounts()
    found = False
    for acc in accounts:
        if acc['phone'] == phone:
            acc['active'] = active
            found = True
            break
    if found:
        _save_accounts(accounts)
        state = 'включён' if active else 'выключен'
        print(f"{Fore.GREEN}Аккаунт {phone} {state}{Style.RESET_ALL}")
        logger.info('Аккаунт %s %s', phone, state)
    else:
        print(f"{Fore.RED}Аккаунт не найден: {phone}{Style.RESET_ALL}")


def assign_proxies_from_file():
    """Назначает прокси из proxies.txt аккаунтам без прокси (по порядку)."""
    proxies = load_proxy_list()
    if not proxies:
        print(f"{Fore.YELLOW}Файл proxies.txt пуст или не найден{Style.RESET_ALL}")
        return

    accounts = _load_accounts()
    if not accounts:
        print(f"{Fore.YELLOW}Нет аккаунтов в базе{Style.RESET_ALL}")
        return

    assigned = 0
    proxy_idx = 0
    for acc in accounts:
        if acc.get('proxy'):
            continue
        if proxy_idx >= len(proxies):
            break
        acc['proxy'] = proxies[proxy_idx]
        proxy_idx += 1
        assigned += 1

    if assigned:
        _save_accounts(accounts)
        print(f"{Fore.GREEN}Назначено прокси: {assigned}{Style.RESET_ALL}")
        logger.info('Назначено прокси из файла: %s', assigned)
    else:
        print(f"{Fore.YELLOW}Нет аккаунтов без прокси или закончились строки в proxies.txt{Style.RESET_ALL}")
