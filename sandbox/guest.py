"""Untrusted bytes are inspected only in the disposable guest, never on the host."""
import io
import math
import os
import resource
import struct
import warnings
import zlib

try:
    from cpchub_protocol import MAX_METADATA_NODES, encode_failure, encode_stats
except ModuleNotFoundError:  # The test suite imports this module from the source tree.
    from sandbox.protocol import MAX_METADATA_NODES, encode_failure, encode_stats

REQUEST_MAGIC = b'CPCVAL1\x00'
RESULT_MAGIC = b'CPCRES1\x00'
MAX_METADATA = 16 * 1024 * 1024
MAX_EXPANDED = 512 * 1024 * 1024
MAX_IMAGE = 10 * 1024 * 1024
MAX_RESULT = 8 * 1024 * 1024


class InvalidFile(ValueError):
    pass


class CBOR:
    """Bounded subset used by the game's metadata; no hooks or object construction."""
    def __init__(self, data):
        self.data, self.pos, self.nodes = data, 0, 0

    def take(self, n):
        if n < 0 or self.pos + n > len(self.data):
            raise InvalidFile('invalid_metadata')
        value = self.data[self.pos:self.pos + n]
        self.pos += n
        return value

    def value(self, depth=0):
        self.nodes += 1
        if depth > 32:
            raise InvalidFile('metadata_depth_limit')
        if self.nodes > MAX_METADATA_NODES:
            raise InvalidFile('metadata_values_limit')
        byte = self.take(1)[0]
        major, extra = byte >> 5, byte & 31
        if major == 7:
            if extra in (20, 21, 22):
                return {20: False, 21: True, 22: None}[extra]
            if extra in (25, 26, 27):
                value = struct.unpack({25: '>e', 26: '>f', 27: '>d'}[extra], self.take({25: 2, 26: 4, 27: 8}[extra]))[0]
                if not math.isfinite(value):
                    raise InvalidFile('invalid_metadata')
                return value
            raise InvalidFile('invalid_metadata')
        if extra < 24:
            n = extra
        elif extra in (24, 25, 26, 27):
            n = int.from_bytes(self.take({24: 1, 25: 2, 26: 4, 27: 8}[extra]), 'big')
        else:
            raise InvalidFile('invalid_metadata')
        if major == 0:
            return n
        if major == 1:
            return -1 - n
        if major == 2:
            return self.take(n)
        if major == 3:
            return self.take(n).decode('utf-8')
        if major not in (4, 5) or n > len(self.data) - self.pos:
            raise InvalidFile('invalid_metadata')
        if n * (2 if major == 5 else 1) > MAX_METADATA_NODES - self.nodes:
            raise InvalidFile('metadata_values_limit')
        if major == 4:
            return [self.value(depth + 1) for _ in range(n)]
        result = {}
        for _ in range(n):
            key = self.value(depth + 1)
            if not isinstance(key, (str, int)) or key in result:
                raise InvalidFile('invalid_metadata')
            result[key] = self.value(depth + 1)
        return result


def metadata(data):
    parser = CBOR(data)
    result = parser.value()
    if parser.pos != len(data) or not isinstance(result, dict):
        raise InvalidFile('invalid_metadata')
    return result


def dimensions(value):
    if not isinstance(value, list) or len(value) != 3 or any(type(n) is not int or not 1 <= n <= 2048 for n in value):
        raise InvalidFile('invalid_dimensions')
    if math.prod(value) > 128 * 1024 * 1024:
        raise InvalidFile('expanded_size_limit')
    return value


