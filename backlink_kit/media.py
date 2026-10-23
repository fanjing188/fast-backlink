"""媒体文件元数据：尺寸、格式、大小。只读文件头，不加载整图。"""
from __future__ import annotations
import struct
from pathlib import Path

IMAGE_MIMES = ('image/png', 'image/jpeg', 'image/webp', 'image/gif')
VIDEO_MIMES = ('video/mp4', 'video/webm')


def png_size(path):
    with Path(path).open('rb') as handle:
        head = handle.read(24)
    if head[:8] != b'\x89PNG\r\n\x1a\n' or head[12:16] != b'IHDR':
        return None
    return struct.unpack('>II', head[16:24])


def gif_size(path):
    with Path(path).open('rb') as handle:
        head = handle.read(10)
    if head[:6] not in (b'GIF87a', b'GIF89a'):
        return None
    return struct.unpack('<HH', head[6:10])


def jpeg_size(path):
    with Path(path).open('rb') as handle:
        if handle.read(2) != b'\xff\xd8':
            return None
        while True:
            marker = handle.read(2)
            if len(marker) < 2 or marker[0] != 0xFF:
                return None
            while marker[1] in (0xFF, 0xD8, 0x01) or 0xD0 <= marker[1] <= 0xD7:
                marker = b'\xff' + handle.read(1)
            length = struct.unpack('>H', handle.read(2))[0]
            if 0xC0 <= marker[1] <= 0xCF and marker[1] not in (0xC4, 0xC8, 0xCC):
                data = handle.read(5)
                if len(data) < 5:
                    return None
                height, width = struct.unpack('>HH', data[1:5])
                return width, height
            handle.seek(length - 2, 1)


def webp_size(path):
    with Path(path).open('rb') as handle:
        head = handle.read(30)
    if head[:4] != b'RIFF' or head[8:12] != b'WEBP':
        return None
    chunk = head[12:16]
    if chunk == b'VP8X':
        width = int.from_bytes(head[24:27], 'little') + 1
        height = int.from_bytes(head[27:30], 'little') + 1
        return width, height
    if chunk == b'VP8 ':
        return struct.unpack('<HH', head[26:30])
    return None


def image_size(path):
    """返回 (宽, 高)；不是支持的图片或读取失败时返回 None。"""
    try:
        for reader, magic in ((png_size, b'\x89PNG'), (gif_size, b'GIF8'), (jpeg_size, b'\xff\xd8'), (webp_size, b'RIFF')):
            with Path(path).open('rb') as handle:
                if handle.read(len(magic)) != magic:
                    continue
            size = reader(path)
            if size:
                return size
    except OSError:
        return None
    return None
