"""
Quaternius FBX -> GLB batch-konverterare.

Loopar genom alla FBX-filer i medieval-village (Buildings/Props) + medieval-castle
och exporterar matchande GLB-filer i en `glTF/`-undermapp per pack. Static props
(inga animationer behövs).

Användning (från PowerShell, dubbelklicka run_quaternius_conv.bat):
  & "C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe" `
      --background --python "C:\\Users\\emanu\\Spel\\src\\scripts\\quaternius_fbx_to_glb.py"
"""

import bpy
import os
import sys
import glob

BASE = r'C:\Users\emanu\Spel\src\assets\environment\quaternius'

# Lista över (FBX-källmapp, GLB-output-mapp).
JOBS = [
    (os.path.join(BASE, 'medieval-village', 'Buildings', 'FBX'),
     os.path.join(BASE, 'medieval-village', 'Buildings', 'glTF')),
    (os.path.join(BASE, 'medieval-village', 'Props', 'FBX'),
     os.path.join(BASE, 'medieval-village', 'Props', 'glTF')),
    (os.path.join(BASE, 'medieval-castle', 'FBX'),
     os.path.join(BASE, 'medieval-castle', 'glTF')),
]


def log(msg):
    print(f'[fbx->glb] {msg}', flush=True)


def reset_scene():
    bpy.ops.wm.read_homefile(use_empty=True)
    for col in [bpy.data.objects, bpy.data.meshes, bpy.data.materials,
                bpy.data.images, bpy.data.armatures, bpy.data.actions]:
        for item in list(col):
            try:
                col.remove(item)
            except Exception:
                pass


def convert_fbx(fbx_path, out_glb):
    reset_scene()
    try:
        bpy.ops.import_scene.fbx(filepath=fbx_path)
    except Exception as e:
        log(f'FAIL import {os.path.basename(fbx_path)}: {e}')
        return False
    try:
        bpy.ops.export_scene.gltf(
            filepath=out_glb,
            export_format='GLB',
            export_animations=False,   # static props
            export_apply=True,         # apply modifiers
            use_selection=False,
        )
        return True
    except Exception as e:
        log(f'FAIL export {os.path.basename(out_glb)}: {e}')
        return False


def main():
    total_ok = 0
    total_fail = 0
    for fbx_dir, glb_dir in JOBS:
        if not os.path.isdir(fbx_dir):
            log(f'SKIP missing {fbx_dir}')
            continue
        os.makedirs(glb_dir, exist_ok=True)
        fbx_files = sorted(glob.glob(os.path.join(fbx_dir, '*.fbx')))
        log(f'=== {fbx_dir} ({len(fbx_files)} files) ===')
        for fbx in fbx_files:
            name = os.path.splitext(os.path.basename(fbx))[0]
            out = os.path.join(glb_dir, f'{name}.glb')
            if convert_fbx(fbx, out):
                log(f'  OK: {name}.glb')
                total_ok += 1
            else:
                total_fail += 1
    log('=' * 40)
    log(f'DONE: {total_ok} OK, {total_fail} fail')


if __name__ == '__main__':
    main()
