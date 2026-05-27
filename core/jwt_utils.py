import os
from datetime import datetime, timedelta
from jose import JWTError, jwt
from dotenv import load_dotenv
load_dotenv(override=True)
SECRET_KEY = os.getenv('JWT_SECRET', 'change-me-in-production-please')
ALGORITHM = 'HS256'
EXPIRE_HOURS = 24 * 7
def create_token(phone: str, role: str) -> str:
    payload = {
        'sub': phone,
        'role': role,
        'exp': datetime.utcnow() + timedelta(hours=EXPIRE_HOURS),
        'iat': datetime.utcnow(),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)
def verify_token(token: str) -> dict:
    return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])