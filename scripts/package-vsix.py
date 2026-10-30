#!/usr/bin/env python3
"""Builds a .vsix (the zip layout `vsce package` produces) from the compiled extension.

Usage: python3 scripts/package-vsix.py   (run `tsc -p ./` first)
If you have network access, `npx @vscode/vsce package` does the same job.
"""
import json
import os
import sys
import zipfile
from xml.sax.saxutils import escape

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
pkg = json.load(open(os.path.join(ROOT, 'package.json'), encoding='utf-8'))

INCLUDE = ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE.md']
if pkg.get('icon'):
    INCLUDE.append(pkg['icon'])
# Images referenced from the README (relative paths)
import re
for img in re.findall(r'!\[[^\]]*\]\((?!https?:)([^)\s]+)\)', open(os.path.join(ROOT, 'README.md'), encoding='utf-8').read()):
    if img not in INCLUDE:
        INCLUDE.append(img)
out_dir = os.path.join(ROOT, 'out')
js_files = sorted(f for f in os.listdir(out_dir) if f.endswith('.js'))
if 'extension.js' not in js_files:
    sys.exit('out/extension.js missing - run `tsc -p ./` first')
INCLUDE += [f'out/{f}' for f in js_files]

icon_meta = f"\n    <Icon>extension/{pkg['icon']}</Icon>" if pkg.get('icon') else ''
icon_asset = f"\n    <Asset Type=\"Microsoft.VisualStudio.Services.Icons.Default\" Path=\"extension/{pkg['icon']}\" Addressable=\"true\" />" if pkg.get('icon') else ''

manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{escape(pkg['name'])}" Version="{escape(pkg['version'])}" Publisher="{escape(pkg['publisher'])}" />
    <DisplayName>{escape(pkg['displayName'])}</DisplayName>
    <Description xml:space="preserve">{escape(pkg['description'])}</Description>
    <Tags>{escape(','.join(pkg.get('keywords', [])))}</Tags>
    <Categories>{escape(','.join(pkg.get('categories', [])))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{escape(pkg['engines']['vscode'])}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
    <License>extension/LICENSE.md</License>{icon_meta}
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.md" Addressable="true" />{icon_asset}
  </Assets>
</PackageManifest>
'''

content_types = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json"/><Default Extension=".vsixmanifest" ContentType="text/xml"/><Default Extension=".md" ContentType="text/markdown"/><Default Extension=".js" ContentType="application/javascript"/><Default Extension=".png" ContentType="image/png"/><Default Extension=".jpg" ContentType="image/jpeg"/></Types>
'''

target = os.path.join(ROOT, f"{pkg['name']}-{pkg['version']}.vsix")
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('extension.vsixmanifest', manifest)
    z.writestr('[Content_Types].xml', content_types)
    for rel in INCLUDE:
        z.write(os.path.join(ROOT, rel), 'extension/' + rel)
print(target)
