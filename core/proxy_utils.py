import os
from typing import List, Optional, Tuple
from urllib.parse import urlparse

import socks

import config

# Telethon принимает кортеж PySocks: (type, host, port) или (type, host, port, rdns, user, pass)
ProxyTuple = Tuple


def parse_proxy(proxy_str: str) -> Optional[ProxyTuple]:
    """Парсит socks5://user:pass@host:port или host:port:user:pass."""
    if not proxy_str or not proxy_str.strip():
        return None

    raw = proxy_str.strip()
    if raw.startswith('#'):
        return None

    if '://' not in raw:
        parts = raw.split(':')
        if len(parts) == 2:
            raw = f'socks5://{parts[0]}:{parts[1]}'
        elif len(parts) == 4:
            host, port, user, password = parts
            raw = f'socks5://{user}:{password}@{host}:{port}'

    parsed = urlparse(raw)
    scheme = (parsed.scheme or 'socks5').lower()

    if scheme in ('socks5', 'socks'):
        ptype = socks.SOCKS5
        default_port = 1080
    elif scheme == 'socks4':
        ptype = socks.SOCKS4
        default_port = 1080
    elif scheme in ('http', 'https'):
        ptype = socks.HTTP
        default_port = 8080
    else:
        raise ValueError(f'Неподдерживаемый тип прокси: {scheme}')

    host = parsed.hostname
    if not host:
        raise ValueError(f'Некорректный прокси: {proxy_str}')

    port = parsed.port or default_port
    if parsed.username:
        return (ptype, host, port, True, parsed.username, parsed.password or '')
    return (ptype, host, port)


def load_proxy_list() -> List[str]:
    """Читает прокси из data/proxies.txt (по одному на строку)."""
    if not os.path.exists(config.PROXIES_FILE):
        return []

    proxies = []
    with open(config.PROXIES_FILE, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#'):
                proxies.append(line)
    return proxies
