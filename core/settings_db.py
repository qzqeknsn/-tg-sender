import json
import os
import config

SETTINGS_FILE = os.path.join(config.BASE_DIR, 'data', 'settings.json')

DEFAULT_SETTINGS = {
    'language': 'ru',
    'theme': 'dark',
    'timezone': 'Europe/Moscow',
    'default_speed': 'medium',
    'two_fa_enabled': True,
    'auto_pause_flood': True,
    'flood_wait_threshold': 15,
    'notifications': {
        'campaign_completed': True,
        'account_error': True,
        'daily_report': False,
        'flood_wait': True,
    },
    'webhook_url': '',
}


def _load_all():
    if not os.path.exists(SETTINGS_FILE):
        return {}
    with open(SETTINGS_FILE, 'r', encoding='utf-8') as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            return {}


def _save_all(data: dict):
    os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
    with open(SETTINGS_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def get_settings(phone: str) -> dict:
    all_data = _load_all()
    user_settings = all_data.get(phone, {})
    merged = dict(DEFAULT_SETTINGS)
    merged.update(user_settings)
    return merged


def update_settings(phone: str, updates: dict) -> dict:
    all_data = _load_all()
    current = all_data.get(phone, {})
    current.update(updates)
    all_data[phone] = current
    _save_all(all_data)
    return get_settings(phone)