def validate_blueprint(source, length):
    header = source.read(8)
    if len(header) != 8:
        raise InvalidFile('blueprint_length')
    version, size = struct.unpack('<II', header)
    if version not in (2, 3):
        raise InvalidFile('blueprint_version')
    if size > MAX_METADATA:
        raise InvalidFile('metadata_size_limit')
    if size < 1 or size > length - 8:
        raise InvalidFile('invalid_metadata')
    obj = metadata(source.read(size))
    if not isinstance(obj.get('name'), str) or not isinstance(obj.get('placedTemplates'), dict):
        raise InvalidFile('blueprint_metadata')
    actual = dimensions(obj.get('size'))
    x, y, z = dimensions(obj.get('tileMapSize'))
    if any(a > b for a, b in zip(actual, [x, y, z])):
        raise InvalidFile('blueprint_metadata')
    if length != 8 + size + 2 + 3 * x * y * z + x * z:
        raise InvalidFile('blueprint_length')
    counts = obj['placedTemplates']
    if all(isinstance(name, str) and isinstance(placements, list) for name, placements in counts.items()):
        counts = {name: len(placements) for name, placements in counts.items() if placements}
    else:
        counts = None
    return {'kind': 1, 'format_version': version, 'width': actual[0], 'height': actual[1],
            'depth': actual[2], 'footprint_tiles': actual[0] * actual[2], **object_stats(counts)}


def object_stats(counts):
    names = {'parking_spaces': 'ParkingBay', 'golf_cart_spaces': 'GolfCartBay',
             'entrances': 'ParkingEntrance', 'exits': 'ParkingExit'}
    return {'objects': sum(counts.values()) if counts is not None else None,
            'object_types': len(counts) if counts is not None else None,
            **{key: counts.get(name, 0) if counts is not None else None for key, name in names.items()}}


class Inflater:
    def __init__(self, source, length):
        self.source, self.remaining = source, length
        self.decoder = zlib.decompressobj()
        self.pending = b''
        self.total = 0
        self.finished = False

    def read(self, n):
        result = bytearray()
        while len(result) < n and not self.decoder.eof:
            if not self.pending:
                self.pending = self.source.read(min(65536, self.remaining))
                self.remaining -= len(self.pending)
                if not self.pending:
                    raise InvalidFile('scenario_compression')
            chunk = self.decoder.decompress(self.pending, min(n - len(result), 1024 * 1024))
            self.pending = self.decoder.unconsumed_tail
            self.total += len(chunk)
            if self.total > MAX_EXPANDED:
                raise InvalidFile('expanded_size_limit')
            result.extend(chunk)
        if self.decoder.eof and not self.finished:
            # Native scenarios append the uncompressed size as a little-endian u32.
            trailer = self.decoder.unused_data
            if len(trailer) + self.remaining != 4:
                raise InvalidFile('scenario_trailer')
            trailer += self.source.read(self.remaining)
            self.remaining = 0
            if len(trailer) != 4 or int.from_bytes(trailer, 'little') != self.total:
                raise InvalidFile('scenario_trailer')
            self.finished = True
        return bytes(result)


def validate_scenario(source, length):
    decoded = Inflater(source, length)
    header = decoded.read(8)
    if len(header) != 8:
        raise InvalidFile('scenario_length')
    size = int.from_bytes(header, 'little')
    if size > MAX_METADATA:
        raise InvalidFile('metadata_size_limit')
    if size < 1:
        raise InvalidFile('invalid_metadata')
    obj = metadata(decoded.read(size))
    rooms = obj.get('rooms')
    if not isinstance(rooms, list) or not 1 <= len(rooms) <= 16:
        raise InvalidFile('scenario_rooms')
    expected = 0
    widths, heights, depths, area, entities = [], [], [], 0, 0
    counts = {}
    for room in rooms:
        if not isinstance(room, dict) or not isinstance(room.get('entities'), (list, dict)) or not isinstance(room.get('scenario'), (dict, list)):
            raise InvalidFile('scenario_metadata')
        x, y, z = dimensions(room.get('tileMapSize'))
        expected += 10 + 3 * x * y * z + 2 * x * z
        widths.append(x)
        heights.append(y)
        depths.append(z)
        area += x * z
        entities += len(room['entities'])
        records = room['entities'].values() if isinstance(room['entities'], dict) else room['entities']
        for entity in records:
            if counts is None:
                break
            if not isinstance(entity, dict) or not isinstance(entity.get('components', {}), dict):
                counts = None
            elif 'Placed' in entity.get('components', {}):
                name = entity.get('template')
                if not isinstance(name, str):
                    counts = None
                else:
                    counts[name] = counts.get(name, 0) + 1
    if size + 8 + expected > MAX_EXPANDED:
        raise InvalidFile('expanded_size_limit')
    while decoded.read(1024 * 1024):
        pass
    if decoded.total != size + 8 + expected:
        raise InvalidFile('scenario_length')
    return {'kind': 2, 'width': max(widths), 'height': max(heights), 'depth': max(depths),
            'footprint_tiles': area, 'maps': len(rooms), 'entities': entities, **object_stats(counts)}


