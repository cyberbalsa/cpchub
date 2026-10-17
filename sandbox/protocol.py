"""Fixed-size numeric results shared by the application and isolated guest."""
import struct

MAX_METADATA_NODES = 10_000_000
FAILURE_MAGIC = b'CPCFAIL1'
FAILURE_PACKET = struct.Struct('<8sH')
# Stable numeric codes only cross the VM boundary. Display text comes from this
# trusted table, never from exception messages or uploaded metadata.
FAILURES = {
    1: ('invalid_file', 'This file did not pass validation. If it opens in the game, report the issue on GitHub.'),
    2: ('invalid_metadata', 'The game metadata is incomplete or uses an unsupported value.'),
    3: ('metadata_values_limit', f'The file contains more than {MAX_METADATA_NODES:,} metadata values.'),
    4: ('metadata_depth_limit', 'The metadata is nested more than 32 levels deep.'),
    5: ('metadata_size_limit', 'The game metadata exceeds the 16 MB limit.'),
    6: ('invalid_dimensions', 'The map dimensions are missing, invalid, or exceed 2,048 tiles per side.'),
    7: ('expanded_size_limit', 'The map data exceeds the validation size limit.'),
    8: ('blueprint_version', 'This blueprint format version is not supported. Versions 2 and 3 are supported.'),
    9: ('blueprint_metadata', 'The blueprint is missing required metadata, or its contents exceed its map dimensions.'),
    10: ('blueprint_length', 'The blueprint tile data is incomplete or does not match its dimensions.'),
    11: ('scenario_compression', 'The scenario compressed data is incomplete or damaged.'),
    12: ('scenario_trailer', 'The scenario size trailer is missing or does not match its contents.'),
    13: ('scenario_rooms', 'The scenario must contain between 1 and 16 maps.'),
    14: ('scenario_metadata', 'A scenario map is missing required metadata.'),
    15: ('scenario_length', 'The scenario map data is incomplete or does not match its dimensions.'),
    16: ('image_size', 'The screenshot exceeds the 10 MB limit.'),
    17: ('image_format', 'Use a PNG, JPEG or WebP screenshot.'),
    18: ('image_dimensions', 'Use a screenshot at least 320×180, at most 8,192 pixels per side and 20 megapixels, with an aspect ratio between 1:6 and 6:1.'),
    19: ('image_animation', 'Use a still screenshot. Animated images are not supported.'),
    20: ('image_unreadable', 'The screenshot could not be read. Save it as a new PNG, JPEG or WebP and retry.'),
    21: ('resource_limit', 'The file needs more memory than the isolated validator allows. Report the issue if it opens in the game.'),
    22: ('check_timeout', 'The file check exceeded its time limit. Retry the upload or report the issue if it happens again.'),
    23: ('check_unavailable', 'The file check could not finish. Upload the file again to retry.'),
}
FAILURE_CODES = {name: code for code, (name, _) in FAILURES.items()}


def encode_failure(reason):
    return FAILURE_PACKET.pack(FAILURE_MAGIC, FAILURE_CODES[reason])


def decode_failure(payload):
    if len(payload) != FAILURE_PACKET.size:
        raise ValueError('Invalid failure result length')
    magic, code = FAILURE_PACKET.unpack(payload)
    if magic != FAILURE_MAGIC or code not in FAILURES:
        raise ValueError('Invalid failure result')
    return FAILURES[code][0]


def failure_message(reason):
    return FAILURES[FAILURE_CODES[reason]][1]


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
