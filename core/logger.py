import logging
import os
from logging.handlers import RotatingFileHandler

import config

_logger: logging.Logger | None = None


def get_logger() -> logging.Logger:
    global _logger
    if _logger is not None:
        return _logger

    logger = logging.getLogger('telegram_mass_sender')
    level = getattr(logging, config.LOG_LEVEL.upper(), logging.INFO)
    logger.setLevel(level)

    log_path = os.path.join(config.LOGS_DIR, 'app.log')
    handler = RotatingFileHandler(
        log_path,
        maxBytes=5 * 1024 * 1024,
        backupCount=3,
        encoding='utf-8',
    )
    handler.setFormatter(logging.Formatter(config.LOG_FORMAT))
    logger.addHandler(handler)

    _logger = logger
    return logger
