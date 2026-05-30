import struct

def what(file, h=None):
    if h is None:
        if isinstance(file, str):
            with open(file, 'rb') as f:
                h = f.read(32)
        else:
            h = file.read(32)
    if not h:
        return None
    if h.startswith(b'\xff\xd8'):
        return 'jpeg'
    if h.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'png'
    if h.startswith(b'GIF87a') or h.startswith(b'GIF89a'):
        return 'gif'
    if h.startswith(b'RIFF') and h[8:12] == b'WEBP':
        return 'webp'
    if struct.unpack('<H', h[0:2])[0] == 0x4d42:
        return 'bmp'
    return None
