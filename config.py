import os
from dotenv import load_dotenv
load_dotenv()
BASE_DIR = os.environ.get('APP_DIR', os.path.dirname(os.path.abspath(__file__)))
API_ID = int(os.getenv('API_ID', '30629347'))
API_HASH = os.getenv('API_HASH', '273241192b028420e4f9b9817e38063d')
SESSIONS_DIR = os.path.join(BASE_DIR, 'data', 'sessions')
ACCOUNTS_JSON = os.path.join(BASE_DIR, 'data', 'accounts.json')
PROXIES_FILE = os.path.join(BASE_DIR, 'data', 'proxies.txt')
RECIPIENTS_FILE = os.path.join(BASE_DIR, 'data', 'recipients.txt')
LOGS_DIR = os.path.join(BASE_DIR, 'logs')
for d in [SESSIONS_DIR, LOGS_DIR, os.path.dirname(ACCOUNTS_JSON)]:
    os.makedirs(d, exist_ok=True)
TIER_LIMITS = {
    1: {'messages_per_day': 10},
    2: {'messages_per_day': 20},
    3: {'messages_per_day': 40},
}
CAMPAIGN_MIN_DELAY = int(os.getenv('CAMPAIGN_MIN_DELAY', '3'))
CAMPAIGN_MAX_DELAY = int(os.getenv('CAMPAIGN_MAX_DELAY', '8'))
DEVICE_MODELS = [
    "Samsung Galaxy S21", "Samsung Galaxy S22",
    "iPhone 13 Pro", "Xiaomi Redmi Note 11",
    "OnePlus 9 Pro", "Google Pixel 6"
]
SYSTEM_VERSIONS = ["Android 12", "Android 13", "iOS 16.1", "iOS 15.6"]
APP_VERSIONS = ["9.3.1", "9.2.2", "9.1.5"]
ENABLE_SPINTAX = True
LOG_LEVEL = 'INFO'
LOG_FORMAT = '%(asctime)s | %(levelname)s | %(message)s'