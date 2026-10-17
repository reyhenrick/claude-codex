#!/usr/bin/env python3
import argparse
from collections import Counter
import json
from pathlib import Path
import plistlib
import re
import sys

STRING = r'"(?:\\.|[^"\\])*"'
TOKEN = re.compile(rf'\s+|/\*.*?\*/|//[^\n]*|{STRING}|[=;]', re.S)
PLACEHOLDER = re.compile(r'\{(\d+)\}')
KEY = re.compile(r'[a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+\Z')


def decode_string(value):
    return json.loads(re.sub(r'\\U([0-9A-Fa-f]{4})', r'\\u\1', value))


def parse_strings(path):
    source = path.read_text(encoding='utf-8-sig')
    tokens = []
    position = 0
    while position < len(source):
        match = TOKEN.match(source, position)
        if not match:
            line = source.count('\n', 0, position) + 1
            raise ValueError(f'{path.name}:{line}: unsupported catalog syntax')
        token = match.group()
        if not token.isspace() and not token.startswith(('//', '/*')):
            tokens.append((token, source.count('\n', 0, position) + 1))
        position = match.end()
    if len(tokens) % 4:
        raise ValueError(f'{path.name}: incomplete key/value entry')
    table = {}
    for offset in range(0, len(tokens), 4):
        key_token, equals, value_token, semicolon = tokens[offset:offset + 4]
        if not key_token[0].startswith('"') or equals[0] != '=' or not value_token[0].startswith('"') or semicolon[0] != ';':
            raise ValueError(f'{path.name}:{key_token[1]}: expected a quoted key and value')
        key, value = decode_string(key_token[0]), decode_string(value_token[0])
        if key in table:
            raise ValueError(f'{path.name}:{key_token[1]}: duplicate key {key}')
        if not key or not value.strip():
            raise ValueError(f'{path.name}:{key_token[1]}: empty key or translation')
        table[key] = value
    return table


def placeholders(value):
    found = Counter(int(index) for index in PLACEHOLDER.findall(value))
    if re.search(r'[{}]', PLACEHOLDER.sub('', value)):
        raise ValueError('malformed placeholder')
    if found and set(found) != set(range(max(found) + 1)):
        raise ValueError('placeholder indexes must start at zero without gaps')
    return found


def first_argument(source, position):
    start, depth = position, 0
    while position < len(source):
        if source[position] == '"':
            match = re.match(STRING, source[position:])
            if not match:
                break
            position += match.end()
            continue
        character = source[position]
        if character in '([{':
            depth += 1
        elif character in ')]}':
            if depth == 0:
                return source[start:position]
            depth -= 1
        elif character == ',' and depth == 0:
            return source[start:position]
        position += 1
    return source[start:position]


def static_references(source, namespaces):
    source = re.sub(rf'({STRING})|(/\*.*?\*/|//[^\n]*)', lambda match: match.group(1) or ''.join('\n' if char == '\n' else ' ' for char in match.group()), source, flags=re.S)
    references = set()
    for match in re.finditer(STRING, source):
        try:
            value = decode_string(match.group())
        except ValueError:
            continue
        if KEY.fullmatch(value) and value.split('.', 1)[0] in namespaces:
            references.add(value)
    for call in re.finditer(r'L10n\.text\s*\(', source):
        for match in re.finditer(STRING, first_argument(source, call.end())):
            try:
                value = decode_string(match.group())
            except ValueError:
                continue
            if KEY.fullmatch(value):
                references.add(value)
    for match in re.finditer(rf'(?:fallback\s*[:=]|UpdateFailure\s*\(\s*key\s*:)\s*({STRING})', source):
        references.add(decode_string(match.group(1)))
    return references


def check(root):
    errors = []
    localization = (root / 'Sources/Localization.swift').read_text()
    declaration = re.search(r'static\s+let\s+supported\s*=\s*(\[[^\]]*\])', localization)
    if not declaration:
        raise ValueError('Sources/Localization.swift: supported languages not found')
    languages = json.loads(declaration.group(1))
    if not languages or len(languages) != len(set(languages)) or 'en' not in languages:
        raise ValueError('Supported languages must be unique and include English')
    info = plistlib.loads((root / 'Info.plist').read_bytes())
    if info.get('CFBundleLocalizations') != languages:
        errors.append('Info.plist languages differ from LocalizationCatalog.supported')
    if info.get('CFBundleDevelopmentRegion') != 'en':
        errors.append('Info.plist fallback language must be English')
    directories = {path.name.removesuffix('.lproj') for path in (root / 'Resources').glob('*.lproj') if path.is_dir()}
    if directories != set(languages):
        errors.append('Resource language directories differ from LocalizationCatalog.supported')
    tables = {}
    for language in languages:
        try:
            tables[language] = parse_strings(root / f'Resources/{language}.lproj/Localizable.strings')
        except (OSError, ValueError) as error:
            errors.append(f'{language}: {error}')
    english = tables.get('en', {})
    for language, table in tables.items():
        missing, extra = sorted(english.keys() - table.keys()), sorted(table.keys() - english.keys())
        if missing:
            errors.append(f'{language}: missing keys: {", ".join(missing)}')
        if extra:
            errors.append(f'{language}: extra keys: {", ".join(extra)}')
        for key, value in table.items():
            try:
                actual = placeholders(value)
                if key in english and actual != placeholders(english[key]):
                    errors.append(f'{language}: placeholder mismatch for {key}')
            except ValueError as error:
                errors.append(f'{language}: {key}: {error}')
    namespaces = {key.split('.', 1)[0] for key in english}
    references = set()
    for folder in ('Sources', 'Launcher'):
        for path in sorted((root / folder).rglob('*.swift')):
            used = static_references(path.read_text(), namespaces)
            references.update(used)
            missing = sorted(used - english.keys())
            if missing:
                errors.append(f'{path.relative_to(root)}: unknown localization keys: {", ".join(missing)}')
    return errors, len(languages), len(english), len(references)


def main():
    parser = argparse.ArgumentParser(description='Validate language catalog parity, placeholders and static Swift references.')
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    options = parser.parse_args()
    try:
        errors, languages, keys, references = check(options.root.resolve())
    except (OSError, ValueError, plistlib.InvalidFileException) as error:
        print(f'Localization check failed: {error}', file=sys.stderr)
        return 1
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        print(f'Localization check failed: {len(errors)} issue(s)', file=sys.stderr)
        return 1
    print(f'Localization catalogs: {languages} languages, {keys} keys each, {references} static references; no issues')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