def clean_image(source, length):
    from PIL import Image, ImageOps
    if not 0 < length <= MAX_IMAGE:
        raise InvalidFile('image_size')
    data = source.read(length)
    with warnings.catch_warnings():
        warnings.simplefilter('error', Image.DecompressionBombWarning)
        with Image.open(io.BytesIO(data)) as check:
            if check.format not in {'PNG', 'JPEG', 'WEBP'}:
                raise InvalidFile('image_format')
            if getattr(check, 'is_animated', False):
                raise InvalidFile('image_animation')
            if (check.width * check.height > 20_000_000
                    or not 320 <= check.width <= 8192 or not 180 <= check.height <= 8192
                    or not 1 / 6 <= check.width / check.height <= 6):
                raise InvalidFile('image_dimensions')
            check.verify()
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            image = ImageOps.exif_transpose(image).convert('RGB')
            image.thumbnail((1920, 1080))
            result = io.BytesIO()
            image.save(result, 'WEBP', quality=88)
    if result.tell() > MAX_RESULT:
        raise InvalidFile('image_size')
    return result.getvalue()


def evaluate(kind, source, length):
    if kind == 1:
        return encode_stats(validate_blueprint(source, length))
    elif kind == 2:
        return encode_stats(validate_scenario(source, length))
    elif kind == 3:
        return clean_image(source, length)
    else:
        raise InvalidFile('invalid_file')
    return b''


def main():
    with open('/dev/vdb', 'rb', buffering=0) as source, open('/dev/vdc', 'wb', buffering=0) as output:
        # The parser gets only two open device handles and no privileges.
        os.setgroups([])
        os.setgid(65534)
        os.setuid(65534)
        resource.setrlimit(resource.RLIMIT_CPU, (12, 12))
        resource.setrlimit(resource.RLIMIT_NOFILE, (16, 16))
        resource.setrlimit(resource.RLIMIT_AS, (320 * 1024 * 1024, 320 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        status, result, kind = 1, b'', 0
        try:
            header = source.read(17)
            if header[:8] != REQUEST_MAGIC or len(header) != 17:
                raise InvalidFile('invalid_file')
            kind, length = header[8], int.from_bytes(header[9:], 'big')
            if not 0 < length <= 100 * 1024 * 1024:
                raise InvalidFile('invalid_file')
            result = evaluate(kind, source, length)
            status = 0
        except InvalidFile as exc:
            result = encode_failure(str(exc))
        except MemoryError:
            result = encode_failure('resource_limit')
        except zlib.error:
            result = encode_failure('scenario_compression')
        except UnicodeError:
            result = encode_failure('invalid_metadata')
        except Exception:
            # Exceptions and uploaded text never cross the VM boundary.
            result = encode_failure('image_unreadable' if kind == 3 else 'invalid_file')
        # Publish the ready marker last, after all result bytes reach the block device.
        output.seek(13)
        output.write(result)
        os.fsync(output.fileno())
        output.seek(0)
        output.write(RESULT_MAGIC + bytes([status]) + len(result).to_bytes(4, 'big'))
        os.fsync(output.fileno())


if __name__ == '__main__':
    main()
