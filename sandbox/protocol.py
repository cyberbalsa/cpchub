"""Fixed-size numeric results shared by the application and isolated guest."""
import struct

MAGIC = b'CPCSTAT1'
FIELDS = ('kind', 'format_version', 'width', 'depth', 'height', 'footprint_tiles',
          'objects', 'object_types', 'parking_spaces', 'golf_cart_spaces',
          'entrances', 'exits', 'maps', 'entities')
PACKET = struct.Struct('<8s' + 'q' * len(FIELDS))
BOUNDS = {'format_version': (2, 3), 'width': (1, 2048), 'depth': (1, 2048), 'height': (1, 2048),
          'footprint_tiles': (1, 16 * 2048 * 2048), 'maps': (1, 16)}


def encode_stats(values):
    payload = PACKET.pack(MAGIC, *(values.get(name) if values.get(name) is not None else -1 for name in FIELDS))
    decode_stats(payload, values['kind'])
    return payload


def decode_stats(payload, expected_kind):
    if len(payload) != PACKET.size:
        raise ValueError('Invalid statistics length')
    magic, *values = PACKET.unpack(payload)
    result = dict(zip(FIELDS, (None if value == -1 else value for value in values)))
    if magic != MAGIC or result['kind'] not in (1, 2) or result['kind'] != expected_kind:
        raise ValueError('Invalid statistics type')
    for name, value in result.items():
        if value is not None:
            lower, upper = BOUNDS.get(name, (0, 1_000_000))
            if not lower <= value <= upper:
                raise ValueError('Statistics out of bounds')
    if any(result[name] is None for name in ('width', 'depth', 'height', 'footprint_tiles')):
        raise ValueError('Missing dimensions')
    if expected_kind == 1:
        if result['format_version'] is None or result['maps'] is not None or result['entities'] is not None:
            raise ValueError('Invalid blueprint statistics')
        if result['footprint_tiles'] != result['width'] * result['depth']:
            raise ValueError('Invalid blueprint footprint')
    elif result['format_version'] is not None or result['maps'] is None or result['entities'] is None:
        raise ValueError('Invalid scenario statistics')
    for name in ('object_types', 'parking_spaces', 'golf_cart_spaces', 'entrances', 'exits'):
        if result[name] is not None and (result['objects'] is None or result[name] > result['objects']):
            raise ValueError('Invalid object count')
    if expected_kind == 2 and result['objects'] is not None and result['objects'] > result['entities']:
        raise ValueError('Invalid entity count')
    result['schema_version'] = 1
    result['kind'] = 'blueprint' if expected_kind == 1 else 'scenario'
    return result
