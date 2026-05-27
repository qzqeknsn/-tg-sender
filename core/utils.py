import random
import re


def spintax(text: str) -> str:
    """
    Простой спинтакс: {привет|здравствуй|добрый день}
    """
    pattern = re.compile(r'\{([^{}]+)\}')

    while True:
        match = pattern.search(text)
        if not match:
            break
        variants = match.group(1).split('|')
        replacement = random.choice(variants).strip()
        text = text[:match.start()] + replacement + text[match.end():]
    return text
