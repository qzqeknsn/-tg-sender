import os
import sys

# venv/bin/python3 — симлинк на системный Python; сравнивать realpath нельзя.
# Переключаемся, если запущен не интерпретатор из ./venv (sys.prefix).
_ROOT = os.path.dirname(os.path.abspath(__file__))
_VENV_DIR = os.path.join(_ROOT, 'venv')
_VENV_PY = os.path.join(_VENV_DIR, 'bin', 'python3')
if os.path.isfile(_VENV_PY) and os.path.realpath(sys.prefix) != os.path.realpath(_VENV_DIR):
    os.execv(_VENV_PY, [_VENV_PY, *sys.argv])

import asyncio
from colorama import init, Fore, Style
from core import auth
from core.account_manager import (
    add_account,
    list_accounts,
    set_proxy,
    set_active,
    assign_proxies_from_file,
)
from core.health_check import check_all_accounts
from core.sender import send_campaign

init(autoreset=True)


def menu():
    print(f"{Fore.MAGENTA}\n=== Telegram Console Panel ==={Style.RESET_ALL}")
    print("1. Добавить новый аккаунт (.session)")
    print("2. Добавить аккаунт в базу (по телефону)")
    print("3. Список аккаунтов")
    print("4. Проверить все аккаунты")
    print("5. Запустить рассылку")
    print("6. Назначить прокси аккаунту")
    print("7. Распределить прокси из data/proxies.txt")
    print("8. Включить / выключить аккаунт")
    print("0. Выход")


async def add_new_account_flow():
    phone = input("Введите номер телефона в формате +79998887766: ").strip()
    client = await auth.create_new_session(phone)
    if client:
        add_account(phone, tier=2, notes="added via console")
        await client.disconnect()


async def send_campaign_flow():
    print("Текст сообщения (можно использовать спинтакс {привет|здравствуй}):")
    msg = input(">>> ").strip()
    if not msg:
        print(f"{Fore.YELLOW}Пустое сообщение — отмена{Style.RESET_ALL}")
        return
    await send_campaign(msg)


def set_proxy_flow():
    phone = input("Телефон: ").strip()
    print("Формат: socks5://user:pass@host:port или host:port")
    proxy = input("Прокси: ").strip()
    set_proxy(phone, proxy)


def toggle_account_flow():
    phone = input("Телефон: ").strip()
    action = input("Включить? (y/n): ").strip().lower()
    set_active(phone, action in ('y', 'yes', 'д', 'да', '1'))


async def main():
    while True:
        menu()
        choice = input("Выберите действие: ").strip()
        if choice == '1':
            await add_new_account_flow()
        elif choice == '2':
            phone = input("Телефон: ").strip()
            try:
                tier = int(input("Tier (1-3, по умолчанию 2): ") or "2")
            except ValueError:
                tier = 2
            notes = input("Комментарий: ").strip()
            add_account(phone, tier=tier, notes=notes)
        elif choice == '3':
            list_accounts()
        elif choice == '4':
            await check_all_accounts()
        elif choice == '5':
            await send_campaign_flow()
        elif choice == '6':
            set_proxy_flow()
        elif choice == '7':
            assign_proxies_from_file()
        elif choice == '8':
            toggle_account_flow()
        elif choice == '0':
            print("Выход...")
            break
        else:
            print("Неверный пункт меню")


if __name__ == "__main__":
    asyncio.run(main())
